// supabase/functions/create_checkout_session/index.ts
//
// Called from FlutterFlow (API Connector) with the user's Supabase Auth
// access token in the Authorization header. Resolves the caller's
// public.users row via auth_user_id, creates (or reuses) a Stripe Customer,
// opens a Checkout Session in subscription mode, and returns the URL.
//
// IMPORTANT: every id written into Stripe metadata is the public.users id,
// NOT the auth.users id — user_subscriptions.user_id has an FK to public.users.
//
// Hosted deploy:
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@16.12.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
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
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    // Client bound to the caller's JWT — used ONLY to identify the user.
    // Must use the anon key here, not the service role key.
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

    // Service-role client — bypasses RLS.
    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Translate auth.users.id -> public.users.id. Everything downstream
    // (Stripe metadata, user_subscriptions.user_id) uses the public id.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (!profile) {
      console.error(
        "No public.users row for auth_user_id:",
        authUser.id,
        authUser.email,
      );
      return json({ error: "No user profile found" }, 404);
    }

    const publicUserId = profile.id as string;
    const email = (profile.email as string | null) ?? authUser.email ?? undefined;

    // Reuse an existing Stripe customer for this user if we have one.
    const { data: existingRow, error: existingError } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", publicUserId)
      .not("stripe_customer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;

    let customerId: string | undefined =
      existingRow?.stripe_customer_id ?? undefined;

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
    });

    return json({ url: session.url }, 200);
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