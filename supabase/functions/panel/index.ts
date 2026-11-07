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
//   prices    {refs}                -> live price per 1,000 for app services (by their id), straight from the panel
//   track                           -> checks the caller's unfinished orders with the panels and logs how they end
//   stats     {refs}                -> completion rate, finish time and order count per app service (everyone's orders)
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

    // ---- app services -> panel + service id (from the Panels screen's services)
    const resolve = async (refs: string[]) => {
      const out = new Map<string, { site: Site | null; service: string }>();
      if (!refs.length) return out;
      const { data: os } = await admin.from("orders").select("id,node,service_id").in("id", refs);
      const nodeIds = [...new Set((os || []).map((o: any) => o.node).filter(Boolean))];
      const { data: ns } = nodeIds.length ? await admin.from("nodes").select("id,title").in("id", nodeIds) : { data: [] as any[] };
      const title = new Map<string, string>(); (ns || []).forEach((n: any) => title.set(String(n.id), String(n.title || "")));
      (os || []).forEach((o: any) => out.set(String(o.id), { site: findSite(sites, title.get(String(o.node)) || ""), service: String(o.service_id ?? "").trim() }));
      return out;
    };
    // any saved key for a panel can read its public price list (reading prices never spends money)
    const readKey = async (siteId: string) => {
      const { data: mine } = await admin.from("panel_keys").select("api_key").eq("user_id", uid).eq("site_id", siteId).maybeSingle();
      if (mine?.api_key) return mine.api_key as string;
      const { data: any1 } = await admin.from("panel_keys").select("api_key").eq("site_id", siteId).limit(1).maybeSingle();
      return (any1?.api_key as string) || "";
    };
    const cleanRefs = (x: unknown) => (Array.isArray(x) ? x : []).map((r) => String(r)).filter((r) => /^[A-Za-z0-9_-]{1,80}$/.test(r)).slice(0, 300);

    if (action === "prices") {
      const refs = cleanRefs(body?.refs);
      const map = await resolve(refs);
      const bySite = new Map<string, { site: Site; items: { ref: string; service: string }[] }>();
      const out: Record<string, any> = {};
      refs.forEach((ref) => {
        const m = map.get(ref);
        if (!m) { out[ref] = { error: "missing" }; return; }
        if (!/^\d+$/.test(m.service)) { out[ref] = { error: "needs_id" }; return; }
        if (!m.site) { out[ref] = { error: "no_panel" }; return; }
        const g = bySite.get(m.site.id) || { site: m.site, items: [] };
        g.items.push({ ref, service: m.service }); bySite.set(m.site.id, g);
      });
      await Promise.all([...bySite.values()].map(async (g) => {
        const k = await readKey(g.site.id);
        if (!k) { g.items.forEach((i) => out[i.ref] = { error: "not_connected" }); return; }
        const r = await callPanel(g.site, k, { action: "services" });
        if (r.error || !Array.isArray(r.data)) { g.items.forEach((i) => out[i.ref] = { error: "unreachable" }); return; }
        const list = new Map<string, any>(); r.data.forEach((x: any) => list.set(String(x?.service), x));
        g.items.forEach((i) => {
          const x = list.get(i.service);
          if (!x) out[i.ref] = { error: "not_found" };
          else out[i.ref] = { rate: Number(x.rate), min: x.min != null ? Number(x.min) : null, max: x.max != null ? Number(x.max) : null };
        });
      }));
      return json({ prices: out });
    }

    if (action === "track") {
      const { data: open, error: oErr } = await admin.from("panel_orders")
        .select("id,site_id,panel_order,status,qty,started_at").eq("user_id", uid).in("status", ["pending", "in_progress"]).order("placed_at").limit(200);
      if (oErr) return json({ error: "Run the order log setup in Supabase first." }, 500);
      const keys = await myKeys();
      const groups = new Map<string, any[]>(); (open || []).forEach((o: any) => { const g = groups.get(o.site_id) || []; g.push(o); groups.set(o.site_id, g); });
      const now = new Date().toISOString();
      const norm2 = (st: string) => { const x = st.toLowerCase();
        if (x.includes("complete")) return "completed"; if (x.includes("partial")) return "partial";
        if (x.includes("cancel") || x.includes("refund") || x.includes("fail")) return "canceled";
        if (x.includes("progress") || x.includes("processing") || x.includes("active")) return "in_progress"; return "pending"; };
      let changed = 0;
      for (const [siteId, list] of groups) {
        const s = sites.find((x) => x.id === siteId); const k = keys.get(siteId);
        if (!s || !k) continue;
        for (let i = 0; i < list.length; i += 100) {
          const chunk = list.slice(i, i + 100);
          const r = await callPanel(s, k, { action: "status", orders: chunk.map((o: any) => o.panel_order).join(",") });
          if (r.error || !r.data || typeof r.data !== "object") continue;
          for (const o of chunk) {
            const d = (r.data as any)[o.panel_order]; if (!d || d.error || !d.status) continue;
            const st = norm2(String(d.status)), remains = d.remains != null && d.remains !== "" ? Math.max(0, Number(d.remains) || 0) : null;
            const patch: Record<string, unknown> = { status: st, remains, start_count: d.start_count != null ? Number(d.start_count) || null : null, checked_at: now };
            if (st !== "pending" && !o.started_at) patch.started_at = now;
            if (st === "completed" || st === "partial" || st === "canceled") patch.finished_at = now;
            if (st !== o.status || patch.finished_at || patch.started_at) changed++;
            await admin.from("panel_orders").update(patch).eq("id", o.id);
          }
        }
      }
      const { data: mine2 } = await admin.from("panel_orders").select("panel_order,video_id,stat,status,qty,remains,placed_at,finished_at")
        .eq("user_id", uid).order("placed_at", { ascending: false }).limit(300);
      return json({ changed, orders: mine2 || [] });
    }

    if (action === "stats") {
      const refs = cleanRefs(body?.refs);
      if (!refs.length) return json({ stats: {} });
      const { data: rows2, error: stErr } = await admin.from("panel_orders").select("ref,status,qty,remains,placed_at,finished_at")
        .in("ref", refs).in("status", ["completed", "partial", "canceled"]).order("finished_at", { ascending: false }).limit(5000);
      if (stErr) return json({ error: "Run the order log setup in Supabase first." }, 500);
      const by = new Map<string, any[]>(); (rows2 || []).forEach((r: any) => { const g = by.get(r.ref) || []; g.push(r); by.set(r.ref, g); });
      const out: Record<string, any> = {};
      for (const ref of refs) {
        const g = by.get(ref) || [];
        const c = { completed: 0, partial: 0, canceled: 0 } as Record<string, number>; g.forEach((r) => c[r.status]++);
        // the rate looks at the latest 30 finished orders; a partial counts for the share it delivered
        const recent = g.slice(0, 30);
        const credit = recent.reduce((t, r) => t + (r.status === "completed" ? 1 : r.status === "partial" ? Math.max(0, Math.min(1, ((+r.qty || 0) - (+r.remains || 0)) / Math.max(1, +r.qty || 1))) : 0), 0);
        const times = recent.filter((r) => r.status === "completed" && r.finished_at && r.placed_at)
          .map((r) => (Date.parse(r.finished_at) - Date.parse(r.placed_at)) / 1000).filter((x) => x > 0).sort((a, b) => a - b);
        out[ref] = { n: g.length, rate: recent.length ? Math.round(credit / recent.length * 100) : null, ...c,
          finish_s: times.length ? Math.round(times[Math.floor(times.length / 2)]) : null };
      }
      return json({ stats: out });
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
      const order = String(r.data.order);
      // log it so its outcome can be tracked (a failed log never undoes the order)
      const ref = String(body?.ref || "").slice(0, 80), stat = String(body?.stat || "").slice(0, 20), video = String(body?.video || "").slice(0, 80);
      const { error: lErr } = await admin.from("panel_orders").insert({ user_id: uid, site_id: site.id, panel_order: order, service: id,
        ref: ref || null, stat: stat || null, video_id: video || null, qty: Number(qty), cost: Number(body?.cost) || null, status: "pending" });
      return json({ order, logged: !lErr });
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
