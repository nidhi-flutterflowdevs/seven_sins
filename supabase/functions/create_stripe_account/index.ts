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

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(
        { success: false, message: "Authorization header is required." },
        401,
      );
    }

    const accessToken = authHeader.replace("Bearer ", "").trim();
    if (!accessToken) {
      return jsonResponse(
        { success: false, message: "Access token is missing." },
        401,
      );
    }

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

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ---- 1. JWT -> auth.users.id ----
    const {
      data: { user: authUser },
      error: authError,
    } = await supabase.auth.getUser(accessToken);

    if (authError || !authUser) {
      console.error("Supabase authentication error:", authError);
      return jsonResponse(
        {
          success: false,
          message: "Your session is invalid or has expired. Please login again.",
        },
        401,
      );
    }

    let body: Record<string, any> = {};
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }

    const { email, country, business_name, display_name } = body;

    // ---- 2. auth.users.id -> public.users ----
    const { data: userRow, error: userRowError } = await supabaseAdmin
      .from("users")
      .select("id, name, email")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (userRowError) {
      console.error("User lookup failed:", userRowError);
      return jsonResponse(
        {
          success: false,
          message: "Unable to retrieve your account.",
          error: userRowError.message,
        },
        500,
      );
    }

    if (!userRow) {
      return jsonResponse(
        { success: false, message: "User record was not found." },
        404,
      );
    }

    // ---- 3. users.id -> provider (Stripe columns live here) ----
    const { data: providerRow, error: providerRowError } = await supabaseAdmin
      .from("provider")
      .select("id, user_id, stripe_account_id")
      .eq("user_id", userRow.id)
      .maybeSingle();

    if (providerRowError) {
      console.error("Provider lookup failed:", providerRowError);
      return jsonResponse(
        {
          success: false,
          message: "Unable to retrieve your provider profile.",
          error: providerRowError.message,
        },
        500,
      );
    }

    if (!providerRow) {
      return jsonResponse(
        {
          success: false,
          message: "Provider profile not found. Complete onboarding first.",
        },
        404,
      );
    }

    const providerEmail = (email ?? userRow.email ?? authUser.email ?? "")
      .toString()
      .trim();

    if (!providerEmail) {
      return jsonResponse(
        { success: false, message: "Provider email is required." },
        400,
      );
    }

    const providerCountry = (country ?? "AU").toString().trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(providerCountry)) {
      return jsonResponse(
        {
          success: false,
          message: "Invalid country code. Provide a 2-letter ISO code such as AU.",
        },
        400,
      );
    }

    let stripeAccountId =
      providerRow.stripe_account_id?.toString().trim() || null;
    let accountWasCreated = false;

    if (!stripeAccountId) {
      console.log("Creating Accounts v2 account for user:", userRow.id);

      const accountPayload: Record<string, any> = {
        contact_email: providerEmail,
        dashboard: "express",

        identity: {
          country: providerCountry,
          entity_type: "individual",
          ...(business_name
            ? {
                business_details: {
                  registered_name: business_name.toString().trim(),
                },
              }
            : {}),
        },

        // Recipient, not merchant: the platform charges the customer,
        // this account only receives transfers and pays out.
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: { requested: true },
              },
            },
          },
        },

        defaults: {
          currency: "aud",
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
          locales: ["en-AU"],
        },

        include: ["configuration.recipient", "identity", "requirements"],

        // The app's user id, so the webhook can map back without a join.
        metadata: { supabase_user_id: userRow.id },
      };

      // .isNotEmpty is Dart — in TypeScript this is .length > 0.
      const cleanDisplayName = display_name?.toString().trim() ?? "";
      if (cleanDisplayName.length > 0) {
        accountPayload.display_name = cleanDisplayName;
      }

      const accountResponse = await fetch(
        "https://api.stripe.com/v2/core/accounts",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripeSecretKey}`,
            "Content-Type": "application/json",
            "Stripe-Version": STRIPE_VERSION,
          },
          body: JSON.stringify(accountPayload),
        },
      );

      const accountData = await accountResponse.json();
      console.log("Stripe account response:", JSON.stringify(accountData));

      if (!accountResponse.ok) {
        return jsonResponse(
          {
            success: false,
            message:
              accountData?.error?.message ??
              accountData?.message ??
              "Unable to create Stripe connected account.",
            stripe_error: accountData,
          },
          accountResponse.status,
        );
      }

      stripeAccountId = accountData.id;

      if (!stripeAccountId) {
        return jsonResponse(
          {
            success: false,
            message: "Stripe account was created but no account ID was returned.",
          },
          500,
        );
      }

      accountWasCreated = true;

      // Scoped by the provider row's own id.
      const { error: updateError } = await supabaseAdmin
        .from("provider")
        .update({ stripe_account_id: stripeAccountId })
        .eq("id", providerRow.id);

      if (updateError) {
        console.error("Unable to save Stripe account ID:", updateError);
        return jsonResponse(
          {
            success: false,
            message:
              "Stripe account was created, but the ID could not be saved. " +
              "Contact support with the account id below before retrying.",
            stripe_account_id: stripeAccountId,
            error: updateError.message,
          },
          500,
        );
      }
    } else {
      console.log("Existing Stripe account found. Reusing:", stripeAccountId);
    }

    const baseUrl =
      "https://seven-sins-6rgs4y.flutterflow.app/onboardingSuccessPage";

    const returnUrl = `${baseUrl}?userId=${encodeURIComponent(userRow.id)}`;
    const refreshUrl = `${baseUrl}?userId=${encodeURIComponent(userRow.id)}`;
    const accountLinkPayload = {
      account: stripeAccountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          refresh_url: refreshUrl,
          return_url: returnUrl,
          collection_options: {
            fields: "eventually_due",
            future_requirements: "include",
          },
        },
      },
    };

    const accountLinkResponse = await fetch(
      "https://api.stripe.com/v2/core/account_links",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/json",
          "Stripe-Version": STRIPE_VERSION,
        },
        body: JSON.stringify(accountLinkPayload),
      },
    );

    const accountLinkData = await accountLinkResponse.json();
    console.log("Account link response:", JSON.stringify(accountLinkData));

    if (!accountLinkResponse.ok) {
      return jsonResponse(
        {
          success: false,
          message:
            accountLinkData?.error?.message ??
            accountLinkData?.message ??
            "Stripe account exists, but a new onboarding link could not be created.",
          stripe_account_id: stripeAccountId,
          stripe_error: accountLinkData,
        },
        accountLinkResponse.status,
      );
    }

    const onboardingUrl = accountLinkData?.url;
    if (!onboardingUrl) {
      return jsonResponse(
        {
          success: false,
          message: "Account link created but no onboarding URL was returned.",
          stripe_account_id: stripeAccountId,
          stripe_response: accountLinkData,
        },
        500,
      );
    }

    return jsonResponse({
      success: true,
      message: accountWasCreated
        ? "Stripe connected account created and a new onboarding link was generated."
        : "Existing Stripe connected account found and a new onboarding link was generated.",
      user_id: userRow.id,
      provider_id: providerRow.id,
      provider_email: providerEmail,
      stripe_account_id: stripeAccountId,
      account_was_created: accountWasCreated,
      onboarding_url: onboardingUrl,
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