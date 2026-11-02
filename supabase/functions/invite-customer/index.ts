// Staff invite a customer to the portal: Supabase emails them a link to set their own password.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")!)["default"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: auth } = await admin.auth.getUser(token);
  const { data: staff } = auth.user
    ? await admin.from("staff").select("user_id").eq("user_id", auth.user.id).maybeSingle() : { data: null };
  if (!staff) return json({ error: "Not allowed" }, 401);

  const { customer_id, email, portal_url } = await req.json();
  if (!customer_id || !/^\S+@\S+\.\S+$/.test(email ?? "")) return json({ error: "Customer and a valid email are needed" }, 400);

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: portal_url });
  if (error) return json({ error: error.message }, 400);
  const { error: linkErr } = await admin.from("customer_users").upsert({ user_id: data.user.id, customer_id });
  if (linkErr) return json({ error: linkErr.message }, 500);
  await admin.from("customers").update({ email }).eq("id", customer_id).is("email", null);
  return json({ invited: true });
});
