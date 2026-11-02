// Staff back office: dashboard, bookings, quotes, customers, billing, vendors, settings.
import { sb, $, $$, esc, inr, day, STATUS, BASIS, toast, q, chargeable, trackLink, waLink, gstSplit, login } from "./common.js";
import { mountChat } from "./chat.js";

let couriers = [], customers = [], company = {}, bookings = [], filter = "all";
const FILTERS = [["all", "All"], ["requests", "Requests"], ["in_transit", "In transit"], ["out_for_delivery", "Out for delivery"],
  ["problem", "Problems"], ["delivered", "Delivered"], ["unbilled", "Not billed"], ["unpaid", "Unpaid"]];
const courierName = (id) => couriers.find((c) => c.id === id)?.name ?? "";
const custName = (id) => customers.find((c) => c.id === id)?.name ?? "";

// ---------- navigation ----------
function show(view) {
  $$("nav.side button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $$("main [data-view]").forEach((s) => (s.hidden = s.dataset.view !== view));
  ({ dashboard: loadDashboard, bookings: loadBookings, customers: loadCustomers, billing: loadBilling, vendors: loadVendors, settings: loadSettings })[view]?.();
  window.scrollTo(0, 0);
}
$$("nav.side button").forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------- start ----------
async function start(user) {
  const { data: staff } = await sb.from("staff").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!staff) { $("#login").hidden = false; $("#loginError").textContent = "This login is not on the staff list. Customers use the portal."; return; }
  $("#login").hidden = true; $("#app").hidden = false; $("#logout").hidden = false; $("#who").textContent = " · " + user.email;
  [couriers, customers, company] = await Promise.all([
    q(sb.from("couriers").select("*").order("name")),
    q(sb.from("customers").select("*").order("name")),
    q(sb.from("company").select("*").eq("id", 1).single()),
  ]);
  const opts = (list) => list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#courierSelect").innerHTML = `<option value="">Choose…</option>` + opts(couriers);
  $("#fwdSelect").innerHTML = `<option value="">None yet</option>` + opts(couriers.filter((c) => c.track_via === "17track"));
  fillCustomerList();
  $("#countryList").innerHTML = (await q(sb.rpc("rate_countries"))).map((c) => `<option value="${esc(c)}">`).join("");
  mountChat("Hi! Ask me for a quote (\"price for 5 kg to Toronto M5V\"), find a booking, who owes money, or scan an address label with 📷.");
  document.addEventListener("bookings-changed", () => { loadDashboard(); loadBookings(); });
  show("dashboard");
}
const fillCustomerList = () => ($("#customerList").innerHTML = customers.map((c) => `<option value="${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}">`).join(""));

$("#loginForm").onsubmit = async (e) => { e.preventDefault(); if (await login(e.target, $("#loginError"))) start((await sb.auth.getUser()).data.user); };
$("#logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
sb.auth.getSession().then(({ data }) => (data.session ? start(data.session.user) : ($("#login").hidden = false)));

// ---------- dashboard ----------
async function loadDashboard() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const month = new Date(today.getFullYear(), today.getMonth(), 1);
  const [all, invoices, pays, opening] = await Promise.all([
    q(sb.from("bookings").select("id, created_at, status, requested, invoice_id, amount, paid, imported, receiver_name, dest_country, receiver_city").order("created_at", { ascending: false }).limit(1000)),
    q(sb.from("invoices").select("total")), q(sb.from("payments").select("amount")), q(sb.from("customers").select("opening_balance").neq("opening_balance", 0)),
  ]);
  const n = (f) => all.filter(f).length;
  const sum = (list, k) => list.reduce((s, x) => s + Number(x[k] ?? 0), 0);
  const due = sum(opening, "opening_balance") + sum(invoices, "total") - sum(pays, "amount");
  const stat = (label, value, view) => `<button class="stat" data-go="${view ?? ""}"><small>${label}</small><b>${value}</b></button>`;
  $("#stats").innerHTML =
    stat("Booked today", n((b) => new Date(b.created_at) >= today), "bookings") +
    stat("This month", n((b) => new Date(b.created_at) >= month), "bookings") +
    stat("In transit", n((b) => b.status === "in_transit" || b.status === "out_for_delivery"), "bookings") +
    stat("Problems", n((b) => b.status === "problem" || b.status === "delivery_failed"), "bookings") +
    stat("Customer requests", n((b) => b.requested), "bookings") +
    stat("Not billed", n((b) => !b.invoice_id && !b.requested && !b.imported && b.amount != null), "billing") +
    stat("Money due", inr(due), "billing") +
    stat("Billed this month", inr(all.filter((b) => new Date(b.created_at) >= month && b.invoice_id).reduce((s, b) => s + Number(b.amount ?? 0), 0)), "billing");
  $$("#stats [data-go]").forEach((b) => (b.onclick = () => b.dataset.go && show(b.dataset.go)));
  $("#dashList").innerHTML = all.slice(0, 8).map((b) => `<div class="line"><span>#${b.id} ${esc(b.receiver_name)} · ${esc(b.receiver_city || b.dest_country || "")}</span><span class="badge s-${b.status}">${STATUS[b.status] ?? b.status}</span></div>`).join("") || `<p class="muted">No bookings yet.</p>`;
  const reqs = n((b) => b.requested); $("#reqBadge").hidden = !reqs; $("#reqBadge").textContent = reqs;
  // Monday FSC reminder: shows from Monday until "Done for this week" is pressed
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const week = monday.toISOString().slice(0, 10);
  let doneWeek = null; try { doneWeek = localStorage.getItem("fscDoneWeek"); } catch {}
  $("#fscNote").hidden = doneWeek === week;
  $("#fscDone").onclick = () => { try { localStorage.setItem("fscDoneWeek", week); } catch {} $("#fscNote").hidden = true; };
}

// ---------- bookings ----------
async function loadBookings() {
  bookings = await q(sb.from("bookings").select("*").order("created_at", { ascending: false }).limit(500));
  renderBookings();
}
function renderBookings() {
  const s = $("#search").value.trim().toLowerCase();
  const match = { all: () => true, requests: (b) => b.requested, unbilled: (b) => !b.invoice_id && !b.requested && !b.imported, unpaid: (b) => !b.paid,
    problem: (b) => b.status === "problem" || b.status === "delivery_failed" };
  const count = (k) => bookings.filter(match[k] ?? ((b) => b.status === k)).length;
  $("#chips").innerHTML = FILTERS.map(([k, l]) => `<button data-f="${k}" class="${filter === k ? "on" : ""}">${l} <b>${count(k)}</b></button>`).join("");
  const shown = bookings.filter(match[filter] ?? ((b) => b.status === filter)).filter((b) => !s ||
    [b.id, b.receiver_name, b.sender_name, b.receiver_phone, b.sender_phone, b.awb, b.forwarding_no, b.track_code].some((v) => String(v ?? "").toLowerCase().includes(s)));
  $("#list").innerHTML = shown.map((b) => `
    <article>
      <div class="top"><span>#${b.id} · ${day(b.created_at)} · ${esc(courierName(b.courier_id) || "—")}${b.requested ? ` · <b class="pill">Customer request</b>` : ""}${b.imported ? ` · <span class="badge">Past record</span>` : ""}</span>
        <span class="badge s-${b.status}">${STATUS[b.status] ?? esc(b.status)}</span></div>
      <h3>${esc(b.receiver_name)} <small>${esc([b.receiver_city, b.dest_country].filter(Boolean).join(", "))}</small></h3>
      <p class="muted">From ${esc(b.sender_name)}${b.customer_id ? ` (${esc(custName(b.customer_id))})` : ""} · ${b.chargeable_kg ?? b.weight_kg ?? "?"} kg
        · AWB ${esc(b.awb ?? "–")}${b.forwarding_no ? ` · ${esc(courierName(b.forwarding_courier_id) || "Fwd")} ${esc(b.forwarding_no)}` : ""}
        ${b.amount != null ? ` · ${inr(b.amount)} + GST` : ""}${b.vendor_cost != null ? ` · cost ${inr(b.vendor_cost)}` : ""}</p>
      ${b.last_location ? `<p class="muted">${esc(b.status_detail)} · ${esc(b.last_location)}</p>` : ""}
      ${b.customer_message ? `<p class="msg">${esc(b.customer_message)}</p>` : ""}
      <div class="actions">
        ${b.requested ? `<button data-act="approve" data-id="${b.id}" class="primary-sm">Approve request</button>` : ""}
        <button data-act="check" data-id="${b.id}">Check now</button>
        <button data-act="site" data-id="${b.id}">Track</button>
        <a class="btn" href="${waLink(b.receiver_phone, (b.customer_message ?? `Hello ${b.receiver_name}, your parcel #${b.id} is booked with Guru Nanak Courier.`) + `\nTrack: ${trackLink(b.track_code)}`)}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="btn" href="print.html?label=${b.id}" target="_blank">Label</a>
        ${b.invoice_id ? `<a class="btn" href="print.html?invoice=${b.invoice_id}" target="_blank">Invoice</a>` : b.imported ? "" : `<button data-act="bill" data-id="${b.id}">Bill now</button>`}
        <button data-act="paid" data-id="${b.id}" class="${b.paid ? "paid" : "due"}">${b.paid ? "Paid" : "Mark paid"}</button>
      </div>
    </article>`).join("") || `<p class="muted center">Nothing here.</p>`;
}
$("#chips").onclick = (e) => { const b = e.target.closest("button"); if (b) { filter = b.dataset.f; renderBookings(); } };
$("#search").oninput = renderBookings;
$("#list").onclick = async (e) => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const b = bookings.find((x) => x.id === Number(btn.dataset.id));
  try {
    if (btn.dataset.act === "approve") { await q(sb.from("bookings").update({ requested: false }).eq("id", b.id)); toast("Request approved. Add AWB and price when booked."); }
    if (btn.dataset.act === "check") {
      btn.textContent = "Checking…";
      const { data, error } = await sb.functions.invoke("track", { body: { booking_id: b.id } }); if (error) throw error;
      toast(data.results?.[0]?.error ? "Tracking: " + data.results[0].error : "Status updated");
    }
    if (btn.dataset.act === "site") {
      const num = b.forwarding_no ?? b.awb; const c = couriers.find((x) => x.id === b.courier_id);
      if (b.forwarding_no || c?.track_via === "17track") return window.open("https://t.17track.net/en#nums=" + encodeURIComponent(num ?? ""), "_blank", "noopener");
      if (num) await navigator.clipboard?.writeText(num).catch(() => {});
      toast("Tracking number copied"); if (c?.tracking_url) window.open(c.tracking_url, "_blank", "noopener"); return;
    }
    if (btn.dataset.act === "bill") {
      if (b.amount == null) return toast("Add the selling price to this booking first");
      const inv = await createInvoice(b.customer_id, [b]); window.open("print.html?invoice=" + inv.id, "_blank"); toast("Invoice " + inv.number + " created");
    }
    if (btn.dataset.act === "paid") await q(sb.from("bookings").update({ paid: !b.paid }).eq("id", b.id));
    await loadBookings();
  } catch (err) { toast("Couldn't do that: " + err.message); renderBookings(); }
};
$("#checkAll").onclick = async (e) => {
  e.target.textContent = "Checking…";
  try { const { data, error } = await sb.functions.invoke("track", { body: {} }); if (error) throw error; toast(`Checked ${data.checked} parcels`); await loadBookings(); }
  catch (err) { toast("Check failed: " + err.message); }
  e.target.textContent = "Check all active parcels now";
};
$("#labelsA4").onclick = () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ids = bookings.filter((b) => !b.imported && !b.requested && new Date(b.created_at) >= today).map((b) => b.id);
  if (!ids.length) return toast("No bookings made today yet");
  open("print.html?labels=" + ids.join(","), "_blank");
};

// ---------- new booking ----------
const bf = $("#bookingForm");
function findCustomer(text) {
  const t = text.split(" · ")[0].trim().toLowerCase();
  return customers.find((c) => c.name.toLowerCase() === t || (c.phone && text.includes(c.phone)));
}
bf.customer.onchange = () => {
  const c = findCustomer(bf.customer.value);
  if (c) { bf.sender_name.value = c.name; bf.sender_phone.value = c.phone ?? ""; }
  else if (!bf.sender_name.value) bf.sender_name.value = bf.customer.value;
};
const updateChargeable = () => {
  const kg = chargeable(bf.weight_kg.value, +bf.length_cm.value, +bf.width_cm.value, +bf.height_cm.value);
  $("#chargeable").textContent = kg ? kg + " kg" : "–"; return kg;
};
["weight_kg", "length_cm", "width_cm", "height_cm"].forEach((n) => (bf[n].oninput = updateChargeable));
const updateMargin = () => {
  const price = +bf.amount.value, cost = +bf.vendor_cost.value;
  $("#margin").textContent = price && cost ? `Approx. margin: ${inr(price - cost / 1.18)} (your price minus vendor cost before GST)` : "";
};
bf.amount.oninput = bf.vendor_cost.oninput = updateMargin;
$("#findPrices").onclick = async () => {
  const kg = updateChargeable();
  if (!bf.dest_country.value || !kg) return toast("Enter the country and weight first");
  $("#priceOptions").innerHTML = `<p class="muted">Checking all rate cards…</p>`;
  try {
    const rows = await q(sb.rpc("quote", { p_country: bf.dest_country.value.trim(), p_weight: kg, p_doc: bf.doc.checked, p_postcode: bf.dest_postcode.value.trim() || null }));
    const seen = new Set(); const best = rows.filter((r) => !seen.has(r.card_id) && seen.add(r.card_id)).slice(0, 8);
    $("#priceOptions").innerHTML = best.length ? best.map((r, i) => `
      <label class="option"><input type="radio" name="pick" value="${i}">
        <span><b>${inr(r.total_cost)}</b> ${esc(r.vendor)} · ${esc(r.service)}${r.zone ? " · " + esc(r.zone) : ""}
        <small class="muted">sheet ${inr(r.cost)} · ${BASIS[r.price_basis]}${r.price_basis === "fsc_gst_extra" && !Number(r.fsc_pct) ? " · FSC % not set" : ""}</small></span></label>`).join("")
      : `<p class="muted">No rate card covers this yet.</p>`;
    $$("#priceOptions input").forEach((inp) => (inp.onchange = () => {
      const r = best[inp.value];
      bf.rate_card_id.value = r.card_id; bf.vendor_cost.value = r.total_cost;
      const c = couriers.find((x) => r.vendor.toLowerCase().includes(x.name.toLowerCase().split(" ")[0]));
      if (c) bf.courier_id.value = c.id;
      updateMargin();
    }));
  } catch (err) { $("#priceOptions").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
};
bf.onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(bf));
  try {
    let cust = findCustomer(f.customer);
    if (!cust) {
      cust = await q(sb.from("customers").insert({ name: f.sender_name || f.customer, phone: f.sender_phone || null }).select().single());
      customers.push(cust); fillCustomerList();
    }
    const num = (v) => (v === "" || v == null ? null : Number(v));
    await q(sb.from("bookings").insert({
      customer_id: cust.id, sender_name: f.sender_name, sender_phone: f.sender_phone || null,
      receiver_name: f.receiver_name, receiver_phone: f.receiver_phone || null, receiver_address: f.receiver_address || null,
      receiver_city: f.receiver_city || null, receiver_pincode: f.dest_postcode || null, dest_postcode: f.dest_postcode || null, dest_country: f.dest_country,
      weight_kg: num(f.weight_kg), pieces: num(f.pieces) ?? 1, length_cm: num(f.length_cm), width_cm: num(f.width_cm), height_cm: num(f.height_cm),
      chargeable_kg: updateChargeable() || num(f.weight_kg), contents: f.contents || null, declared_value: num(f.declared_value),
      courier_id: num(f.courier_id), awb: f.awb.trim().toUpperCase() || null,
      forwarding_courier_id: num(f.forwarding_courier_id), forwarding_no: f.forwarding_no.trim().toUpperCase() || null,
      rate_card_id: num(f.rate_card_id), vendor_cost: num(f.vendor_cost), amount: num(f.amount), paid: !!f.paid,
    }));
    bf.reset(); $("#priceOptions").innerHTML = ""; $("#chargeable").textContent = "–"; $("#margin").textContent = "";
    toast("Booking saved"); show("bookings");
  } catch (err) { toast("Couldn't save: " + err.message); }
};

// ---------- quote ----------
$("#quote").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), country = f.get("country").trim(), weight = Number(f.get("weight"));
  $("#quoteOut").innerHTML = `<p class="muted center">Checking all rate cards…</p>`;
  try {
    const cards = [];
    for (const r of await q(sb.rpc("quote", { p_country: country, p_weight: weight, p_doc: !!f.get("doc"), p_postcode: f.get("postcode").trim() || null }))) {
      const c = cards.find((x) => x.card_id === r.card_id);
      if (c) { c.max = Math.max(c.max, r.total_cost); c.zones++; } else cards.push({ ...r, max: r.total_cost, zones: 1 });
    }
    $("#quoteOut").innerHTML = cards.length ? `<p class="muted">${cards.length} services for ${esc(country)}, ${weight} kg · cheapest first · your cost incl. FSC + GST</p>` +
      cards.map((r, i) => `
        <article class="${r.is_my_price ? "mine" : ""}">
          <div class="top"><span>${esc(r.vendor)}${r.zones === 1 && r.zone ? " · " + esc(r.zone) : ""}</span><span class="badge ${r.price_basis === "all_in" ? "s-delivered" : "s-booked"}">${BASIS[r.price_basis]}</span></div>
          <h3>${inr(r.total_cost)}${r.max > r.total_cost ? " – " + inr(r.max) : ""} ${i === 0 ? "<small>cheapest</small>" : ""}${r.is_my_price ? "<small>your customer price list</small>" : ""}</h3>
          <p class="muted">${esc(r.service)} · sheet price ${inr(r.cost)}${Number(r.fsc_pct) ? ` · FSC ${r.fsc_pct}%` : r.price_basis === "fsc_gst_extra" ? " · <b>FSC % not set</b> (Vendors page)" : ""}${r.gst_included ? " · GST included" : " · + 18% GST"}${r.zones > 1 ? ` · ${r.zones} postcode zones (add postcode for exact)` : ""}</p>
        </article>`).join("")
      : `<p class="muted center">No rate card covers ${esc(country)} at ${weight} kg yet.</p>`;
  } catch (err) { $("#quoteOut").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
};

// ---------- invoices & payments ----------
async function createInvoice(customerId, items) {
  const cust = customers.find((c) => c.id === customerId);
  const taxable = items.reduce((s, b) => s + Number(b.amount ?? 0), 0);
  const g = gstSplit(taxable, Number(company.default_gst_pct ?? 18), company.state, cust?.state);
  const number = await q(sb.rpc("next_invoice_number"));
  const inv = await q(sb.from("invoices").insert({ number, customer_id: customerId ?? null, taxable, cgst: g.cgst, sgst: g.sgst, igst: g.igst, total: Math.round(g.total * 100) / 100 }).select().single());
  await q(sb.from("bookings").update({ invoice_id: inv.id }).in("id", items.map((b) => b.id)));
  return inv;
}
async function recordPayment(inv, amount, mode, reference) {
  await q(sb.from("payments").insert({ customer_id: inv.customer_id, invoice_id: inv.id, amount, mode, reference: reference || null }));
  const paid = Number(inv.paid) + amount;
  await q(sb.from("invoices").update({ paid }).eq("id", inv.id));
  if (paid >= Number(inv.total) - 0.5) await q(sb.from("bookings").update({ paid: true }).eq("invoice_id", inv.id));
}

async function loadBilling() {
  const [unbilled, invoices] = await Promise.all([
    q(sb.from("bookings").select("id, customer_id, sender_name, receiver_name, dest_country, amount, created_at").is("invoice_id", null).eq("requested", false).eq("imported", false).not("amount", "is", null).order("created_at")),
    q(sb.from("invoices").select("*").order("invoice_date", { ascending: false }).limit(300)),
  ]);
  const now = Date.now(), ageDays = (d) => (now - new Date(d)) / 864e5;
  const open = invoices.filter((i) => Number(i.total) - Number(i.paid) > 0.5);
  const bucket = (lo, hi) => open.filter((i) => ageDays(i.invoice_date) >= lo && ageDays(i.invoice_date) < hi).reduce((s, i) => s + Number(i.total) - Number(i.paid), 0);
  const [opening, loosePays] = await Promise.all([q(sb.from("customers").select("opening_balance").neq("opening_balance", 0)), q(sb.from("payments").select("amount").is("invoice_id", null))]);
  const openingDue = opening.reduce((s, c) => s + Number(c.opening_balance), 0) - loosePays.reduce((s, p) => s + Number(p.amount), 0);
  $("#dueStats").innerHTML = [["Total due", bucket(0, 1e9) + openingDue], ["Opening balances (net)", openingDue], ["0–30 days", bucket(0, 31)], ["31–60 days", bucket(31, 61)], ["61–90 days", bucket(61, 91)], ["90+ days", bucket(91, 1e9)]]
    .map(([l, v]) => `<div class="stat"><small>${l}</small><b>${inr(v)}</b></div>`).join("");

  const groups = {};
  unbilled.forEach((b) => (groups[b.customer_id ?? "cash"] ??= []).push(b));
  $("#unbilled").innerHTML = Object.entries(groups).map(([cid, items]) => `
    <article><div class="top"><span>${esc(cid === "cash" ? "Walk-in (no customer)" : custName(Number(cid)))}</span><span>${items.length} bookings · ${inr(items.reduce((s, b) => s + Number(b.amount), 0))} + GST</span></div>
      <p class="muted">${items.map((b) => `#${b.id} ${esc(b.receiver_name)}`).join(", ")}</p>
      <div class="actions"><button data-bill="${cid}">Create one invoice for these</button></div></article>`).join("") || `<p class="muted">Everything is billed.</p>`;
  $$("#unbilled [data-bill]").forEach((btn) => (btn.onclick = async () => {
    try { const cid = btn.dataset.bill; const inv = await createInvoice(cid === "cash" ? null : Number(cid), groups[cid]); window.open("print.html?invoice=" + inv.id, "_blank"); loadBilling(); }
    catch (err) { toast("Couldn't bill: " + err.message); }
  }));

  $("#invoiceList").innerHTML = invoices.map((i) => {
    const due = Number(i.total) - Number(i.paid);
    return `<article><div class="top"><span>${esc(i.number)} · ${day(i.invoice_date)}</span><span class="badge ${due > 0.5 ? "s-problem" : "s-delivered"}">${due > 0.5 ? "Due " + inr(due) : "Paid"}</span></div>
      <h3>${inr(i.total)} <small>${esc(custName(i.customer_id) || "Walk-in")}</small></h3>
      <div class="actions"><a class="btn" href="print.html?invoice=${i.id}" target="_blank">Print / PDF</a>
        ${due > 0.5 ? `<button data-pay="${i.id}">Record payment</button>` : ""}</div></article>`;
  }).join("") || `<p class="muted">No invoices yet.</p>`;
  $$("#invoiceList [data-pay]").forEach((btn) => (btn.onclick = async () => {
    const inv = invoices.find((x) => x.id === Number(btn.dataset.pay));
    const amt = Number(prompt(`Amount received for ${inv.number} (due ${inr(inv.total - inv.paid)})`, (inv.total - inv.paid).toFixed(2)));
    if (!amt) return;
    const mode = prompt("Paid by: cash, UPI, bank or cheque?", "UPI") || "cash";
    try { await recordPayment(inv, amt, mode.toLowerCase(), prompt("Reference (optional, e.g. UPI ref no.)") || ""); toast("Payment saved"); loadBilling(); }
    catch (err) { toast("Couldn't save: " + err.message); }
  }));
}

// ---------- customers ----------
async function loadCustomers() {
  const [list, invoices, pays] = await Promise.all([q(sb.from("customers").select("*").order("name")),
    q(sb.from("invoices").select("customer_id, total")), q(sb.from("payments").select("customer_id, amount"))]);
  customers = list; fillCustomerList();
  // balance = opening balance + everything billed - everything received
  const due = {};
  list.forEach((c) => (due[c.id] = Number(c.opening_balance ?? 0)));
  invoices.forEach((i) => (due[i.customer_id] = (due[i.customer_id] ?? 0) + Number(i.total)));
  pays.forEach((p) => (due[p.customer_id] = (due[p.customer_id] ?? 0) - Number(p.amount)));
  const s = $("#custSearch").value.trim().toLowerCase();
  $("#custList").innerHTML = list.filter((c) => !s || [c.name, c.phone, c.email].some((v) => String(v ?? "").toLowerCase().includes(s))).map((c) => `
    <article><div class="top"><span>${c.kind === "account" ? "Account" : "Cash"} customer${c.gstin ? " · GSTIN " + esc(c.gstin) : ""}</span>
      <span class="badge ${due[c.id] > 0.5 ? "s-problem" : "s-delivered"}">${due[c.id] > 0.5 ? "Owes " + inr(due[c.id]) : "No dues"}</span></div>
      <h3>${esc(c.name)} <small>${esc([c.city, c.state].filter(Boolean).join(", "))}</small></h3>
      <p class="muted">${esc(c.phone ?? "")} ${esc(c.email ?? "")}</p>
      ${Number(c.opening_balance) ? `<p class="muted">Opening balance ${inr(c.opening_balance)}</p>` : ""}
      <div class="actions"><button data-edit="${c.id}">Edit</button><button data-open="${c.id}">Opening balance</button>
        <button data-receive="${c.id}">Receive payment</button><button data-invite="${c.id}">Invite to portal</button>
        ${c.phone && due[c.id] > 0.5 ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone, `Namaste ${c.name}, a friendly reminder: ${inr(due[c.id])} is due to Guru Nanak Courier Services. Thank you!`)}">WhatsApp reminder</a>` : ""}</div></article>`).join("") || `<p class="muted">No customers yet. They are also added automatically from new bookings.</p>`;
}
$("#custSearch").oninput = loadCustomers;
$("#custNew").onclick = () => { $("#custForm").reset(); $("#custForm").cid.value = ""; $("#custForm").hidden = false; };
$("#custCancel").onclick = () => ($("#custForm").hidden = true);
$("#custList").onclick = async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) {
    const c = customers.find((x) => x.id === Number(b.dataset.edit)), f = $("#custForm");
    Object.entries(c).forEach(([k, v]) => k !== "id" && f[k]?.name === k && (f[k].value = v ?? "")); f.cid.value = c.id; f.hidden = false; window.scrollTo(0, 0);
  }
  if (b.dataset.open) {
    const c = customers.find((x) => x.id === Number(b.dataset.open));
    const v = prompt(`Amount ${c.name} owed you before using this app (₹)`, c.opening_balance ?? 0); if (v === null) return;
    try { await q(sb.from("customers").update({ opening_balance: Number(v) || 0 }).eq("id", c.id)); toast("Opening balance saved"); loadCustomers(); }
    catch (err) { toast("Couldn't save: " + err.message); }
  }
  if (b.dataset.receive) {
    const c = customers.find((x) => x.id === Number(b.dataset.receive));
    const amt = Number(prompt(`Amount received from ${c.name} (₹)`)); if (!amt) return;
    const mode = prompt("Paid by: cash, UPI, bank or cheque?", "UPI") || "cash";
    try { await q(sb.from("payments").insert({ customer_id: c.id, amount: amt, mode: mode.toLowerCase(), reference: prompt("Reference (optional)") || null })); toast("Payment saved"); loadCustomers(); }
    catch (err) { toast("Couldn't save: " + err.message); }
  }
  if (b.dataset.invite) {
    const c = customers.find((x) => x.id === Number(b.dataset.invite));
    const email = prompt(`Email to invite ${c.name} to the customer portal`, c.email ?? ""); if (!email) return;
    const { data, error } = await sb.functions.invoke("invite-customer", { body: { customer_id: c.id, email, portal_url: location.href.replace(/[^/]*(\?.*)?$/, "") + "portal.html" } });
    toast(error || data?.error ? "Invite failed: " + (data?.error ?? error.message) : `Invite email sent to ${email}`);
  }
};
$("#custForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target)); const id = f.cid; delete f.cid;
  Object.keys(f).forEach((k) => f[k] === "" && (f[k] = null));
  try { await q(id ? sb.from("customers").update(f).eq("id", id) : sb.from("customers").insert(f)); e.target.hidden = true; toast("Customer saved"); loadCustomers(); }
  catch (err) { toast("Couldn't save: " + err.message); }
};

// ---------- vendors ----------
let cards = [];
async function loadVendors() {
  cards = await q(sb.from("rate_cards").select("id, vendor, service, source_file, effective_from, price_basis, fsc_pct, gst_included, active, is_my_price, notes").order("vendor").order("service"));
  renderVendors();
}
function renderVendors() {
  const s = $("#vendorSearch").value.trim().toLowerCase();
  $("#vendorList").innerHTML = `<table class="grid"><thead><tr><th>Vendor · service</th><th>Price basis</th><th>FSC %</th><th>GST inside</th><th>Use</th></tr></thead><tbody>` +
    cards.filter((c) => !s || (c.vendor + " " + c.service).toLowerCase().includes(s)).map((c) => `
      <tr class="${c.active ? "" : "off"}"><td><b>${esc(c.vendor)}</b><br><small>${esc(c.service)} · ${esc(c.source_file)}${c.notes?.includes("HIDDEN") ? " · <span class='error'>prices clash, check sheet</span>" : ""}</small></td>
        <td>${BASIS[c.price_basis]}</td>
        <td><input type="number" step="0.01" min="0" value="${c.fsc_pct}" data-id="${c.id}" data-k="fsc_pct" class="small"></td>
        <td><input type="checkbox" ${c.gst_included ? "checked" : ""} data-id="${c.id}" data-k="gst_included"></td>
        <td><input type="checkbox" ${c.active ? "checked" : ""} data-id="${c.id}" data-k="active"></td></tr>`).join("") + `</tbody></table>`;
}
$("#vendorSearch").oninput = renderVendors;
$("#vendorList").onchange = async (e) => {
  const el = e.target; if (!el.dataset.id) return;
  const val = el.type === "checkbox" ? el.checked : Number(el.value);
  try { await q(sb.from("rate_cards").update({ [el.dataset.k]: val }).eq("id", el.dataset.id)); cards.find((c) => c.id === Number(el.dataset.id))[el.dataset.k] = val; toast("Saved"); }
  catch (err) { toast("Couldn't save: " + err.message); }
};

// ---------- settings ----------
async function loadSettings() {
  company = await q(sb.from("company").select("*").eq("id", 1).single());
  const f = $("#settingsForm"); Object.entries(company).forEach(([k, v]) => f[k]?.name === k && (f[k].value = v ?? ""));
  $("#voiceLang").value = localStorage.getItem("voiceLang") || "en-IN";
}
$("#voiceLang").onchange = (e) => localStorage.setItem("voiceLang", e.target.value);
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  Object.keys(f).forEach((k) => f[k] === "" && (f[k] = null));
  try { company = await q(sb.from("company").update(f).eq("id", 1).select().single()); toast("Settings saved"); }
  catch (err) { toast("Couldn't save: " + err.message); }
};
