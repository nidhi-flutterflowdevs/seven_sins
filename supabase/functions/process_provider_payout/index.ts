// supabase/functions/process_provider_payout/index.ts
//
// Fired by a Supabase Database Webhook on INSERT into payment_history.
// Transfers the provider's share from the platform balance into their
// connected account.
//
// Status lifecycle: pending -> processing -> settled
//                                        \-> failed
//
// Deploy: supabase functions deploy process_provider_payout --no-verify-jwt
// Secrets: STRIPE_SECRET_KEY, PAYOUT_WEBHOOK_SECRET

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("PAYOUT_WEBHOOK_SECRET")!;

const CURRENCY = "aud";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function markFailed(paymentId: string, reason: string) {
  const { error } = await supabaseAdmin
    .from("payment_history")
    .update({ status: "failed", failure_reason: reason })
    .eq("id", paymentId);

  if (error) console.error("Could not mark failed:", paymentId, error);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed" }, 405);
  }

  // Shared secret set as a custom header on the Database Webhook.
  if (req.headers.get("x-payout-secret") !== WEBHOOK_SECRET) {
    console.error("Invalid webhook secret");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: Record<string, any>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const record = payload?.record;

  if (payload?.type !== "INSERT" || !record?.id) {
    return jsonResponse({ received: true, skipped: "not an insert" });
  }

  if (record.status !== "pending") {
    return jsonResponse({ received: true, skipped: "not pending" });
  }

  const paymentId = record.id as string;

  try {
    // ---- Claim the row so a duplicate delivery cannot pay twice ----
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("payment_history")
      .update({ status: "processing" })
      .eq("id", paymentId)
      .eq("status", "pending")
      .select("id, provider_id, booking_id, booking_display_id, amount")
      .maybeSingle();

    if (claimError) throw claimError;

    if (!claimed) {
      console.log("Already claimed elsewhere:", paymentId);
      return jsonResponse({ received: true, skipped: "already processing" });
    }

    const amount = Number(claimed.amount ?? 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      await markFailed(paymentId, "Payout amount is zero or invalid");
      return jsonResponse({ received: true, error: "zero amount" });
    }

    // ---- provider_id here is a users.id ----
    const { data: providerRow, error: providerError } = await supabaseAdmin
      .from("provider")
      .select("id, stripe_account_id, stripe_transfers_enabled")
      .eq("user_id", claimed.provider_id)
      .maybeSingle();

    if (providerError) throw providerError;

    if (!providerRow?.stripe_account_id) {
      await markFailed(paymentId, "Provider has no Stripe account");
      return jsonResponse({ received: true, error: "no stripe account" });
    }

    if (!providerRow.stripe_transfers_enabled) {
      await markFailed(paymentId, "Provider transfers are not enabled");
      return jsonResponse({ received: true, error: "transfers disabled" });
    }

    // ---- Transfer. Stripe works in the smallest currency unit ----
    const amountMinor = Math.round(amount * 100);

    const form = new URLSearchParams({
      amount: String(amountMinor),
      currency: CURRENCY,
      destination: providerRow.stripe_account_id,
      description: `Payout for booking ${claimed.booking_display_id ?? claimed.booking_id}`,
      "metadata[payment_history_id]": paymentId,
      "metadata[booking_id]": String(claimed.booking_id ?? ""),
      "metadata[provider_user_id]": String(claimed.provider_id),
    });

    const res = await fetch("https://api.stripe.com/v1/transfers", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Stripe dedupes on this, so a retry can never double-pay.
        "Idempotency-Key": `payout_${paymentId}`,
      },
      body: form.toString(),
    });

    const transfer = await res.json();

    if (!res.ok) {
      const reason = transfer?.error?.message ?? "Stripe transfer failed";
      console.error("Transfer failed:", paymentId, JSON.stringify(transfer));
      await markFailed(paymentId, reason);
      // 200 so Supabase does not retry — the row records the failure.
      return jsonResponse({ received: true, error: reason });
    }

    // ---- Transfer succeeded: terminal state ----
    const { error: updateError } = await supabaseAdmin
      .from("payment_history")
      .update({
        status: "settled",
        stripe_transfer_id: transfer.id,
        settled_at: new Date().toISOString(),
        failure_reason: null,
      })
      .eq("id", paymentId);

    if (updateError) throw updateError;

    console.log("Payout settled", {
      paymentId,
      transferId: transfer.id,
      amountMinor,
      destination: providerRow.stripe_account_id,
    });

    return jsonResponse({
      received: true,
      status: "settled",
      transfer_id: transfer.id,
    });
  } catch (err) {
    console.error("Payout error:", paymentId, err);
    await markFailed(
      paymentId,
      err instanceof Error ? err.message : "Unexpected error",
    );
    return jsonResponse({ received: true, error: "handler error" });
  }
});