// supabase/functions/stripe_account_webhook/index.ts
//
// Receives Accounts v2 thin events and keeps public.provider in sync.
//
// Deploy: supabase functions deploy stripe_account_webhook --no-verify-jwt
// (Stripe sends no Supabase JWT — without the flag every delivery 401s.)
//
// Secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_ACCOUNT_WEBHOOK_SECRET   (the event destination's own whsec_)

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_ACCOUNT_WEBHOOK_SECRET")!;

const STRIPE_VERSION = "2026-02-25.clover";
const TOLERANCE_SECONDS = 300;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --------------------------------------------------
// Signature verification (same scheme for thin events)
// --------------------------------------------------
async function verifySignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = header.split(",").reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split("=");
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts["t"];
  const expected = parts["v1"];
  if (!timestamp || !expected) return false;

  // Reject replays.
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > TOLERANCE_SECONDS) {
    console.warn("Signature timestamp outside tolerance:", age);
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );

  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare.
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// --------------------------------------------------
// Fetch the account (thin events carry no object body)
// --------------------------------------------------
async function fetchAccount(accountId: string) {
  const includeFields = [
    "requirements",
    "configuration.recipient",
    "identity",
  ];

  const url =
    `https://api.stripe.com/v2/core/accounts/${encodeURIComponent(accountId)}?` +
    includeFields
      .map((f, i) => `include[${i}]=${encodeURIComponent(f)}`)
      .join("&");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      data?.error?.message ?? data?.message ?? "Unable to retrieve account",
    );
  }

  return data?.account ?? data;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Only POST requests are allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  const body = await req.text();

  const valid = await verifySignature(body, signature, WEBHOOK_SECRET);
  if (!valid) {
    console.error("Signature verification failed");
    return new Response("Invalid signature", { status: 400 });
  }

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  console.log("Received event:", event?.type, event?.id);

  try {
    const HANDLED = [
      "v2.core.account[requirements].updated",
      "v2.core.account[configuration.recipient].updated",
      "v2.core.account.closed",
      "v2.core.account.created",
    ];

    if (!HANDLED.includes(event?.type)) {
      // Acknowledge anything else so Stripe stops retrying.
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const accountId =
      event?.related_object?.id ?? event?.data?.object?.id ?? null;

    if (!accountId) {
      console.warn("No related account on event", event?.id);
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // ---- Account closed ----
    if (event.type === "v2.core.account.closed") {
      const { error } = await supabaseAdmin
        .from("provider")
        .update({
          stripe_onboarding_completed: false,
          stripe_transfers_enabled: false,
          stripe_payouts_enabled: false,
          stripe_account_status: "closed",
        })
        .eq("stripe_account_id", accountId);

      if (error) throw error;

      console.log("Account closed", accountId);

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---- Everything else: fetch and sync ----
    const account = await fetchAccount(accountId);

    const requirements = account?.requirements ?? {};
    const capabilities =
      account?.configuration?.recipient?.capabilities ?? {};

    const asArray = (v: unknown) => (Array.isArray(v) ? v : []);

    const currentlyDue = asArray(requirements?.currently_due);
    const pastDue = asArray(requirements?.past_due);
    const pendingVerification = asArray(requirements?.pending_verification);

    const transfersStatus =
      capabilities?.stripe_balance?.stripe_transfers?.status ?? null;
    const payoutsStatus =
      capabilities?.stripe_balance?.payouts?.status ?? null;

    const requirementsComplete =
      currentlyDue.length === 0 &&
      pastDue.length === 0 &&
      pendingVerification.length === 0;

    const transfersActive = transfersStatus === "active";
    const payoutsActive = payoutsStatus === "active";
    const capabilitiesActive = transfersActive || payoutsActive;

    const onboardingCompleted = requirementsComplete && capabilitiesActive;

    const { data: updated, error } = await supabaseAdmin
      .from("provider")
      .update({
        stripe_onboarding_completed: onboardingCompleted,
        stripe_transfers_enabled: transfersActive,
        stripe_payouts_enabled: payoutsActive,
        stripe_requirements: requirements,
        stripe_account_status: onboardingCompleted
          ? "active"
          : requirementsComplete
          ? "pending_verification"
          : "incomplete",
      })
      .eq("stripe_account_id", accountId)
      .select("id");

    if (error) throw error;

    if (!updated || updated.length === 0) {
      // Account exists in Stripe but not in our database. Retrying will
      // never fix that, so acknowledge and log for investigation.
      console.error("No provider row for Stripe account:", accountId);
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    console.log("Provider synced", {
      accountId,
      providerId: updated[0].id,
      onboardingCompleted,
      transfersActive,
      currentlyDue,
    });

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Non-2xx makes Stripe retry with backoff.
    console.error("Handler error:", event?.type, err);
    return new Response("Webhook handler error", { status: 500 });
  }
});