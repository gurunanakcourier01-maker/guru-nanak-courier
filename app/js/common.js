// Shared helpers for the office app, customer portal and print pages.
export const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const inr = (n) => "₹" + Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const day = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";

export const STATUS = { booked: "Booked", in_transit: "In transit", out_for_delivery: "Out for delivery",
  delivery_failed: "Delivery failed", problem: "Problem", delivered: "Delivered", expired: "Not found" };
export const BASIS = { all_in: "All-in", gst_extra: "GST extra", fsc_gst_extra: "FSC + GST extra" };

export function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.append(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500);
}

// Throw on Supabase errors so callers can show one message
export async function q(promise) { const { data, error } = await promise; if (error) throw error; return data; }

// Chargeable weight: larger of actual and volumetric (L x W x H / 5000), rounded up to the next 0.5 kg
export function chargeable(actual, l, w, h) {
  const vol = l && w && h ? (l * w * h) / 5000 : 0;
  const kg = Math.max(Number(actual) || 0, vol);
  return kg ? Math.ceil(kg * 2) / 2 : 0;
}

export function trackLink(code) { return location.href.replace(/[^/]*(\?.*)?$/, "") + "track.html?c=" + code; }

export function waLink(phone, text) {
  const p = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return `https://wa.me/${p ? "91" + p : ""}?text=${encodeURIComponent(text)}`;
}

// GST split: same state as the business -> CGST + SGST, else IGST (unknown state -> CGST + SGST)
export function gstSplit(taxable, pct, companyState, customerState) {
  const tax = Math.round(taxable * pct) / 100;
  const inter = companyState && customerState && companyState.trim().toLowerCase() !== customerState.trim().toLowerCase();
  return inter ? { cgst: 0, sgst: 0, igst: tax, total: taxable + tax }
    : { cgst: Math.round(tax * 50) / 100, sgst: tax - Math.round(tax * 50) / 100, igst: 0, total: taxable + tax };
}

export async function login(form, errorEl) {
  const f = new FormData(form);
  const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("password") });
  errorEl.textContent = error ? "Wrong email or password." : "";
  return !error;
}
