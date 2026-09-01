// Supabase Edge Function: slot_creation_cron
//
// Purpose:
//   - Scheduled daily (e.g. via pg_cron + pg_net) to top up the rolling
//     15-day slot window for EVERY provider in one run.
//   - No body/params needed — this always processes the whole provider table.
//   - Fully self-contained: no import from a _shared module.
//
// Assumptions (confirm with your team if wrong):
//   - `unavailable_days`: 1=Monday ... 7=Sunday (ISO weekday numbering)
//   - `slot_duration` and `break_hour` are both in HOURS (decimals allowed, e.g. 0.5 = 30 min)
//   - Day rate applies 08:00:00 (inclusive) to 19:59:59, night rate applies 20:00:00 onward,
//     decided purely by each slot's start_time
//   - `date` column stores the slot's calendar date as a UTC timestamp (midnight UTC)
//   - Rolling window = today (UTC) through today + 14 days (15 days total)
//
// Deploy: supabase functions deploy slot_creation_cron
// Schedule via SQL (run once in the SQL Editor or as a migration):
//
//   create extension if not exists pg_cron;
//   create extension if not exists pg_net;
//
//   select cron.schedule(
//     'slot-creation-cron-daily',
//     '0 0 * * *', -- 12:00 AM UTC daily
//     $$
//     select net.http_post(
//       url := 'https://<your-project-ref>.supabase.co/functions/v1/slot_creation_cron',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <your-service-role-key>',
//         'Content-Type', 'application/json'
//       )
//     );
//     $$
//   );
//
// NEVER hardcode SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in this file.
// Set them as function secrets instead:
//   supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const WINDOW_DAYS = 15; // rolling window size
const NIGHT_START_HOUR = 20; // 8 PM, 24hr clock

interface Provider {
  id: string;
  user_id: string;
  unavailable_days: number[] | null;
  start_work_hour: string | null; // "HH:MM:SS"
  end_work_hour: string | null; // "HH:MM:SS"
  day_rate: number | null;
  night_rate: number | null;
  slot_duration: number | null; // hours (1 = 1 hour, 0.5 = 30 min)
  break_hour: number | null; // hours between slots
}

interface SlotInsert {
  provider_id: string; // holds user_id
  start_time: string; // "HH:MM:SS"
  end_time: string; // "HH:MM:SS"
  date: string; // ISO timestamp (UTC midnight for that date)
  duration: number;
  amount: number;
}

/** Parse "HH:MM:SS" into total hours since midnight (8.5 = 08:30:00). */
function timeToHours(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h + m / 60 + (s ?? 0) / 3600;
}

/** Convert hours since midnight (decimal) back into "HH:MM:SS". */
function hoursToTime(hoursValue: number): string {
  const totalSeconds = Math.round(hoursValue * 3600);
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Returns ISO weekday: 1=Monday ... 7=Sunday, for a UTC date. */
function isoWeekday(date: Date): number {
  const day = date.getUTCDay(); // 0=Sunday ... 6=Saturday
  return day === 0 ? 7 : day;
}

/** Format a Date as a UTC-midnight ISO timestamp for the `date` column. */
function toUtcMidnightIso(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  return d.toISOString();
}

/**
 * Build all slots for a single provider on a single day.
 * `slotOwnerId` is written into provider_slots.provider_id — the user_id.
 */
function buildSlotsForDay(
  provider: Provider,
  date: Date,
  slotOwnerId: string,
): SlotInsert[] {
  const {
    start_work_hour,
    end_work_hour,
    day_rate,
    night_rate,
    slot_duration,
    break_hour,
  } = provider;

  if (!start_work_hour || !end_work_hour || !slot_duration) {
    return []; // provider hasn't finished onboarding config
  }

  const breakHours = break_hour ?? 0;
  const startHours = timeToHours(start_work_hour);
  const endHours = timeToHours(end_work_hour);

  const slots: SlotInsert[] = [];
  let cursor = startHours;

  while (cursor + slot_duration <= endHours) {
    const slotStart = cursor;
    const slotEnd = cursor + slot_duration;

    const isNight = slotStart >= NIGHT_START_HOUR;
    const rate = isNight ? night_rate : day_rate;

    if (rate != null) {
      slots.push({
        provider_id: slotOwnerId, // user_id
        start_time: hoursToTime(slotStart),
        end_time: hoursToTime(slotEnd),
        date: toUtcMidnightIso(date),
        duration: slot_duration,
        amount: rate * slot_duration,
      });
    }

    cursor = slotEnd + breakHours;
  }

  return slots;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: providers, error: providerError } = await supabase
      .from("provider")
      .select(
        "id, user_id, unavailable_days, start_work_hour, end_work_hour, day_rate, night_rate, slot_duration, break_hour",
      );

    if (providerError) throw providerError;
    if (!providers || providers.length === 0) {
      return new Response(JSON.stringify({ message: "No providers found." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const windowEnd = new Date(todayUtc);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + (WINDOW_DAYS - 1)); // today + 14

    const allNewSlots: SlotInsert[] = [];
    const summary: Record<string, { from: string; to: string; slotsCreated: number; slotsDeleted: number }> = {};

    let totalDeleted = 0;
    const skipped: string[] = [];

    for (const provider of providers as Provider[]) {
      const ownerId = provider.user_id;

      // A provider row with no linked user can't own slots under the FK.
      if (!ownerId) {
        skipped.push(provider.id);
        continue;
      }

      // ---------- 1. Top up the forward window ----------

      const { data: lastSlotRow, error: lastSlotError } = await supabase
        .from("provider_slots")
        .select("date")
        .eq("provider_id", ownerId)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastSlotError) throw lastSlotError;

      let cursorDate: Date;
      if (lastSlotRow?.date) {
        cursorDate = new Date(lastSlotRow.date);
        cursorDate.setUTCDate(cursorDate.getUTCDate() + 1); // day after last generated
      } else {
        cursorDate = new Date(todayUtc); // initial backfill
      }

      // Guard: if the last generated date is in the past (cron missed days),
      // don't regenerate history — jump to today.
      if (cursorDate < todayUtc) {
        cursorDate = new Date(todayUtc);
      }

      const unavailable = new Set(provider.unavailable_days ?? []);
      let slotsCreated = 0;
      const fromDate = toUtcMidnightIso(cursorDate);

      while (cursorDate <= windowEnd) {
        const weekday = isoWeekday(cursorDate);
        if (!unavailable.has(weekday)) {
          const daySlots = buildSlotsForDay(provider, cursorDate, ownerId);
          allNewSlots.push(...daySlots);
          slotsCreated += daySlots.length;
        }
        cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
      }

      // ---------- 2. Delete expired slots ----------

      const { data: deletedRows, error: deleteError } = await supabase
        .from("provider_slots")
        .delete()
        .eq("provider_id", ownerId)
        .lt("date", toUtcMidnightIso(todayUtc))
        .select("id");

      if (deleteError) throw deleteError;

      const slotsDeleted = deletedRows?.length ?? 0;
      totalDeleted += slotsDeleted;

      summary[ownerId] = {
        from: fromDate,
        to: windowEnd.toISOString(),
        slotsCreated,
        slotsDeleted,
      };
    }

    if (allNewSlots.length > 0) {
      const { error: insertError } = await supabase
        .from("provider_slots")
        .insert(allNewSlots);

      if (insertError) throw insertError;
    }

    return new Response(
      JSON.stringify({
        message: "Cron slot generation complete.",
        providersProcessed: providers.length - skipped.length,
        providersSkippedNoUserId: skipped,
        totalSlotsInserted: allNewSlots.length,
        totalSlotsDeleted: totalDeleted,
        perProvider: summary,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});