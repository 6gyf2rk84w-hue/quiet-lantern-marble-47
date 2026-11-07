// "panel" function: talks to the order panels for the app.
// Each person connects their own panel key; keys are kept in a private table
// that only this function can read, so a key never goes back to anyone's phone.
//
// Actions (POST JSON):
//   catalog                         -> panels people can connect (name + sign-up / key page links)
//   list                            -> the caller's connected panels with live balances
//   connect   {site, key}           -> tests the key (balance check), then saves it
//   disconnect{site}                -> forgets the caller's key for that panel
//   balance   {site}
//   service   {site, service}       -> name, rate, min, max for one service
//   add       {site, service, link, quantity} -> {order}
//   status    {site, order}
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Site = { id: string; name: string; domain: string; api_url: string; signup_url: string | null; key_url: string | null; sort: number };

const norm = (s: unknown) =>
  String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

// Match what the app sends (a site id, a panel name, or a domain from a Panels section title)
function findSite(sites: Site[], raw: unknown): Site | null {
  const q = norm(raw);
  if (!q) return null;
  const bare = (d: string) => d.replace(/\.[a-z.]+$/, "");
  return sites.find((s) => s.id === q) ||
    sites.find((s) => norm(s.domain) === q) ||
    sites.find((s) => s.name.trim().toLowerCase() === q) ||
    sites.find((s) => bare(norm(s.domain)) === q || bare(norm(s.domain)) === bare(q)) ||
    sites.find((s) => s.name.trim().toLowerCase().replace(/\s+/g, "") === q.replace(/\s+/g, "")) || null;
}

// Standard panel API: POST form fields to the API address, JSON back
async function callPanel(site: Site, key: string, fields: Record<string, string>) {
  const body = new URLSearchParams({ key, ...fields });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(site.api_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
      signal: ctl.signal,
    });
    const text = await r.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (data === null) return { error: `${site.name} sent an unexpected reply (HTTP ${r.status}).` };
    if (data && !Array.isArray(data) && data.error) return { error: String(data.error) };
    return { data };
  } catch (e) {
    return { error: (e as Error)?.name === "AbortError" ? `${site.name} took too long to answer.` : `Could not reach ${site.name}.` };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !service) return json({ error: "Supabase settings are missing." }, 500);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    // Who is asking? Viewers can't use panels.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: "Please sign in again." }, 401);
    const uid = who.user.id;
    const { data: own } = await admin.from("admins").select("user_id").eq("user_id", uid).maybeSingle();
    let role = own ? "owner" : "";
    if (!role) {
      const { data: m } = await admin.from("members").select("role").eq("user_id", uid).maybeSingle();
      role = m?.role || "viewer";
    }
    if (!["owner", "mod", "user"].includes(role)) return json({ error: "Your account can't use panels." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    const { data: rows, error: sErr } = await admin
      .from("panel_sites").select("id,name,domain,api_url,signup_url,key_url,sort").eq("active", true).order("sort").order("name");
    if (sErr) return json({ error: "Run the panels setup in Supabase first." }, 500);
    const sites = (rows || []) as Site[];

    if (action === "catalog") {
      return json({ sites: sites.map((s) => ({ id: s.id, name: s.name, signup_url: s.signup_url, key_url: s.key_url })) });
    }

    const myKeys = async () => {
      const { data } = await admin.from("panel_keys").select("site_id,api_key").eq("user_id", uid);
      const m = new Map<string, string>();
      (data || []).forEach((r: any) => m.set(r.site_id, r.api_key));
      return m;
    };

    if (action === "list") {
      const keys = await myKeys();
      const mine = sites.filter((s) => keys.has(s.id));
      const out = await Promise.all(mine.map(async (s) => {
        const saved = true;
        const r = await callPanel(s, keys.get(s.id)!, { action: "balance" });
        return {
          id: s.id, name: s.name, key_url: s.key_url, saved,
          balance: r.error ? null : r.data?.balance ?? null,
          currency: r.error ? null : r.data?.currency ?? null,
          error: r.error || null,
        };
      }));
      return json({ panels: out });
    }

    const site = findSite(sites, body?.site);
    if (!site) return json({ error: "That panel isn't in the list yet." }, 400);

    if (action === "connect") {
      const key = String(body?.key || "").trim();
      if (key.length < 8 || key.length > 200 || /\s/.test(key) || /^\*+$/.test(key)) {
        return json({ error: "That doesn't look like a full key. Copy it again and paste the whole thing." }, 400);
      }
      const r = await callPanel(site, key, { action: "balance" });
      if (r.error) return json({ error: `${site.name} didn't accept that key: ${r.error}` }, 400);
      const { error: wErr } = await admin.from("panel_keys").upsert(
        { user_id: uid, site_id: site.id, api_key: key, updated_at: new Date().toISOString() },
        { onConflict: "user_id,site_id" },
      );
      if (wErr) return json({ error: "Could not save the key. Run the panels setup in Supabase first." }, 500);
      return json({ ok: true, id: site.id, name: site.name, balance: r.data?.balance ?? null, currency: r.data?.currency ?? null });
    }

    if (action === "disconnect") {
      const { error: dErr } = await admin.from("panel_keys").delete().eq("user_id", uid).eq("site_id", site.id);
      if (dErr) return json({ error: "Could not disconnect. Try again." }, 500);
      return json({ ok: true });
    }

    // Everything else uses the caller's own key
    const key = (await myKeys()).get(site.id);
    if (!key) return json({ error: `Connect ${site.name} in Connections first.` }, 400);

    if (action === "balance") {
      const r = await callPanel(site, key, { action: "balance" });
      if (r.error) return json({ error: r.error }, 502);
      return json({ balance: r.data?.balance ?? null, currency: r.data?.currency ?? null });
    }

    if (action === "service") {
      const id = String(body?.service || "").trim();
      if (!/^\d+$/.test(id)) return json({ error: "Add the service ID first." }, 400);
      const r = await callPanel(site, key, { action: "services" });
      if (r.error) return json({ error: r.error }, 502);
      const list = Array.isArray(r.data) ? r.data : [];
      const s = list.find((x: any) => String(x?.service) === id);
      if (!s) return json({ error: `Service ${id} isn't on ${site.name} anymore.` }, 404);
      return json({ name: s.name ?? "", rate: s.rate ?? null, min: s.min ?? null, max: s.max ?? null });
    }

    if (action === "add") {
      const id = String(body?.service || "").trim();
      const link = String(body?.link || "").trim();
      const qty = String(body?.quantity || "").trim();
      if (!/^\d+$/.test(id)) return json({ error: "Add the service ID first." }, 400);
      if (!/^https:\/\/\S+$/i.test(link) || link.length > 500) return json({ error: "Paste the full link, starting with https://" }, 400);
      if (!/^\d+$/.test(qty) || Number(qty) < 1) return json({ error: "Enter a whole-number quantity." }, 400);
      const r = await callPanel(site, key, { action: "add", service: id, link, quantity: qty });
      if (r.error) return json({ error: r.error }, 502);
      if (!r.data?.order) return json({ error: `${site.name} did not return an order number.` }, 502);
      return json({ order: String(r.data.order) });
    }

    if (action === "status") {
      const order = String(body?.order || "").trim();
      if (!/^\d+$/.test(order)) return json({ error: "No order number to check." }, 400);
      const r = await callPanel(site, key, { action: "status", order });
      if (r.error) return json({ error: r.error }, 502);
      const d = r.data || {};
      return json({ status: d.status ?? null, remains: d.remains ?? null, start_count: d.start_count ?? null, charge: d.charge ?? null, currency: d.currency ?? null });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
