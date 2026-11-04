// Panel Tracker: secure bridge between the app and your SMM panels.
// Your API keys live in Supabase secrets and never reach anyone's phone.
// Only the owner (the account in the admins table) can use this function.
import { createClient } from "npm:@supabase/supabase-js@2";

// Known panels. The app can only reach these sites, nothing else.
const PANELS: Record<string, { url: string; secret: string }> = {
  "naizop.com":           { url: "https://naizop.com/api/v2",           secret: "NAIZOP_KEY" },
  "peakerr.com":          { url: "https://peakerr.com/api/v2",          secret: "PEAKERR_KEY" },
  "smbpanel.net":         { url: "https://smbpanel.net/api/v2",         secret: "SMBPANEL_KEY" },
  "justanotherpanel.com": { url: "https://justanotherpanel.com/api/v2", secret: "JAP_KEY" },
  "morethanpanel.com":    { url: "https://morethanpanel.com/api/v2",    secret: "MTP_KEY" },
  "bulkfollows.com":      { url: "https://bulkfollows.com/api/v2",      secret: "BULKFOLLOWS_KEY" },
  "smmfollows.com":       { url: "https://smmfollows.com/api/v2",       secret: "SMMFOLLOWS_KEY" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function panelFor(site: string) {
  const d = String(site || "").toLowerCase().trim()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return { domain: d, cfg: PANELS[d] };
}

function publishableKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const k = keys["default"] || Object.values(keys)[0];
    if (k) return String(k);
  } catch (_) { /* fall through */ }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}

async function callPanel(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (_) { return { error: "Panel sent an unexpected reply (HTTP " + res.status + "): " + text.slice(0, 160) }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);

  // 1. Who is calling? Must be signed in.
  const auth = req.headers.get("Authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, publishableKey(), {
    global: { headers: { Authorization: auth } },
  });
  const { data: u, error: ue } = await sb.auth.getUser();
  if (ue || !u?.user) return reply({ error: "Not signed in" }, 401);

  // 2. Must be the owner.
  const { data: adm } = await sb.from("admins").select("user_id").eq("user_id", u.user.id);
  if (!adm || !adm.length) return reply({ error: "Only the owner can do this" }, 403);

  // 3. Which panel, and is its key set up?
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { return reply({ error: "Bad request" }, 400); }
  const { domain, cfg } = panelFor(String(body.site || ""));
  if (!cfg) return reply({ error: domain + " is not a connected panel" }, 400);
  const key = Deno.env.get(cfg.secret);
  if (!key) return reply({ error: "No API key saved for " + domain + ". Add the secret " + cfg.secret + " in Supabase." }, 400);

  const action = String(body.action || "");
  try {
    if (action === "balance") {
      return reply(await callPanel(cfg.url, { key, action: "balance" }));
    }
    if (action === "status") {
      const order = String(body.order || "").trim();
      if (!/^\d+$/.test(order)) return reply({ error: "Order ID must be a number" }, 400);
      return reply(await callPanel(cfg.url, { key, action: "status", order }));
    }
    if (action === "service") {
      const service = String(body.service || "").trim();
      const list = await callPanel(cfg.url, { key, action: "services" });
      if (!Array.isArray(list)) return reply(list?.error ? list : { error: "Could not read the service list" });
      const s = list.find((x: Record<string, unknown>) => String(x.service) === service);
      if (!s) return reply({ error: "Service " + service + " was not found on " + domain });
      return reply({ service: s.service, name: s.name, rate: s.rate, min: s.min, max: s.max });
    }
    if (action === "add") {
      const service = String(body.service || "").trim();
      const link = String(body.link || "").trim();
      const quantity = String(body.quantity || "").trim();
      if (!/^\d+$/.test(service)) return reply({ error: "Service number must be a number" }, 400);
      if (!/^https?:\/\/\S+$/i.test(link)) return reply({ error: "Link must start with https://" }, 400);
      if (!/^\d+$/.test(quantity) || Number(quantity) < 1) return reply({ error: "Quantity must be a whole number" }, 400);
      return reply(await callPanel(cfg.url, { key, action: "add", service, link, quantity }));
    }
    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: "Could not reach " + domain + ": " + String((e as Error)?.message || e) });
  }
});
