import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";


const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Pulls the subscription id from an invoice or checkout session across API versions. */
// deno-lint-ignore no-explicit-any
function extractSubscriptionId(obj: any): string | null {
  const raw =
    obj?.subscription ??
    obj?.parent?.subscription_details?.subscription ??
    null;

  if (!raw) return null;
  return typeof raw === "string" ? raw : (raw.id ?? null);
}

/** Pulls supabase_user_id from wherever this API version put it. */
// deno-lint-ignore no-explicit-any
function extractUserId(subscription: any, session?: any): string | null {
  return (
    subscription?.metadata?.supabase_user_id ??
    session?.metadata?.supabase_user_id ??
    session?.client_reference_id ??
    subscription?.parent?.subscription_details?.metadata?.supabase_user_id ??
    null
  );
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  console.log("Received event:", event.type, event.id);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // deno-lint-ignore no-explicit-any
        const session = event.data.object as any;
        const subId = extractSubscriptionId(session);

        console.log("checkout.session.completed", {
          mode: session.mode,
          subId,
        });

        if (session.mode === "subscription" && subId) {
          const subscription = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(subscription, session);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }

      case "invoice.payment_failed":
      case "invoice.payment_succeeded": {
        // deno-lint-ignore no-explicit-any
        const invoice = event.data.object as any;
        const subId = extractSubscriptionId(invoice);

        console.log(event.type, { invoiceId: invoice.id, subId });

        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(subscription);
        }
        break;
      }

      default:
        break; // unhandled types are fine to ignore
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Non-2xx makes Stripe retry with backoff — that's what we want on failure.
    console.error("Error handling webhook event:", event.type, err);
    return new Response("Webhook handler error", { status: 500 });
  }
});

/**
 * Writes the current Stripe subscription state into user_subscriptions,
 * then recomputes the user's is_subscribed flag on public.users.
 */
async function syncSubscription(
  subscription: Stripe.Subscription,
  // deno-lint-ignore no-explicit-any
  session?: any,
) {
  const userId = extractUserId(subscription, session);

  if (!userId) {
    // A missing user id won't fix itself on retry, so accept the event
    // and log loudly instead of throwing.
    console.error(
      "No supabase_user_id on subscription, cannot map to a user:",
      subscription.id,
      "metadata:",
      JSON.stringify(subscription.metadata ?? {}),
    );
    return;
  }

  const stripePriceId = subscription.items.data[0]?.price?.id ?? null;

  // Map the Stripe price back to a row in your plan catalog.
  let planId: string | null = null;
  if (stripePriceId) {
    const { data: plan, error: planError } = await supabaseAdmin
      .from("subscription")
      .select("id")
      .eq("stripe_price_id", stripePriceId)
      .maybeSingle();

    if (planError) throw planError;
    planId = plan?.id ?? null;

    if (!planId) {
      console.warn(
        `No subscription plan row for stripe_price_id ${stripePriceId} — ` +
          `add it so user_subscriptions.subscription_id can be set.`,
      );
    }
  }

  // Period timestamps also moved in newer API versions — check both places.
  // deno-lint-ignore no-explicit-any
  const sub = subscription as any;
  const item = subscription.items.data[0];
  
  // deno-lint-ignore no-explicit-any
  const periodStart = sub.current_period_start ?? (item as any)?.current_period_start ?? null;
  // deno-lint-ignore no-explicit-any
  const periodEnd = sub.current_period_end ?? (item as any)?.current_period_end ?? null;
  
  console.log("Upserting subscription:", {
    userId,
    subId: subscription.id,
    status: subscription.status,
    stripePriceId,
    planId,
    periodStart,
    periodEnd,
  });

  const { error: upsertError } = await supabaseAdmin
    .from("user_subscriptions")
    .upsert(
      {
        user_id: userId,
        subscription_id: planId,
        stripe_customer_id: subscription.customer as string,
        stripe_subscription_id: subscription.id,
        stripe_price_id: stripePriceId,
        status: subscription.status,
        current_period_start: periodStart
          ? new Date(periodStart * 1000).toISOString()
          : null,
        current_period_end: periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : null,
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" },
    );

  // Throw so the handler returns 500 and Stripe retries.
  if (upsertError) throw upsertError;

  const { error: syncError } = await supabaseAdmin.rpc(
    "sync_user_subscription_flags",
    { p_user_id: userId },
  );

  if (syncError) throw syncError;

  console.log("Synced subscription for user:", userId);
}