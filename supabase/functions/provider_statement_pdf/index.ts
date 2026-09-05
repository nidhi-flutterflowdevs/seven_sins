// supabase/functions/provider_statement_pdf/index.ts
//
// POST { "from": "01-08-2026", "to": "31-08-2026" }  (both optional)
// Returns the PDF bytes directly — the client writes them to disk.
// On error, returns JSON with a non-200 status.
//
// Deploy:  supabase functions deploy provider_statement_pdf

import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TZ = "Australia/Sydney";
const BUSINESS_NAME = "Seven Sins Entertainment";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "content-disposition",
};

// A4 in points
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Table geometry
const ROW_H = 22;
const HEADER_ROW_H = 20;
const COL = {
  date: MARGIN + 10,
  client: MARGIN + 110,
  booking: MARGIN + 300,
  amount: PAGE_W - MARGIN - 10,
};

// Palette
const INK = rgb(0.102, 0.102, 0.122);
const MUTED = rgb(0.455, 0.455, 0.486);
const FAINT = rgb(0.604, 0.604, 0.635);
const HAIRLINE = rgb(0.925, 0.925, 0.918);
const FILL_SOFT = rgb(0.957, 0.957, 0.945);
const FILL_CARD = rgb(0.957, 0.957, 0.945);

interface Row {
  id: string;
  booking_display_id: string | null;
  date: string | null;
  amount: number | null;
  status: string | null;
  // deno-lint-ignore no-explicit-any
  users: any;
}

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

    let fromStr: string | null = null;
    let toStr: string | null = null;
    try {
      const body = await req.json();
      fromStr = body?.from ?? null;
      toStr = body?.to ?? null;
    } catch { /* no body — all time */ }

    const fromDate = parseDdMmYyyy(fromStr);
    const toDate = parseDdMmYyyy(toStr);

    if (fromStr && !fromDate) {
      return json({ error: "Invalid 'from' date, expected DD-MM-YYYY" }, 400);
    }
    if (toStr && !toDate) {
      return json({ error: "Invalid 'to' date, expected DD-MM-YYYY" }, 400);
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

    const providerId = profile.id as string;

    // Only settled payments — the statement no longer shows a status column,
    // so listing pending/refunded rows would make the total look wrong.
    let query = supabaseAdmin
      .from("payment_history")
      .select("id, booking_display_id, date, amount, status, users:user_id (name)")
      .eq("provider_id", providerId)
      .eq("status", "paid")
      .order("date", { ascending: false });

    // Inclusive of both days, converted from local dates to UTC instants.
    if (fromDate) query = query.gte("date", startOfLocalDayUtc(fromDate));
    if (toDate) query = query.lt("date", startOfLocalDayUtc(addDays(toDate, 1)));

    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw rowsError;

    const items = (rows ?? []) as unknown as Row[];
    const totalPaid = items.reduce((sum, r) => sum + (r.amount ?? 0), 0);

    const statement = {
      provider: { name: profile.name as string, email: profile.email as string },
      period_from: fromStr ?? null,
      period_to: toStr ?? null,
      generated_at: formatDateTime(new Date()),
      total_records: items.length,
      total_paid: fmtMoney(totalPaid),
      items: items.map((r) => ({
        date_label: r.date ? formatDate(new Date(r.date)) : "-",
        client_name: r.users?.name ?? "Unknown",
        booking_display_id: r.booking_display_id ?? "-",
        amount: fmtMoney(r.amount ?? 0),
      })),
    };

    const bytes = await buildPdf(statement);
    const body = new Uint8Array(bytes);

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `statement-${stamp}.pdf`;

    return new Response(body, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(body.byteLength),
      },
    });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});

// ---------- date helpers ----------

/** "22-08-2026" -> Date (UTC midnight of that calendar date), or null. */
function parseDdMmYyyy(s: string | null): Date | null {
  if (!s || !/^\d{2}-\d{2}-\d{4}$/.test(s.trim())) return null;
  const [d, m, y] = s.trim().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null; // e.g. 31-02
  return dt;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** The UTC instant at which the given calendar date begins in TZ. */
function startOfLocalDayUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  // Probe midday UTC to read the zone's offset for that date (DST-safe).
  const probe = new Date(Date.UTC(y, m, day, 12));
  const offsetMs = tzOffsetMs(probe);
  return new Date(Date.UTC(y, m, day) - offsetMs).toISOString();
}

/** TZ offset in ms for a given instant. */
function tzOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") % 24, get("minute"), get("second"),
  );
  return asUtc - at.getTime();
}

function formatDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")}`;
}

function formatDateTime(d: Date): string {
  const p = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")} ${g("hour")}:${g("minute")}`;
}

/** 3500 -> "$3,500"   3500.5 -> "$3,500.50" */
function fmtMoney(n: number): string {
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  const hasCents = rounded % 1 !== 0;
  return "$" + rounded.toLocaleString("en-AU", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

// ---------- pdf ----------

// deno-lint-ignore no-explicit-any
async function buildPdf(s: any): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  let pageNo = 1;

  const write = (
    str: string,
    x: number,
    baselineY: number,
    size = 10,
    f = font,
    color = INK,
    align: "left" | "right" = "left",
  ) => {
    const safe = sanitize(str);
    const w = align === "right" ? f.widthOfTextAtSize(safe, size) : 0;
    page.drawText(safe, { x: x - w, y: baselineY, size, font: f, color });
  };

  const rule = (atY: number, thickness: number, color = HAIRLINE) => {
    page.drawLine({
      start: { x: MARGIN, y: atY },
      end: { x: PAGE_W - MARGIN, y: atY },
      thickness,
      color,
    });
  };

  const band = (topY: number, height: number, color = FILL_SOFT) => {
    page.drawRectangle({
      x: MARGIN, y: topY - height, width: CONTENT_W, height, color,
    });
  };

  // ---- Header ----
  write("PAYMENT STATEMENT", MARGIN, y - 15, 17, bold);

  const periodLabel = s.period_from || s.period_to
    ? `${s.period_from ?? "Start"}  -  ${s.period_to ?? "Today"}`
    : "All time";
  write(periodLabel, MARGIN, y - 31, 10, font, MUTED);

  // Provider details, right aligned
  write(s.provider?.name ?? "Provider", PAGE_W - MARGIN, y - 13, 11, bold, INK, "right");
  if (s.provider?.email) {
    write(s.provider.email, PAGE_W - MARGIN, y - 27, 9, font, MUTED, "right");
  }
  write(`Generated ${s.generated_at}`, PAGE_W - MARGIN, y - 39, 8.5, font, FAINT, "right");

  y -= 56;
  rule(y, 1.6, INK);
  y -= 30;

  // ---- Summary cards ----
  const cardH = 50;
  const cardGap = 12;
  const cardW = (CONTENT_W - cardGap) / 2;

  const card = (x: number, label: string, value: string) => {
    page.drawRectangle({
      x, y: y - cardH, width: cardW, height: cardH, color: FILL_CARD,
    });
    write(label, x + 14, y - 20, 8, bold, MUTED);
    write(value, x + 14, y - 39, 17, bold, INK);
  };

  card(MARGIN, "TOTAL RECEIVED", s.total_paid);
  card(MARGIN + cardW + cardGap, "TRANSACTIONS", String(s.total_records));

  y -= cardH + 34;

  // ---- Table ----
  const drawTableHeader = () => {
    band(y, HEADER_ROW_H);
    const textY = y - 14;
    write("DATE", COL.date, textY, 8, bold, MUTED);
    write("CLIENT", COL.client, textY, 8, bold, MUTED);
    write("BOOKING", COL.booking, textY, 8, bold, MUTED);
    write("AMOUNT", COL.amount, textY, 8, bold, MUTED, "right");
    y -= HEADER_ROW_H;
  };

  drawTableHeader();

  if (s.items.length === 0) {
    y -= 24;
    write("No transactions in this period.", MARGIN + 10, y, 10, font, MUTED);
    y -= 12;
  }

  s.items.forEach((it: Record<string, string>, i: number) => {
    // Leave room for the total block and footer.
    if (y - ROW_H < MARGIN + 90) {
      drawFooter(page, pageNo, write, rule);
      page = pdf.addPage([PAGE_W, PAGE_H]);
      pageNo += 1;
      y = PAGE_H - MARGIN;
      drawTableHeader();
    }

    if (i % 2 === 1) band(y, ROW_H, rgb(0.98, 0.98, 0.973));

    const textY = y - 15;
    write(it.date_label, COL.date, textY, 9.5);
    write(truncate(it.client_name, 28), COL.client, textY, 9.5);
    write(shortId(it.booking_display_id), COL.booking, textY, 9, mono, MUTED);
    write(it.amount, COL.amount, textY, 9.5, font, INK, "right");

    y -= ROW_H;
    rule(y, 0.5);
  });

  // ---- Total ----
  y -= 14;
  rule(y + 10, 1.6, INK);
  write("TOTAL RECEIVED", COL.amount - 100, y - 8, 10, bold, MUTED, "right");
  write(s.total_paid, COL.amount, y - 10, 15, bold, INK, "right");

  drawFooter(page, pageNo, write, rule);

  return await pdf.save();
}

// deno-lint-ignore no-explicit-any
function drawFooter(page: any, pageNo: number, write: any, rule: any) {
  const footY = MARGIN + 4;
  page.drawLine({
    start: { x: MARGIN, y: footY + 14 },
    end: { x: PAGE_W - MARGIN, y: footY + 14 },
    thickness: 0.5,
    color: HAIRLINE,
  });
  page.drawText(`${BUSINESS_NAME}  -  Payment statement`, {
    x: MARGIN, y: footY, size: 8, color: FAINT,
  });
  const label = `Page ${pageNo}`;
  page.drawText(label, {
    x: PAGE_W - MARGIN - label.length * 4.2, y: footY, size: 8, color: FAINT,
  });
}

/** Helvetica in pdf-lib is WinAnsi — strip anything it can't encode. */
function sanitize(str: string): string {
  return String(str ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    // deno-lint-ignore no-control-regex
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "..." : str;
}

function shortId(id: string): string {
  return !id || id === "-" ? "-" : id.slice(0, 8);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}