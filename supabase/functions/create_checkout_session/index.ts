// supabase/functions/create_checkout_session/index.ts
//
// If the user already has a live subscription, it is CANCELED immediately
// (with proration credited to their Stripe balance) and a fresh Checkout
// Session is opened for the new plan.
//
// Every id written into Stripe metadata is the public.users id, NOT the
// auth.users id — user_subscriptions.user_id has an FK to public.users.
//
// Deploy:  supabase functions deploy create_checkout_session

import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const LIVE_STATUSES = ["active", "trialing", "past_due"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user: authUser },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !authUser) {
      return json({ error: "Invalid or expired session" }, 401);
    }

    const { price_id, success_url, cancel_url } = await req.json();
    if (!price_id || !success_url || !cancel_url) {
      return json(
        { error: "price_id, success_url and cancel_url are required" },
        400,
      );
    }

    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Translate auth.users.id -> public.users.id.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (!profile) {
      console.error("No public.users row for auth_user_id:", authUser.id);
      return json({ error: "No user profile found" }, 404);
    }

    const publicUserId = profile.id as string;
    const email = (profile.email as string | null) ?? authUser.email ?? undefined;

    // ---------- Cancel any live subscription ----------

    const { data: rows, error: rowsError } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_subscription_id, stripe_customer_id, stripe_price_id, status")
      .eq("user_id", publicUserId)
      .order("created_at", { ascending: false });

    if (rowsError) throw rowsError;

    let customerId: string | undefined = rows?.find(
      (r) => r.stripe_customer_id,
    )?.stripe_customer_id ?? undefined;

    const canceled: string[] = [];

    for (const row of rows ?? []) {
      if (!LIVE_STATUSES.includes(row.status)) continue;

      // Our row may be stale — confirm against Stripe before canceling.
      let current: Stripe.Subscription;
      try {
        current = await stripe.subscriptions.retrieve(
          row.stripe_subscription_id,
        );
      } catch (err) {
        console.warn(
          "Could not retrieve subscription, skipping:",
          row.stripe_subscription_id,
          err,
        );
        continue;
      }

      if (!LIVE_STATUSES.includes(current.status)) continue;

      if (current.items.data[0]?.price?.id === price_id) {
        return json({ error: "Already subscribed to this plan" }, 409);
      }

      // Immediate cancel. Unused time is credited to the customer's
      // Stripe balance and applied to their next invoice.
      await stripe.subscriptions.cancel(current.id, { prorate: true });
      canceled.push(current.id);

      console.log("Canceled previous subscription", {
        publicUserId,
        subId: current.id,
        oldPrice: current.items.data[0]?.price?.id,
        newPrice: price_id,
      });
    }

    // ---------- Fresh checkout for the new plan ----------

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: publicUserId },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url,
      cancel_url,
      client_reference_id: publicUserId,
      metadata: { supabase_user_id: publicUserId },
      subscription_data: {
        metadata: { supabase_user_id: publicUserId },
      },
    });

    console.log("Checkout session created", {
      publicUserId,
      customerId,
      sessionId: session.id,
      canceled,
    });

    return json({ url: session.url, canceled_subscriptions: canceled }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}