// supabase/functions/cancel_booking/index.ts
//
// POST { "booking_id": "<uuid>", "reason": "<optional>" }
//
// Either party may cancel. Refund policy:
//   provider cancels        -> refund (amount - platform fee)
//   client cancels >= 24h   -> refund (amount - platform fee)
//   client cancels <  24h   -> no refund
//   platform fee is never refunded
//
// Frees the provider slot, records the cancellation on the booking,
// and writes a payment_history row with status 'refund'.
//
// Deploy: supabase functions deploy cancel_booking

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

const CUTOFF_HOURS = 24;
const TZ = "Australia/Sydney";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Appointment start as a real instant, from the date + slot time in TZ. */
function appointmentStart(dateIso: string, startTime: string | null): Date {
  const day = new Date(dateIso).toISOString().slice(0, 10);
  const time = (startTime ?? "00:00:00").slice(0, 8);
  const naive = new Date(`${day}T${time}Z`);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(naive);

  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const offsetMs =
    Date.UTC(
      g("year"), g("month") - 1, g("day"),
      g("hour") % 24, g("minute"), g("second"),
    ) - naive.getTime();

  return new Date(naive.getTime() - offsetMs);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, message: "Only POST allowed." }, 405);
  }

  try {
    // --------------------------------------------------
    // 1. Auth
    // --------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(
        { success: false, message: "Authorization header is required." },
        401,
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user: authUser },
      error: authError,
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", "").trim());

    if (authError || !authUser) {
      return jsonResponse(
        { success: false, message: "Your session is invalid or has expired." },
        401,
      );
    }

    const { booking_id, reason } = await req.json();
    if (!booking_id) {
      return jsonResponse(
        { success: false, message: "booking_id is required." },
        400,
      );
    }

    // --------------------------------------------------
    // 2. auth.users.id -> public.users.id
    // --------------------------------------------------
    const { data: userRow, error: userRowError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();

    if (userRowError) throw userRowError;
    if (!userRow) {
      return jsonResponse(
        { success: false, message: "User record was not found." },
        404,
      );
    }

    // --------------------------------------------------
    // 3. Load the booking
    // --------------------------------------------------
    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select(
        "id, provider_id, user_id, date, start_time, amount, " +
          "platform_commision, payment_status, user_status, provider_status, " +
          "stripe_payment_intent_id, refund_status, booking_id",
      )
      .eq("id", booking_id)
      .maybeSingle();

    if (bookingError) throw bookingError;
    if (!booking) {
      return jsonResponse({ success: false, message: "Booking not found." }, 404);
    }

    // Role is derived from the booking, never from the request body.
    let actor: "provider" | "client";
    if (booking.provider_id === userRow.id) {
      actor = "provider";
    } else if (booking.user_id === userRow.id) {
      actor = "client";
    } else {
      return jsonResponse(
        { success: false, message: "This is not your booking." },
        403,
      );
    }

    if (
      booking.provider_status === "cancelled" ||
      booking.user_status === "cancelled"
    ) {
      return jsonResponse(
        { success: false, message: "This booking is already cancelled." },
        409,
      );
    }

    if (
      booking.provider_status === "completed" &&
      booking.user_status === "completed"
    ) {
      return jsonResponse(
        { success: false, message: "A completed booking cannot be cancelled." },
        409,
      );
    }

    // --------------------------------------------------
    // 4. Work out the refund
    // --------------------------------------------------
    const amount = Number(booking.amount ?? 0);
    const platformFee = Number(booking.platform_commision ?? 0);
    const refundable = Math.max(amount - platformFee, 0);

    const startsAt = appointmentStart(booking.date, booking.start_time);
    const hoursUntil = (startsAt.getTime() - Date.now()) / 3_600_000;
    const withinCutoff = hoursUntil < CUTOFF_HOURS;

    const refundAmount =
      actor === "provider" || !withinCutoff ? refundable : 0;

    const wasPaid =
      booking.payment_status === "paid" && !!booking.stripe_payment_intent_id;

    // --------------------------------------------------
    // 5. Refund first, so a Stripe failure leaves the
    //    booking intact and retryable
    // --------------------------------------------------
    let refundId: string | null = null;
    let refundStatus: string;

    if (refundAmount > 0 && wasPaid) {
      // Claim it so a double-tap cannot refund twice.
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from("bookings")
        .update({ refund_status: "pending" })
        .eq("id", booking.id)
        .is("stripe_refund_id", null)
        .select("id")
        .maybeSingle();

      if (claimError) throw claimError;
      if (!claimed) {
        return jsonResponse(
          { success: false, message: "A refund is already being processed." },
          409,
        );
      }

      const form = new URLSearchParams({
        payment_intent: booking.stripe_payment_intent_id!,
        // Partial — the platform fee stays behind.
        amount: String(Math.round(refundAmount * 100)),
        reason: "requested_by_customer",
        "metadata[booking_id]": booking.id,
        "metadata[cancelled_by]": actor,
      });

      const res = await fetch("https://api.stripe.com/v1/refunds", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // A retry returns the same refund rather than a second one.
          "Idempotency-Key": `refund_${booking.id}`,
        },
        body: form.toString(),
      });

      const refund = await res.json();

      if (!res.ok) {
        console.error("Refund failed:", booking.id, JSON.stringify(refund));

        await supabaseAdmin
          .from("bookings")
          .update({ refund_status: "failed" })
          .eq("id", booking.id);

        return jsonResponse(
          {
            success: false,
            message:
              refund?.error?.message ??
              "Refund failed. The booking was not cancelled.",
          },
          res.status,
        );
      }

      refundId = refund.id;
      refundStatus = "refunded";
    } else if (wasPaid) {
      // Paid, but inside the cutoff — nothing comes back.
      refundStatus = "forfeited";
    } else {
      refundStatus = "not_applicable";
    }

    // --------------------------------------------------
    // 6. Record the cancellation on the booking
    // --------------------------------------------------
    const nowIso = new Date().toISOString();

    const { error: updateError } = await supabaseAdmin
      .from("bookings")
      .update({
        provider_status: "cancelled",
        user_status: "cancelled",
        payment_status: refundId ? "refunded" : booking.payment_status,
        cancelled_at: nowIso,
        cancelled_by: actor,
        cancellation_reason: reason ?? null,
        stripe_refund_id: refundId,
        refund_status: refundStatus,
        refund_amount: refundAmount,
        updated_at: nowIso,
      })
      .eq("id", booking.id);

    if (updateError) throw updateError;

    // --------------------------------------------------
    // 7. Free the slot
    // --------------------------------------------------
    const { error: slotError } = await supabaseAdmin
      .from("provider_slots")
      .update({ is_booked: false, booked_by: null, booking_id: null })
      .eq("booking_id", booking.id);

    if (slotError) {
      console.error("Could not free slot:", booking.id, slotError);
    }

    // --------------------------------------------------
    // 8. payment_history row
    //
    // status 'refund' is deliberately NOT 'pending', so
    // trg_payout_on_insert reaches process_provider_payout
    // and that function skips it. Never relax that guard.
    // --------------------------------------------------
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
        stripe_transfer_id: null,
        failure_reason:
          refundAmount === 0
            ? "Cancelled within 24 hours — not refundable"
            : null,
        settled_at: refundId ? nowIso : null,
      });

    if (historyError) {
      // The money has already moved; don't fail the request over a log row.
      console.error("Could not write payment_history:", historyError);
    }

    console.log("Booking cancelled", {
      bookingId: booking.id,
      actor,
      hoursUntil: Math.round(hoursUntil * 10) / 10,
      refundAmount,
      refundStatus,
      refundId,
    });

    return jsonResponse({
      success: true,
      cancelled_by: actor,
      refund_amount: refundAmount,
      refund_status: refundStatus,
      refund_id: refundId,
      platform_fee_retained: platformFee,
      within_24_hours: withinCutoff,
      message:
        refundAmount > 0
          ? `Booking cancelled. $${refundAmount.toFixed(2)} will be refunded ` +
            "in 5 to 10 business days."
          : "Booking cancelled. Cancellations within 24 hours are not refundable.",
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse(
      {
        success: false,
        message: err instanceof Error ? err.message : "Unexpected server error.",
      },
      500,
    );
  }
});