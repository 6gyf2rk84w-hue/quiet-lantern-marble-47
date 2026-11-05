// Panel Tracker: "invite" function. Lets the owner add a brand-new person from the app.
// It creates their account with a temporary password and gives them a role.
// Runs inside Supabase, so the master key never reaches anyone's phone.
// Only the owner (the account in the admins table) can use it.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const WORDS = [
  "tiger", "maple", "river", "cloud", "ember", "falcon", "harbor", "lemon", "mango", "orbit",
  "pepper", "quartz", "rocket", "sunny", "tango", "velvet", "willow", "zebra", "amber", "bison",
  "cactus", "dune", "echo", "fable", "glacier", "honey", "island", "jungle", "koala", "lunar",
  "meadow", "nectar", "olive", "panda", "raven", "saffron", "thunder", "umber", "violet", "walnut",
  "aspen", "breeze", "comet", "delta", "fern", "garnet", "hazel", "indigo", "jasper", "kiwi",
  "lagoon", "marble", "nova", "opal", "pine", "ripple", "sierra", "topaz", "upbeat", "vista",
];
function tempPassword(): string {
  const r = new Uint32Array(3);
  crypto.getRandomValues(r);
  const w = (n: number) => WORDS[n % WORDS.length];
  return `${w(r[0])}-${w(r[1])}-${String(1000 + (r[2] % 9000))}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !service) return json({ error: "Supabase settings are missing." }, 500);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Who is asking? Must be the owner.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: "Please sign in again." }, 401);
    const { data: own } = await admin.from("admins").select("user_id").eq("user_id", who.user.id).maybeSingle();
    if (!own) return json({ error: "Only the owner can add people." }, 403);

    // 2. Check what was sent
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const role = String(body?.role || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "That email doesn't look right." }, 400);
    if (!["mod", "user", "viewer"].includes(role)) return json({ error: "Pick Mod, User or Viewer." }, 400);

    // 3. Make the account (already confirmed, must pick a new password on first sign-in)
    const password = tempPassword();
    const { data: made, error: makeErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { must_change: true },
    });
    if (makeErr || !made?.user) {
      const msg = makeErr?.message || "Could not create the account.";
      return json({ error: /already|registered|exists/i.test(msg) ? "That email already has an account." : msg }, 400);
    }

    // 4. Give them their role
    const { error: memErr } = await admin.from("members").upsert({ user_id: made.user.id, email, role });
    if (memErr) {
      await admin.auth.admin.deleteUser(made.user.id);
      return json({ error: memErr.message }, 500);
    }
    return json({ email, password, role });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
