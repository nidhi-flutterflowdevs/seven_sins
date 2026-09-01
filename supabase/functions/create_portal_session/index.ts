// supabase/functions/create-portal-session/index.ts
//
// Lets an already-subscribed user manage or cancel their subscription
// via Stripe's hosted Customer Portal. Call this from a "Manage
// Subscription" button in FlutterFlow, then open the returned url.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

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
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseClient = createClient(
       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) return json({ error: "Invalid or expired session" }, 401);

    const { return_url } = await req.json();
    if (!return_url) return json({ error: "return_url is required" }, 400);

    const supabaseAdmin = createClient(
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: row, error } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !row?.stripe_customer_id) {
      return json({ error: "No Stripe customer found for this user" }, 404);
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url,
    });

    return json({ url: portalSession.url }, 200);
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