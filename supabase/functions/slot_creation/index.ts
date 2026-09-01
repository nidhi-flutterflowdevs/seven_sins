// Supabase Edge Function: generate-provider-slots
//
// Purpose:
//   - Callable directly via POST with { "user_id": "<uuid>" } in the body to
//     (re)generate the rolling 15-day slot window for that ONE provider.
//   - Looks up the provider row via provider.user_id, then builds/tops-up slots.
//   - No cron required for this mode — call it whenever you want (e.g. right
//     after onboarding, or from a button in your app).
//
// Assumptions (confirm with your team if wrong):
//   - `unavailable_days`: 1=Monday ... 7=Sunday (ISO weekday numbering)
//   - `slot_duration` and `break_hour` are both in HOURS (decimals allowed, e.g. 0.5 = 30 min)
//   - Day rate applies 08:00:00 (inclusive) to 19:59:59, night rate applies 20:00:00 onward,
//     decided purely by each slot's start_time
//   - `date` column stores the slot's calendar date as a UTC timestamp (midnight UTC)
//   - Rolling window = today (UTC) through today + 14 days (15 days total)
//
// Deploy:      supabase functions deploy generate-provider-slots
// Call locally: supabase functions serve generate-provider-slots --env-file ./supabase/.env.local
//   then: curl -X POST http://localhost:54321/functions/v1/generate-provider-slots \
//           -H "Authorization: Bearer <ANON_OR_SERVICE_KEY>" \
//           -H "Content-Type: application/json" \
//           -d '{"user_id": "11111111-2222-3333-4444-555555555555"}'
//
// NEVER hardcode SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in this file.
// Set them as function secrets instead:
//   supabase secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
// (locally, put them in supabase/.env.local, which should be gitignored)

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
  slot_duration: number | null; // hours
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
 * `slotOwnerId` is what gets written into provider_slots.provider_id — the user_id.
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
        provider_id: slotOwnerId, // user_id, not provider.id
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

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST." }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: { user_id?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const userId = body.user_id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "user_id is required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: providerRow, error: providerError } = await supabase
      .from("provider")
      .select(
        "id, user_id, unavailable_days, start_work_hour, end_work_hour, day_rate, night_rate, slot_duration, break_hour",
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (providerError) throw providerError;
    if (!providerRow) {
      return new Response(
        JSON.stringify({ error: `No provider found for user_id ${userId}.` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const provider = providerRow as Provider;

    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const windowEnd = new Date(todayUtc);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + (WINDOW_DAYS - 1)); // today + 14

    // Find the latest date already generated for this user.
    const { data: lastSlotRow, error: lastSlotError } = await supabase
      .from("provider_slots")
      .select("date")
      .eq("provider_id", userId) // provider_id holds user_id
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastSlotError) throw lastSlotError;

    let cursorDate: Date;
    if (lastSlotRow?.date) {
      cursorDate = new Date(lastSlotRow.date);
      cursorDate.setUTCDate(cursorDate.getUTCDate() + 1); // day after last generated
    } else {
      cursorDate = new Date(todayUtc); // initial 15-day backfill
    }

    const unavailable = new Set(provider.unavailable_days ?? []);
    const allNewSlots: SlotInsert[] = [];
    const fromDate = toUtcMidnightIso(cursorDate);

    while (cursorDate <= windowEnd) {
      const weekday = isoWeekday(cursorDate);
      if (!unavailable.has(weekday)) {
        allNewSlots.push(...buildSlotsForDay(provider, cursorDate, userId));
      }
      cursorDate.setUTCDate(cursorDate.getUTCDate() + 1);
    }

    if (allNewSlots.length > 0) {
      const { error: insertError } = await supabase
        .from("provider_slots")
        .insert(allNewSlots);

      if (insertError) throw insertError;
    }

    return new Response(
      JSON.stringify({
        message: "Slot generation complete.",
        user_id: userId,
        provider_id: userId, // what was written into provider_slots.provider_id
        provider_table_id: provider.id, // the actual provider row id, for reference
        totalSlotsInserted: allNewSlots.length,
        detail: {
          from: fromDate,
          to: windowEnd.toISOString(),
          slotsCreated: allNewSlots.length,
        },
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