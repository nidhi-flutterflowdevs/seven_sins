// supabase/functions/cancel_subscription/index.ts
//
// Cancels the caller's subscription at the end of the current billing
// period. No further charges are made. The user keeps access until
// current_period_end, since they already paid for it.
//
// Deploy:  supabase functions deploy cancel_subscription

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

    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Translate auth.users.id -> public.users.id.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) {
      console.error("No public.users row for auth_user_id:", authUser.id);
      return json({ error: "No user profile found" }, 404);
    }

    const publicUserId = profile.id as string;

    // Find their live subscription.
    const { data: rows, error: rowsError } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_subscription_id, status")
      .eq("user_id", publicUserId)
      .in("status", LIVE_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1);

    if (rowsError) throw rowsError;

    const row = rows?.[0];
    if (!row) {
      return json({ error: "No active subscription found" }, 404);
    }

    // Our row can be stale — confirm against Stripe.
    let current: Stripe.Subscription;
    try {
      current = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    } catch (err) {
      console.error(
        "Subscription not found in Stripe:",
        row.stripe_subscription_id,
        err,
      );
      await supabaseAdmin
        .from("user_subscriptions")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", row.stripe_subscription_id);
      await supabaseAdmin.rpc("sync_user_subscription_flags", {
        p_user_id: publicUserId,
      });
      return json({ error: "No active subscription found" }, 404);
    }

    if (!LIVE_STATUSES.includes(current.status)) {
      // Our row was stale — correct it so the user isn't stuck.
      await supabaseAdmin
        .from("user_subscriptions")
        .update({
          status: current.status,
          cancel_at_period_end: current.cancel_at_period_end ?? false,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", current.id);

      await supabaseAdmin.rpc("sync_user_subscription_flags", {
        p_user_id: publicUserId,
      });

      console.warn("Stale row corrected", {
        subId: current.id,
        dbStatus: row.status,
        stripeStatus: current.status,
      });

      return json(
        { error: "No active subscription found", stripe_status: current.status },
        404,
      );
    }

    if (current.cancel_at_period_end) {
      return json({ error: "Subscription is already scheduled to cancel" }, 409);
    }

    // Stop future billing. The subscription stays active until the
    // period ends, then Stripe closes it — no further charges.
    const result = await stripe.subscriptions.update(current.id, {
      cancel_at_period_end: true,
    });

    // deno-lint-ignore no-explicit-any
    const sub = result as any;
    // deno-lint-ignore no-explicit-any
    const item = result.items?.data?.[0] as any;
    const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;

    console.log("Scheduled cancellation at period end", {
      publicUserId,
      subId: result.id,
      accessUntil: periodEnd,
    });

    // Write it now so the UI updates immediately; the resulting
    // customer.subscription.updated webhook will sync it again.
    await supabaseAdmin
      .from("user_subscriptions")
      .update({
        status: result.status,
        cancel_at_period_end: true,
        current_period_end: periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", result.id);

    const { error: syncError } = await supabaseAdmin.rpc(
      "sync_user_subscription_flags",
      { p_user_id: publicUserId },
    );
    if (syncError) throw syncError;

    return json(
      {
        subscription_id: result.id,
        status: result.status,
        cancel_at_period_end: true,
        access_until: periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : null,
      },
      200,
    );
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