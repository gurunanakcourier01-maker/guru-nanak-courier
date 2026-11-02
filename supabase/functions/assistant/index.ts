// AI assistant for the staff back office and the customer portal.
// Staff: quotes from every vendor (cost incl. FSC + GST), find/create bookings, customers, dues, tracking.
// Customers: only their own parcels, your own selling price list, and booking requests.
// Photos of documents (address labels, invoices, rate cards) are read by Claude directly.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"]);
const CLAUDE_KEY = Deno.env.get("Claude_key") ?? Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-5-5";

const STAFF_TOOLS = [
  { name: "get_quote", description: "Prices from every active vendor rate card for a parcel, cheapest first. total_cost includes fuel surcharge and GST; cost is the sheet price.",
    input_schema: { type: "object", properties: { country: { type: "string", description: "Full English country name, e.g. United States, United Kingdom, Canada" }, weight_kg: { type: "number" }, postcode: { type: "string" }, document: { type: "boolean" } }, required: ["country", "weight_kg"] } },
  { name: "find_bookings", description: "Search bookings by name, phone, tracking number or booking number; or list recent ones.",
    input_schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string", enum: ["booked", "in_transit", "out_for_delivery", "delivered", "problem", "delivery_failed"] }, unpaid_only: { type: "boolean" } } } },
  { name: "find_customers", description: "Search customers by name or phone.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "create_booking", description: "Save a new booking. Only call after the user has confirmed the details in this chat.",
    input_schema: { type: "object", properties: {
      customer_id: { type: "integer" }, sender_name: { type: "string" }, sender_phone: { type: "string" },
      receiver_name: { type: "string" }, receiver_phone: { type: "string" }, receiver_address: { type: "string" },
      receiver_city: { type: "string" }, dest_country: { type: "string" }, dest_postcode: { type: "string" },
      weight_kg: { type: "number" }, contents: { type: "string" }, declared_value: { type: "number" },
      rate_card_id: { type: "integer", description: "card_id from get_quote for the chosen service" },
      vendor_cost: { type: "number" }, amount: { type: "number", description: "Selling price to the customer before GST" } },
      required: ["sender_name", "receiver_name", "dest_country", "weight_kg"] } },
  { name: "dues", description: "Customers who owe money, with amounts.", input_schema: { type: "object", properties: {} } },
];
const CUSTOMER_TOOLS = [
  { name: "my_parcels", description: "The customer's own parcels with status and tracking.", input_schema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "our_price", description: "Guru Nanak Courier's selling price for a parcel (excluding GST).",
    input_schema: { type: "object", properties: { country: { type: "string" }, weight_kg: { type: "number" }, document: { type: "boolean" } }, required: ["country", "weight_kg"] } },
  { name: "request_booking", description: "Send a booking request to the Guru Nanak Courier team. Only after the customer confirms the details.",
    input_schema: { type: "object", properties: {
      sender_name: { type: "string" }, sender_phone: { type: "string" }, receiver_name: { type: "string" }, receiver_phone: { type: "string" },
      receiver_address: { type: "string" }, receiver_city: { type: "string" }, dest_country: { type: "string" }, dest_postcode: { type: "string" },
      weight_kg: { type: "number" }, contents: { type: "string" }, declared_value: { type: "number" } },
      required: ["sender_name", "receiver_name", "dest_country", "weight_kg"] } },
];

const BOOKING_FIELDS = "id, track_code, created_at, sender_name, receiver_name, receiver_phone, receiver_city, dest_country, weight_kg, awb, forwarding_no, status, status_detail, last_location, amount, paid, requested";

async function runTool(name: string, input: any, who: { staff: boolean; customerId: number | null; userId: string }) {
  if (who.staff) {
    if (name === "get_quote") {
      const { data, error } = await admin.rpc("quote", { p_country: input.country, p_weight: input.weight_kg, p_doc: !!input.document, p_postcode: input.postcode ?? null });
      if (error) return { error: error.message };
      const seen = new Set();   // one line per service (cheapest zone)
      return (data ?? []).filter((q: any) => !seen.has(q.card_id) && seen.add(q.card_id)).slice(0, 10)
        .map((q: any) => ({ card_id: q.card_id, vendor: q.vendor, service: q.service, zone: q.zone, cost: q.cost, total_cost: q.total_cost, basis: q.price_basis, your_price_list: q.is_my_price }));
    }
    if (name === "find_bookings") {
      let q = admin.from("bookings").select(BOOKING_FIELDS).order("created_at", { ascending: false }).limit(15);
      if (input.status) q = q.eq("status", input.status);
      if (input.unpaid_only) q = q.eq("paid", false);
      if (input.query) {
        const s = String(input.query).replace(/[,()]/g, " ").trim();
        q = /^\d+$/.test(s) ? q.or(`id.eq.${s},receiver_phone.ilike.%${s}%,sender_phone.ilike.%${s}%,awb.ilike.%${s}%`)
          : q.or(`receiver_name.ilike.%${s}%,sender_name.ilike.%${s}%,awb.ilike.%${s}%,forwarding_no.ilike.%${s}%,track_code.ilike.%${s}%`);
      }
      const { data, error } = await q; return error ? { error: error.message } : data;
    }
    if (name === "find_customers") {
      const s = String(input.query).replace(/[,()]/g, " ").trim();
      const { data, error } = await admin.from("customers").select("id, name, phone, email, city, state, kind").or(`name.ilike.%${s}%,phone.ilike.%${s}%`).limit(10);
      return error ? { error: error.message } : data;
    }
    if (name === "create_booking") {
      const row = { ...input, created_by: who.userId };
      delete row.weight_kg; row.weight_kg = input.weight_kg; row.chargeable_kg = input.weight_kg;
      const { data, error } = await admin.from("bookings").insert(row).select("id, track_code").single();
      return error ? { error: error.message } : { saved: true, booking_no: data.id, track_code: data.track_code };
    }
    if (name === "dues") {
      const { data, error } = await admin.from("invoices").select("number, total, paid, invoice_date, customers(name, phone)").order("invoice_date");
      if (error) return { error: error.message };
      return (data ?? []).filter((i: any) => Number(i.total) > Number(i.paid)).map((i: any) => ({ invoice: i.number, customer: i.customers?.name, phone: i.customers?.phone, due: Number(i.total) - Number(i.paid), date: i.invoice_date }));
    }
  } else if (who.customerId) {
    if (name === "my_parcels") {
      let q = admin.from("bookings").select("id, track_code, created_at, receiver_name, receiver_city, dest_country, weight_kg, status, status_detail, last_location, forwarding_no, requested")
        .eq("customer_id", who.customerId).order("created_at", { ascending: false }).limit(15);
      if (input.query) { const s = String(input.query).replace(/[,()]/g, " ").trim(); q = q.or(`receiver_name.ilike.%${s}%,track_code.ilike.%${s}%,forwarding_no.ilike.%${s}%`); }
      const { data, error } = await q; return error ? { error: error.message } : data;
    }
    if (name === "our_price") {
      const { data, error } = await admin.rpc("quote", { p_country: input.country, p_weight: input.weight_kg, p_doc: !!input.document, p_postcode: null });
      if (error) return { error: error.message };
      const mine = (data ?? []).filter((q: any) => q.is_my_price).map((q: any) => ({ service: q.service, price_before_gst: q.cost }));
      return mine.length ? mine : { note: "No published price for this; the team will quote it." };
    }
    if (name === "request_booking") {
      const { data, error } = await admin.from("bookings").insert({ ...input, customer_id: who.customerId, requested: true, created_by: who.userId, chargeable_kg: input.weight_kg })
        .select("id, track_code").single();
      return error ? { error: error.message } : { sent: true, request_no: data.id, track_code: data.track_code };
    }
  }
  return { error: "Not allowed" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!CLAUDE_KEY) return json({ error: "The Claude key is not set in Supabase secrets." }, 500);

  // Who is asking: staff member or portal customer
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth.user) return json({ error: "Please log in" }, 401);
  const [{ data: staff }, { data: cu }] = await Promise.all([
    admin.from("staff").select("user_id").eq("user_id", auth.user.id).maybeSingle(),
    admin.from("customer_users").select("customer_id").eq("user_id", auth.user.id).maybeSingle(),
  ]);
  const who = { staff: !!staff, customerId: cu?.customer_id ?? null, userId: auth.user.id };
  if (!who.staff && !who.customerId) return json({ error: "Not allowed" }, 403);

  // messages: [{ role, content }] where content is text or Claude content blocks (text + image)
  const { messages } = await req.json();
  if (!Array.isArray(messages) || !messages.length) return json({ error: "No message" }, 400);

  const system = who.staff
    ? "You are the assistant inside Guru Nanak Courier Services' office software (India, international courier booking counter). " +
      "Help staff with quotes, bookings, customers, dues and tracking using the tools. Prices are in Indian rupees. " +
      "For quotes, show the 3-5 cheapest services with vendor, service, sheet cost and total_cost (incl. fuel surcharge and GST). " +
      "If a photo or scan is attached (address label, ID, invoice, handwritten note), read it and fill booking details from it. " +
      "Before create_booking, list the details and ask the user to confirm. Never invent prices, numbers or statuses. " +
      "Reply in the user's language (English, Hindi or Punjabi), short and clear."
    : "You are the customer assistant of Guru Nanak Courier Services (India, international courier). " +
      "Help the customer track their own parcels, give prices from our_price only (never mention vendors or costs), and send booking requests. " +
      "If a photo is attached, read the address or document details from it. Confirm details before request_booking. " +
      "Never invent prices or statuses. Reply in the customer's language, short and friendly.";

  const claude = new Anthropic({ apiKey: CLAUDE_KEY });
  const convo = messages.slice(-20);
  const actions: string[] = [];
  for (let turn = 0; turn < 6; turn++) {
    const res = await claude.messages.create({
      model: MODEL, max_tokens: 4000, system, messages: convo,
      tools: who.staff ? STAFF_TOOLS : CUSTOMER_TOOLS,
    } as any).catch((e) => ({ error: String(e?.message ?? e) }) as any);
    if (res.error) return json({ error: res.error }, 502);
    convo.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((b: any) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !calls.length) {
      const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return json({ reply: text || "Done.", actions });
    }
    const results = [];
    for (const c of calls) {
      const out = await runTool(c.name, c.input ?? {}, who);
      actions.push(c.name);
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 12000), is_error: !!(out as any)?.error });
    }
    convo.push({ role: "user", content: results });
  }
  return json({ reply: "Sorry, that took too many steps. Please ask in a simpler way.", actions });
});
