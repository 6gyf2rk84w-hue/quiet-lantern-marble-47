// Panel Tracker: "instagram" function.
// - Connect Instagram: each person signs in on Instagram's own screen (read-only permissions).
// - Previews: thumbnails and live numbers for a video, read with the video owner's own connection.
// - Auto-log: posts whose caption has the person's auto-log phrase / word show up as their next video.
// Tokens are encrypted and stay in Supabase. They are never sent to anyone's phone.
//
// Settings (Supabase → Edge Functions → Secrets):
//   IG_APP_ID, IG_APP_SECRET   from this app's own Meta app (Instagram API with Instagram Login)
//   IG_TOKEN_KEY               any long random text; used to encrypt saved tokens
//   CRON_SECRET                any long random text; lets the 15-minute schedule run auto-log for everyone
//   APP_URL (optional)         where to send people back to after connecting
// Deploy with "Verify JWT" turned OFF: Instagram calls this function back without a Supabase login.
// The function checks the login itself for everything else.
import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = "https://graph.instagram.com/v23.0";
const SCOPES = "instagram_business_basic,instagram_business_manage_insights";
const env = (k: string) => Deno.env.get(k) || "";
const APP_URL = env("APP_URL") || "https://6gyf2rk84w-hue.github.io/quiet-lantern-marble-47/";
const SELF_URL = `${env("SUPABASE_URL")}/functions/v1/instagram`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${APP_URL}?ig=${q}` } });

// ---------- token encryption (AES-GCM, key from IG_TOKEN_KEY) ----------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function key(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env("IG_TOKEN_KEY")));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(text)));
  return `${b64(iv)}.${b64(ct)}`;
}
async function open(sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- Instagram helpers ----------
class IgError extends Error { code: number; constructor(m: string, c: number) { super(m); this.code = c; } }
async function ig(path: string, token: string, q: Record<string, string> = {}): Promise<any> {
  const u = new URL(path.startsWith("http") ? path : `${GRAPH}/${path}`);
  Object.entries({ ...q, access_token: token }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (j?.error) throw new IgError(j.error.message || "Instagram error", +j.error.code || 0);
  return j;
}
const codeOf = (link: string) => (String(link || "").match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [])[1] || "";
const cleanLink = (link: string) => { const c = codeOf(link); return c ? `https://www.instagram.com/p/${c}/` : String(link || "").trim(); };
const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const MEDIA_FIELDS = "id,caption,permalink,timestamp,media_type,thumbnail_url,media_url,like_count,comments_count";

async function insights(id: string, token: string) {
  const out: Record<string, number> = {};
  for (const [k, metric] of [["views", "views"], ["shares", "shares"], ["saves", "saved"], ["reposts", "reposts"]]) {
    try {
      const j = await ig(`${id}/insights`, token, { metric });
      const v = j?.data?.[0]?.values?.[0]?.value ?? j?.data?.[0]?.total_value?.value;
      if (v != null) out[k] = +v;
    } catch (_) { /* Instagram refuses some metrics for some posts; skip those */ }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const configured = !!(env("IG_APP_ID") && env("IG_APP_SECRET") && env("IG_TOKEN_KEY"));
  const url = new URL(req.url);

  // ---------- Instagram sends people back here after they tap Allow ----------
  if (req.method === "GET") {
    if (url.searchParams.get("error")) return back("cancelled");
    const code = (url.searchParams.get("code") || "").replace(/#_$/, "");
    const state = url.searchParams.get("state") || "";
    if (!code || !state || !configured) return back("error");
    try {
      const { data: st } = await admin.from("ig_states").select("*").eq("state", state).maybeSingle();
      await admin.from("ig_states").delete().eq("state", state);
      if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60e3) return back("expired");
      // code → short-lived token → 60-day token
      const form = new URLSearchParams({ client_id: env("IG_APP_ID"), client_secret: env("IG_APP_SECRET"), grant_type: "authorization_code", redirect_uri: SELF_URL, code });
      const r1 = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
      const t1 = await r1.json().catch(() => ({}));
      if (!t1?.access_token) return back("error");
      const t2 = await ig("https://graph.instagram.com/access_token", t1.access_token, { grant_type: "ig_exchange_token", client_secret: env("IG_APP_SECRET") });
      const me = await ig("me", t2.access_token, { fields: "user_id,username" });
      const now = new Date().toISOString();
      const { error } = await admin.from("ig_accounts").upsert({
        user_id: st.user_id, ig_user_id: String(me.user_id || me.id || ""), username: me.username || "",
        token: await seal(t2.access_token), expires_at: new Date(Date.now() + (+t2.expires_in || 5184000) * 1000).toISOString(),
        status: "ok", connected_at: now, refreshed_at: now,
      });
      return back(error ? "error" : "connected");
    } catch (_) { return back("error"); }
  }

  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");

  // ---------- the 15-minute schedule: auto-log for everyone ----------
  const cron = env("CRON_SECRET") && req.headers.get("x-cron-secret") === env("CRON_SECRET");
  let who: { id: string } | null = null;
  if (!cron) {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data } = await admin.auth.getUser(token);
    if (!data?.user) return json({ error: "Please sign in again." }, 401);
    who = data.user;
  }
  if (!configured) return json({ error: "not_configured" }, 503);

  async function tokenFor(uid: string): Promise<{ token: string; row: any } | null> {
    const { data: row } = await admin.from("ig_accounts").select("*").eq("user_id", uid).maybeSingle();
    if (!row || row.status !== "ok") return null;
    try { return { token: await open(row.token), row }; } catch (_) { return null; }
  }
  async function dead(uid: string) { await admin.from("ig_accounts").update({ status: "expired" }).eq("user_id", uid); }

  // Keep a token alive: refresh once it's a day old and has under 30 days left
  async function keepAlive(uid: string, row: any, token: string): Promise<string> {
    const left = Date.parse(row.expires_at || 0) - Date.now(), age = Date.now() - Date.parse(row.refreshed_at || 0);
    if (age < 864e5 || left > 30 * 864e5) return token;
    const r = await ig("https://graph.instagram.com/refresh_access_token", token, { grant_type: "ig_refresh_token" });
    if (!r?.access_token) return token;
    await admin.from("ig_accounts").update({
      token: await seal(r.access_token), refreshed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (+r.expires_in || 5184000) * 1000).toISOString(),
    }).eq("user_id", uid);
    return r.access_token;
  }

  // Log new posts whose caption has this person's auto-log phrase / word
  async function syncUser(uid: string): Promise<number> {
    const t = await tokenFor(uid); if (!t) return 0;
    let token = t.token;
    try {
      token = await keepAlive(uid, t.row, token);
      const { data: u } = await admin.auth.admin.getUserById(uid);
      const al = (u?.user?.user_metadata as any)?.autolog;
      const phrase = norm(al?.phrase || "");
      await admin.from("ig_accounts").update({ checked_at: new Date().toISOString() }).eq("user_id", uid);
      if (!phrase) return 0;
      const since = Date.parse(al?.since || "") || 0;
      const media = (await ig("me/media", token, { fields: MEDIA_FIELDS, limit: "50" }))?.data || [];
      const hits = media.filter((m: any) => m.caption && norm(m.caption).includes(phrase) && Date.parse(m.timestamp) >= since);
      if (!hits.length) return 0;
      const { data: mine } = await admin.from("videos").select("data").eq("owner", uid);
      const have = new Set((mine || []).map((v: any) => codeOf(v?.data?.link || "")).filter(Boolean));
      let n = 0;
      for (const m of hits.reverse()) {
        const code = codeOf(m.permalink); if (!code || have.has(code)) continue;
        const ts = Date.parse(m.timestamp) || Date.now(), now = Date.now();
        const real: Record<string, number> = { ...(await insights(m.id, token)) };
        if (m.like_count != null) real.likes = +m.like_count;
        if (m.comments_count != null) real.comments = +m.comments_count;
        const bars: Record<string, { movedAt: number }> = {};
        Object.keys(real).forEach(k => { if (real[k] > 0) bars[k] = { movedAt: now }; });
        const first = String(m.caption).split("\n")[0].trim();
        const title = first.length > 48 ? first.slice(0, 46) + "…" : (first || "Auto-logged video");
        const { error } = await admin.from("videos").insert({
          id: "ig" + crypto.randomUUID().replace(/-/g, "").slice(0, 14), owner: uid,
          data: { title, link: cleanLink(m.permalink), postedAt: ts, month: monthOf(ts), goals: {}, real, bars,
                  thumb: m.thumbnail_url || m.media_url || null, checkedAt: now, auto: true },
        });
        if (!error) { have.add(code); n++; }
      }
      return n;
    } catch (e) {
      if (e instanceof IgError && e.code === 190) await dead(uid);
      return 0;
    }
  }

  try {
    if (action === "sync") {
      if (cron) {
        const { data: rows } = await admin.from("ig_accounts").select("user_id").eq("status", "ok");
        let n = 0; for (const r of rows || []) n += await syncUser(r.user_id);
        return json({ logged: n });
      }
      return json({ logged: await syncUser(who!.id) });
    }
    if (!who) return json({ error: "Not allowed" }, 403);

    if (action === "connect") {
      const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "");
      await admin.from("ig_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
      const { error } = await admin.from("ig_states").insert({ state, user_id: who.id });
      if (error) return json({ error: error.message }, 500);
      const u = new URL("https://www.instagram.com/oauth/authorize");
      Object.entries({ client_id: env("IG_APP_ID"), redirect_uri: SELF_URL, response_type: "code", scope: SCOPES, state })
        .forEach(([k, v]) => u.searchParams.set(k, v));
      return json({ url: u.toString() });
    }

    if (action === "disconnect") {
      await admin.from("ig_accounts").delete().eq("user_id", who.id);
      return json({ ok: true });
    }

    if (action === "preview") {
      // Read with the video owner's connection; only the owner of the app or the video's owner may ask
      const { data: v } = await admin.from("videos").select("owner,data").eq("id", String(body?.video || "")).maybeSingle();
      if (!v) return json({});
      if (v.owner !== who.id) {
        const { data: own } = await admin.from("admins").select("user_id").eq("user_id", who.id).maybeSingle();
        if (!own) return json({});
      }
      const t = await tokenFor(v.owner); if (!t) return json({});
      const code = codeOf(v.data?.link || ""); if (!code) return json({});
      try {
        let next = "me/media", found: any = null;
        const q: Record<string, string> = { fields: MEDIA_FIELDS, limit: "100" };
        for (let page = 0; page < 3 && next && !found; page++) {
          const j = await ig(next, t.token, next === "me/media" ? q : {});
          found = (j?.data || []).find((m: any) => codeOf(m.permalink) === code) || null;
          next = j?.paging?.next || "";
        }
        if (!found) return json({});
        const out: Record<string, unknown> = { thumb: found.thumbnail_url || found.media_url || null, ...(await insights(found.id, t.token)) };
        if (found.like_count != null) out.likes = +found.like_count;
        if (found.comments_count != null) out.comments = +found.comments_count;
        return json(out);
      } catch (e) {
        if (e instanceof IgError && e.code === 190) await dead(v.owner);
        return json({});
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
