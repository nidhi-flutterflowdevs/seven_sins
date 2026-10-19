// supabase/functions/auto_cancel_unaccepted/index.ts
//
// Runs hourly via pg_cron. Cancels bookings the provider has not
// accepted with less than 2 hours to go, refunding the client the
// booking amount less the platform fee.
//
// Deploy: supabase functions deploy auto_cancel_unaccepted --no-verify-jwt
// Secrets: STRIPE_SECRET_KEY, CRON_SECRET

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

const DEFAULT_WINDOW_HOURS = 2;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface DueBooking {
  id: string;
  booking_id: string | null;
  provider_id: string;
  user_id: string;
  amount: number | null;
  platform_commision: number | null;
  payment_status: string | null;
  stripe_payment_intent_id: string | null;
  starts_at: string;
  hours_until: number;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed" }, 405);
  }

  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    console.error("Invalid cron secret");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let windowHours = DEFAULT_WINDOW_HOURS;
  try {
    const body = await req.json();
    if (typeof body?.window_hours === "number") {
      windowHours = body.window_hours;
    }
  } catch { /* no body — use the default */ }

  const results = {
    window_hours: windowHours,
    checked: 0,
    cancelled: 0,
    refunded: 0,
    failed: 0,
    errors: [] as string[],
  };

  try {
    const { data: due, error: dueError } = await supabaseAdmin.rpc(
      "get_unaccepted_bookings_due",
      { p_window_hours: windowHours },
    );

    if (dueError) throw dueError;

    const bookings = (due ?? []) as DueBooking[];
    results.checked = bookings.length;

    if (bookings.length === 0) {
      console.log("No unaccepted bookings due");
      return jsonResponse({ success: true, ...results });
    }

    console.log(`Processing ${bookings.length} unaccepted booking(s)`);

    for (const booking of bookings) {
      try {
        const amount = Number(booking.amount ?? 0);
        const platformFee = Number(booking.platform_commision ?? 0);
        const refundAmount = Math.max(amount - platformFee, 0);

        const wasPaid =
          booking.payment_status === "paid" &&
          !!booking.stripe_payment_intent_id;

        // ---- Claim it so a concurrent run cannot double-process ----
        const { data: claimed, error: claimError } = await supabaseAdmin
          .from("bookings")
          .update({ refund_status: "pending" })
          .eq("id", booking.id)
          .eq("provider_status", "pending")
          .is("cancelled_at", null)
          .select("id")
          .maybeSingle();

        if (claimError) throw claimError;

        if (!claimed) {
          console.log("Skipped, already handled:", booking.id);
          continue;
        }

        // ---- Refund ----
        let refundId: string | null = null;
        let refundStatus = "not_applicable";

        if (refundAmount > 0 && wasPaid) {
          const form = new URLSearchParams({
            payment_intent: booking.stripe_payment_intent_id!,
            amount: String(Math.round(refundAmount * 100)),
            reason: "requested_by_customer",
            "metadata[booking_id]": booking.id,
            "metadata[cancelled_by]": "system",
            "metadata[cancel_reason]": "provider_no_response",
          });

          const res = await fetch("https://api.stripe.com/v1/refunds", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": `refund_${booking.id}`,
            },
            body: form.toString(),
          });

          const refund = await res.json();

          if (!res.ok) {
            const reason = refund?.error?.message ?? "Refund failed";
            console.error("Refund failed:", booking.id, reason);

            await supabaseAdmin
              .from("bookings")
              .update({ refund_status: "failed" })
              .eq("id", booking.id);

            results.failed += 1;
            results.errors.push(`${booking.id}: ${reason}`);
            continue;   // booking stays live so the next run retries it
          }

          refundId = refund.id;
          refundStatus = "refunded";
          results.refunded += 1;
        } else if (wasPaid) {
          refundStatus = "forfeited";
        }

        const nowIso = new Date().toISOString();

        // ---- Cancel ----
        const { error: updateError } = await supabaseAdmin
          .from("bookings")
          .update({
            provider_status: "cancelled",
            user_status: "cancelled",
            payment_status: refundId ? "refunded" : booking.payment_status,
            cancelled_at: nowIso,
            cancelled_by: "system",
            cancellation_reason:
              "Automatically cancelled — the provider did not respond in time",
            stripe_refund_id: refundId,
            refund_status: refundStatus,
            refund_amount: refundAmount,
            updated_at: nowIso,
          })
          .eq("id", booking.id);

        if (updateError) throw updateError;

        // ---- Free the slot ----
        const { error: slotError } = await supabaseAdmin
          .from("provider_slots")
          .update({ is_booked: false, booked_by: null, booking_id: null })
          .eq("booking_id", booking.id);

        if (slotError) {
          console.error("Could not free slot:", booking.id, slotError);
        }

        // ---- payment_history ----
        // status 'refund', not 'pending', so trg_payout_on_insert
        // reaches process_provider_payout and that function skips it.
        const { error: historyError } = await supabaseAdmin
          .from("payment_history")
          .insert({
            provider_id: booking.provider_id,
            user_id: booking.user_id,
            booking_id: booking.id,
            booking_display_id: booking.booking_id,
            date: nowIso,
            amount: refundAmount,
            status: "refund",
            failure_reason: "Provider did not accept the booking in time",
            settled_at: refundId ? nowIso : null,
          });

        if (historyError) {
          console.error("Could not write payment_history:", historyError);
        }

        results.cancelled += 1;

        console.log("Auto-cancelled", {
          bookingId: booking.id,
          startsAt: booking.starts_at,
          hoursUntil: booking.hours_until,
          refundAmount,
          refundId,
        });
      } catch (err) {
        results.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        results.errors.push(`${booking.id}: ${msg}`);
        console.error("Error on booking:", booking.id, err);
      }
    }

    console.log("Sweep complete", results);

    return jsonResponse({ success: true, ...results });
  } catch (err) {
    console.error("Sweep failed:", err);
    return jsonResponse(
      {
        success: false,
        message: err instanceof Error ? err.message : "Unexpected error",
        ...results,
      },
      500,
    );
  }
});