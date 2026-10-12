// supabase/functions/connect_onboard/index.ts
//
// POST { "return_url": "...", "refresh_url": "..." }
// Returns { url, account_id } — open `url` in a browser.
//
// Deploy: supabase functions deploy connect_onboard

import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

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
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user: authUser }, error: userError } =
      await supabaseClient.auth.getUser();
    if (userError || !authUser) {
      return json({ error: "Invalid or expired session" }, 401);
    }

    const { return_url, refresh_url } = await req.json();
    if (!return_url || !refresh_url) {
      return json({ error: "return_url and refresh_url are required" }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // auth.users.id -> public.users.id
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("users")
      .select("id, name, email")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return json({ error: "No user profile found" }, 404);

    const { data: provider, error: providerError } = await supabaseAdmin
      .from("provider")
      .select("id, stripe_account_id")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (providerError) throw providerError;
    if (!provider) return json({ error: "No provider profile found" }, 404);

    let accountId = provider.stripe_account_id as string | null;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "AU",
        email: profile.email ?? undefined,
        business_type: "individual",
        // Transfers only — the platform takes the card payment itself.
        capabilities: {
          transfers: { requested: true },
        },
        business_profile: {
          mcc: "7299",
          product_description: "Bookable sessions via the platform",
        },
        settings: {
          payouts: {
            schedule: { interval: "weekly", weekly_anchor: "monday" },
          },
        },
        metadata: { supabase_user_id: profile.id },
      });

      accountId = account.id;

      const { error: updateError } = await supabaseAdmin
        .from("provider")
        .update({ stripe_account_id: accountId })
        .eq("id", provider.id);
      if (updateError) throw updateError;
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url,
      return_url,
      type: "account_onboarding",
      collection_options: { fields: "currently_due" },
    });

    return json({ url: link.url, account_id: accountId }, 200);
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