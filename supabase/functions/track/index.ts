// Checks parcel status, saves it, and has Claude write a customer update.
// International parcels (forwarders, DHL/FedEx/UPS/Aramex...) go through 17TRACK; Indian couriers through TrackCourier.
// Called by the staff app ("Check now") for one parcel, or by the daily timer for all active parcels.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const TRACKCOURIER_STATUS: Record<string, string> = {
  inforeceived: "booked", pending: "booked", intransit: "in_transit",
  outfordelivery: "out_for_delivery", attemptfail: "delivery_failed",
  delivered: "delivered", exception: "problem", expired: "expired",
};
const TRACK17_STATUS: Record<string, string> = {
  InfoReceived: "booked", InTransit: "in_transit", AvailableForPickup: "out_for_delivery",
  OutForDelivery: "out_for_delivery", DeliveryFailure: "delivery_failed", Delivered: "delivered",
  Exception: "problem", Expired: "expired",
};

const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"]);
let claude: Anthropic | null = null; // created on first use, so a missing key can't crash the function

// Key names as saved in the Supabase dashboard (older names still accepted)
const CLAUDE_KEY = Deno.env.get("Claude_key") ?? Deno.env.get("ANTHROPIC_API_KEY");
const TRACKCOURIER_KEY = Deno.env.get("Tracking_Key") ?? Deno.env.get("TRACKCOURIER_API_KEY");
const TRACK17_KEY = Deno.env.get("track17_key") ?? Deno.env.get("TRACK17_API_KEY");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 17TRACK allows 3 requests a second
async function track17(path: string, number: string) {
  await sleep(400);
  const res = await fetch(`https://api.17track.net/track/v2.4/${path}`, {
    method: "POST",
    headers: { "17token": TRACK17_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify([{ number }]),
  }).then((r) => r.json()).catch(() => null);
  return { ok: res?.data?.accepted?.[0], err: res?.data?.rejected?.[0]?.error ?? (res?.code ? { code: res.code } : null) };
}

type Result = { status: string; detail: string | null; location: string | null; checkpoints: unknown[]; stop?: boolean; error?: string };

async function checkTrack17(b: any, number: string): Promise<Result | { error: string; stop?: boolean }> {
  if (!b.track17_registered) {
    const reg = await track17("register", number);
    if (reg.err?.code === -18019908) return { error: "17TRACK_QUOTA_USED_UP", stop: true };
    if (!reg.ok && !/already|registered/i.test(reg.err?.message ?? "")) return { error: `17TRACK_REGISTER_${reg.err?.code ?? "FAILED"}` };
    await admin.from("bookings").update({ track17_registered: true }).eq("id", b.id);
  }
  const info = await track17("gettrackinfo", number);
  if (info.err?.code === -18019902) {
    await admin.from("bookings").update({ track17_registered: false }).eq("id", b.id);
    return { error: "17TRACK_NOT_REGISTERED" };
  }
  const t = info.ok?.track_info;
  if (!t) return { error: "17TRACK_NO_INFO_YET" };
  const events = (t.tracking?.providers ?? []).flatMap((p: any) => p.events ?? [])
    .sort((x: any, y: any) => String(x.time_iso).localeCompare(String(y.time_iso)))
    .map((e: any) => ({ Activity: e.description, Location: e.location ?? "", Date: String(e.time_iso ?? "").slice(0, 10), Time: String(e.time_iso ?? "").slice(11, 16) }));
  const s = t.latest_status?.status;
  return {
    status: TRACK17_STATUS[s] ?? b.status,
    detail: t.latest_event?.description ?? t.latest_status?.sub_status_descr ?? s ?? null,
    location: t.latest_event?.location ?? null,
    checkpoints: events,
  };
}

async function checkTrackCourier(b: any): Promise<Result | { error: string; stop?: boolean }> {
  const r = await fetch(
    `https://api.trackcourier.io/v1/track?courier=${b.courier.trackcourier_slug}&tracking_number=${encodeURIComponent(b.awb)}`,
    { headers: { "X-API-Key": TRACKCOURIER_KEY ?? "" } },
  ).then((res) => res.json()).catch(() => null);
  if (!r?.success) {
    const code = r?.error?.code ?? "TRACKING_ERROR";
    return { error: code, stop: ["QUOTA_EXCEEDED", "NO_SHIPMENTS_LEFT", "INVALID_API_KEY"].includes(code) };
  }
  const latest = (r.data.Checkpoints ?? []).at(-1);
  return {
    status: TRACKCOURIER_STATUS[r.data.ShipmentState] ?? "in_transit",
    detail: r.data.MostRecentStatus ?? null,
    location: latest?.Location ?? null,
    checkpoints: r.data.Checkpoints ?? [],
  };
}

async function customerMessage(b: any, courierName: string, number: string, res: Result) {
  if (!CLAUDE_KEY) return null;
  claude ??= new Anthropic({ apiKey: CLAUDE_KEY });
  const latest = res.checkpoints.at(-1) as any;
  const msg = await claude.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 1000,
    system: "You write short WhatsApp updates for Guru Nanak Courier Services customers in India. " +
      "Write 2-3 friendly sentences in simple English, then the same message in Hindi. No emojis. " +
      "Use only the facts given; never invent dates or places.",
    messages: [{
      role: "user",
      content: `Customer: ${b.receiver_name}\nDestination: ${b.receiver_city ?? "-"}\nCourier: ${courierName}\n` +
        `Tracking number: ${number}\nStatus: ${res.detail ?? res.status}\nLast update: ${latest?.Activity ?? "-"} ` +
        `at ${latest?.Location || "-"} on ${latest?.Date ?? "-"} ${latest?.Time ?? ""}`,
    }],
  }).catch(() => null);
  const text = msg?.content.find((c) => c.type === "text");
  return text?.type === "text" ? text.text : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const body = await req.json().catch(() => ({}));

  // Setup check: says only whether each key is present, never its value
  if (body.health) {
    return json({ claude: !!CLAUDE_KEY, trackcourier: !!TRACKCOURIER_KEY, track17: !!TRACK17_KEY });
  }

  // Allowed callers: the daily timer (password kept in Vault) or a logged-in staff member
  const cronHeader = req.headers.get("x-cron-secret") ?? "";
  const fromCron = cronHeader !== "" && (await admin.rpc("cron_secret_matches", { p: cronHeader })).data === true;
  if (!fromCron) {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data } = await admin.auth.getUser(token);
    const { data: staff } = data.user
      ? await admin.from("staff").select("user_id").eq("user_id", data.user.id).maybeSingle()
      : { data: null };
    if (!staff) return json({ error: "Not allowed" }, 401);
  }

  const { booking_id } = body;
  let query = admin
    .from("bookings")
    .select("id, awb, forwarding_no, track17_registered, status, receiver_name, receiver_city, " +
      "courier:couriers!bookings_courier_id_fkey(name, trackcourier_slug, track_via), " +
      "fwd:couriers!bookings_forwarding_courier_id_fkey(name)")
    .or("awb.not.is.null,forwarding_no.not.is.null");
  query = booking_id
    ? query.eq("id", booking_id)
    : query.not("status", "in", "(delivered,expired)").eq("imported", false)   // past records never use tracking quota
        .gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString())
        .order("last_checked_at", { ascending: true, nullsFirst: true })
        .limit(60);
  const { data: bookings, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const results = [];
  const stopped = new Set<string>();
  for (const b of (bookings ?? []) as any[]) {
    // The forwarding number (DHL/FedEx/UPS...) wins; otherwise the booking number with its courier's service
    const number17 = b.forwarding_no ?? (b.courier?.track_via === "17track" ? b.awb : null);
    const via = number17 ? "17track" : b.courier?.trackcourier_slug && b.awb ? "trackcourier" : null;
    if (!via) { results.push({ id: b.id, error: "NO_TRACKABLE_NUMBER" }); continue; }
    if (stopped.has(via)) continue;

    const res = via === "17track" ? await checkTrack17(b, number17) : await checkTrackCourier(b);
    if ("error" in res && res.error) {
      results.push({ id: b.id, error: res.error });
      if (res.stop) stopped.add(via); // out of checks: stop instead of wasting calls
      continue;
    }
    const r = res as Result;
    const update: Record<string, unknown> = {
      status: r.status, status_detail: r.detail, last_location: r.location,
      checkpoints: r.checkpoints, last_checked_at: new Date().toISOString(),
    };
    if (r.status === "delivered") update.delivered_at = new Date().toISOString();
    // Ask Claude for a short customer update only when the status changed
    if (r.status !== b.status) {
      const text = await customerMessage(b, b.fwd?.name ?? b.courier?.name ?? "", number17 ?? b.awb, r);
      if (text) update.customer_message = text;
    }
    await admin.from("bookings").update(update).eq("id", b.id);
    results.push({ id: b.id, via, status: r.status, changed: r.status !== b.status });
  }

  return json({ checked: results.length, results });
});
