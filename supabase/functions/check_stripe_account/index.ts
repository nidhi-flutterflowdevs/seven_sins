// supabase/functions/check_stripe_account/index.ts
//
// Two auth modes:
//   1. Authorization: Bearer <user JWT>  — from the app. Full response.
//   2. { "user_id": "<public.users.id>" } — from the Stripe return page,
//      which has no Supabase session. Minimal response.
//
// The Supabase client always sends an Authorization header, using the
// anon key when there is no session. That resolves to no user, which is
// NOT an error — it simply falls through to the user_id path.
//
// Deploy: supabase functions deploy check_stripe_account --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STRIPE_VERSION = "2026-02-25.clover";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { success: false, message: "Only POST requests are allowed." },
      405,
    );
  }

  try {
    // --------------------------------------------------
    // 1. Config
    // --------------------------------------------------
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return jsonResponse(
        { success: false, message: "Supabase configuration is missing." },
        500,
      );
    }

    if (!stripeSecretKey) {
      return jsonResponse(
        { success: false, message: "STRIPE_SECRET_KEY is not configured." },
        500,
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // --------------------------------------------------
    // 2. Body
    // --------------------------------------------------
    let body: Record<string, any> = {};
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }

    const bodyUserId = body?.user_id?.toString().trim() || null;

    // --------------------------------------------------
    // 3. Resolve the user — JWT if it resolves, else user_id
    // --------------------------------------------------
    let resolvedUserId: string | null = null;
    let isAuthenticated = false;

    const authHeader = req.headers.get("Authorization");
    const accessToken = authHeader?.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "").trim()
      : null;

    if (accessToken) {
      const supabase = createClient(supabaseUrl, supabaseAnonKey);

      const {
        data: { user: authUser },
      } = await supabase.auth.getUser(accessToken);

      // An anon key also arrives as a Bearer token but resolves to no
      // user. Not an error — fall through to user_id below.
      if (authUser) {
        const { data: userRow, error: userRowError } = await supabaseAdmin
          .from("users")
          .select("id")
          .eq("auth_user_id", authUser.id)
          .maybeSingle();

        if (userRowError) throw userRowError;

        if (userRow) {
          resolvedUserId = userRow.id;
          isAuthenticated = true;
        } else {
          console.warn(
            "Authenticated auth user has no public.users row:",
            authUser.id,
          );
        }
      }
    }

    if (!resolvedUserId && bodyUserId) {
      resolvedUserId = bodyUserId;
      isAuthenticated = false;
    }

    if (!resolvedUserId) {
      return jsonResponse(
        { success: false, message: "Provide a valid session or a user_id." },
        401,
      );
    }

    console.log("Resolved user:", resolvedUserId, "authenticated:", isAuthenticated);

    // --------------------------------------------------
    // 4. users.id -> provider
    // --------------------------------------------------
    const { data: providerRow, error: providerRowError } = await supabaseAdmin
      .from("provider")
      .select("id, user_id, stripe_account_id")
      .eq("user_id", resolvedUserId)
      .maybeSingle();

    if (providerRowError) {
      console.error("Provider lookup failed:", providerRowError);
      return jsonResponse(
        {
          success: false,
          message: "Unable to retrieve the provider profile.",
          error: providerRowError.message,
        },
        500,
      );
    }

    if (!providerRow) {
      return jsonResponse(
        { success: false, message: "Provider profile was not found." },
        404,
      );
    }

    const stripeAccountId = providerRow.stripe_account_id;

    if (!stripeAccountId || typeof stripeAccountId !== "string") {
      return jsonResponse({
        success: true,
        registered: false,
        onboarding_completed: false,
        message: "Stripe account has not been created for this provider.",
      });
    }

    // --------------------------------------------------
    // 5. Live read from Accounts v2
    //
    // v2 returns null for requirements, configuration and
    // identity unless they are named in include[].
    // --------------------------------------------------
    const includeFields = [
      "requirements",
      "configuration.recipient",
      "identity",
    ];

    const stripeUrl =
      `https://api.stripe.com/v2/core/accounts/${encodeURIComponent(
        stripeAccountId,
      )}?` +
      includeFields
        .map((field, i) => `include[${i}]=${encodeURIComponent(field)}`)
        .join("&");

    console.log("Retrieving Stripe account:", stripeAccountId);

    const stripeResponse = await fetch(stripeUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/json",
        "Stripe-Version": STRIPE_VERSION,
      },
    });

    const stripeData = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe error:", JSON.stringify(stripeData));
      return jsonResponse(
        {
          success: false,
          message:
            stripeData?.error?.message ??
            stripeData?.message ??
            "Unable to retrieve Stripe account.",
          ...(isAuthenticated
            ? { stripe_account_id: stripeAccountId, stripe_error: stripeData }
            : {}),
        },
        stripeResponse.status,
      );
    }

    // --------------------------------------------------
    // 6. Extract state
    // --------------------------------------------------
    const stripeAccount = stripeData?.account ?? stripeData;

    const requirements =
      stripeAccount?.requirements ?? stripeData?.requirements ?? {};

    const recipientConfig =
      stripeAccount?.configuration?.recipient ??
      stripeData?.configuration?.recipient ??
      {};

    const asArray = (v: unknown) => (Array.isArray(v) ? v : []);

    const currentlyDue = asArray(requirements?.currently_due);
    const eventuallyDue = asArray(requirements?.eventually_due);
    const pastDue = asArray(requirements?.past_due);
    const pendingVerification = asArray(requirements?.pending_verification);

    const capabilities = recipientConfig?.capabilities ?? {};

    // Recipient capabilities — card_payments never activates
    // on a recipient-only account.
    const transfersStatus =
      capabilities?.stripe_balance?.stripe_transfers?.status ?? null;
    const payoutsStatus =
      capabilities?.stripe_balance?.payouts?.status ?? null;

    const requirementsComplete =
      currentlyDue.length === 0 &&
      pastDue.length === 0 &&
      pendingVerification.length === 0;

    const capabilitiesActive =
      transfersStatus === "active" || payoutsStatus === "active";

    const onboardingCompleted = requirementsComplete && capabilitiesActive;

    console.log("Account state:", {
      stripeAccountId,
      transfersStatus,
      payoutsStatus,
      requirementsComplete,
      onboardingCompleted,
    });

    // --------------------------------------------------
    // 7. Cache on provider
    // --------------------------------------------------
    const { error: cacheError } = await supabaseAdmin
      .from("provider")
      .update({
        stripe_onboarding_completed: onboardingCompleted,
        stripe_transfers_enabled: transfersStatus === "active",
        stripe_payouts_enabled: payoutsStatus === "active",
        stripe_requirements: requirements,
        stripe_account_status: onboardingCompleted
          ? "active"
          : requirementsComplete
          ? "pending_verification"
          : "incomplete",
      })
      .eq("id", providerRow.id);

    if (cacheError) {
      // Not fatal — the live Stripe answer is still correct.
      console.error("Could not cache Stripe state:", cacheError);
    }

    // --------------------------------------------------
    // 8. Response — trimmed when unauthenticated
    // --------------------------------------------------
    const baseResponse = {
      success: true,
      registered: true,
      user_id: resolvedUserId,
      onboarding_completed: onboardingCompleted,
      requirements_complete: requirementsComplete,
      capabilities_active: capabilitiesActive,
      currently_due_count: currentlyDue.length,
    };

    if (!isAuthenticated) {
      return jsonResponse(baseResponse);
    }

    return jsonResponse({
      ...baseResponse,
      provider_id: providerRow.id,
      stripe_account_id: stripeAccountId,
      transfers_status: transfersStatus,
      payouts_status: payoutsStatus,
      currently_due: currentlyDue,
      eventually_due: eventuallyDue,
      past_due: pastDue,
      pending_verification: pendingVerification,
      requirements,
      recipient_configuration: recipientConfig,
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    return jsonResponse(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unexpected server error.",
      },
      500,
    );
  }
});