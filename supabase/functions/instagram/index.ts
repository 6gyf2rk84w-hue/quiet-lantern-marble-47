// Panel Tracker: "instagram" function.
// - Connect Instagram: Meta's "Unified login" (new apps). People choose "Log in with Instagram" on Meta's
//   sign-in screen. No Facebook Page needed; the Instagram must be a Creator or Business account.
//   This follows a setup proven on a live account (reels and posts, views/shares/saves/reposts).
// - Previews: thumbnails and live numbers for a video, read with the video owner's own connection.
// - Auto-log: posts whose caption has the person's auto-log phrase / word show up as their next video.
// Tokens are encrypted and stay in Supabase. They are never sent to anyone's phone.
//
// Settings (Supabase → Edge Functions → Secrets):
//   META_APP_ID, META_APP_SECRET   App settings → Basic in this app's own Meta app
//   META_CONFIG_ID                 the Unified login configuration; it must include instagram_manage_insights
//                                  (people who connected before it was added must reconnect)
//   IG_TOKEN_KEY                   any long random text; used to encrypt saved tokens
//   CRON_SECRET                any long random text; lets the 15-minute schedule run auto-log for everyone
//   APP_URL (optional)         where to send people back to after connecting
// Deploy with "Verify JWT" turned OFF: Meta sends people back here without a Supabase login.
// The function checks the login itself for everything else.
import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com"; // no version: Meta uses the app's default, as in the proven setup
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
  Object.entries(token ? { ...q, access_token: token } : q).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (j?.error) throw new IgError(j.error.message || "Instagram error", +j.error.code || 0);
  return j;
}
const codeOf = (link: string) => (String(link || "").match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/) || [])[1] || "";
const cleanLink = (link: string) => { const c = codeOf(link); return c ? `https://www.instagram.com/p/${c}/` : String(link || "").trim(); };
const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const MEDIA_FIELDS = "id,caption,media_product_type,media_type,timestamp,permalink,shortcode,like_count,comments_count,media_url";
const ONE_FIELDS = "id,media_product_type,media_type,permalink,shortcode,like_count,comments_count,thumbnail_url,media_url";
const INSIGHTS = ["views", "shares", "saved", "reposts"]; // asked in one call; works for REELS and FEED
const KEY: Record<string, string> = { views: "views", shares: "shares", saved: "saves", reposts: "reposts" };

class NoInsights extends Error {}
function readMetrics(j: any, out: Record<string, number>) {
  for (const d of j?.data || []) {
    const v = d?.values?.[0]?.value ?? d?.total_value?.value;
    if (d?.name && KEY[d.name] && v != null) out[KEY[d.name]] = +v;
  }
}
// Views, shares, saves and reposts for one post. One call; if Meta refuses the list, ask one at a time.
// Throws NoInsights when the connection lacks instagram_manage_insights (#10).
async function insights(id: string, token: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    readMetrics(await ig(`${id}/insights`, token, { metric: INSIGHTS.join(",") }), out);
    return out;
  } catch (e) {
    if (e instanceof IgError && e.code === 10) throw new NoInsights();
    if (e instanceof IgError && e.code === 190) throw e;
  }
  for (const metric of INSIGHTS) {
    try { readMetrics(await ig(`${id}/insights`, token, { metric }), out); }
    catch (e) { if (e instanceof IgError && (e.code === 10 || e.code === 190)) throw e.code === 10 ? new NoInsights() : e; }
  }
  return out;
}
async function cover(id: string, token: string): Promise<string | null> {
  try { const m = await ig(id, token, { fields: "media_type,thumbnail_url,media_url" }); return m?.thumbnail_url || m?.media_url || null; }
  catch (_) { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const configured = !!(env("META_APP_ID") && env("META_APP_SECRET") && env("META_CONFIG_ID") && env("IG_TOKEN_KEY"));
  const url = new URL(req.url);

  // ---------- Facebook sends people back here after they tap Continue ----------
  if (req.method === "GET") {
    if (url.searchParams.get("error")) return back("cancelled");
    const code = (url.searchParams.get("code") || "").replace(/#_$/, "");
    const state = url.searchParams.get("state") || "";
    if (!code || !state || !configured) return back("error");
    try {
      const { data: st } = await admin.from("ig_states").select("*").eq("state", state).maybeSingle();
      await admin.from("ig_states").delete().eq("state", state);
      if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60e3) return back("expired");
      // code → token (a system-user token that never expires, so nothing to refresh)
      const t1 = await ig(`${GRAPH}/oauth/access_token`, "", { client_id: env("META_APP_ID"), client_secret: env("META_APP_SECRET"), redirect_uri: SELF_URL, code });
      const token = String(t1?.access_token || "");
      if (!token) return back("error");
      // Which Instagram account did they pick? (a) assigned accounts, (b) a Page's linked account
      let acct: any = null;
      try { acct = (await ig("me/assigned_instagram_accounts", token, { fields: "id,username,name" }))?.data?.[0] || null; } catch (_) { /* try the next way */ }
      if (!acct) {
        try {
          const pages = (await ig("me/accounts", token, { fields: "instagram_business_account{id,username,name}", limit: "100" }))?.data || [];
          acct = pages.map((p: any) => p?.instagram_business_account).find((a: any) => a?.id) || null;
        } catch (_) { /* none */ }
      }
      if (!acct?.id) return back("noig");
      // Did the insights permission come through? (old sign-ins don't pick it up; they must reconnect)
      let insightsOk = true;
      try {
        const dbg = await ig(`${GRAPH}/debug_token`, "", { input_token: token, access_token: `${env("META_APP_ID")}|${env("META_APP_SECRET")}` });
        const scopes: string[] = dbg?.data?.scopes || [];
        if (scopes.length && !scopes.includes("instagram_manage_insights")) insightsOk = false;
      } catch (_) { /* can't tell; the first numbers request will show it */ }
      const now = new Date().toISOString();
      const { error } = await admin.from("ig_accounts").upsert({
        user_id: st.user_id, ig_user_id: String(acct.id), page_id: null,
        username: acct.username || acct.name || "", token: await seal(token),
        expires_at: null, status: insightsOk ? "ok" : "limited", connected_at: now, refreshed_at: now,
      });
      if (!error && !insightsOk) return back("limited");
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
    if (!row || (row.status !== "ok" && row.status !== "limited")) return null;
    try { return { token: await open(row.token), row }; } catch (_) { return null; }
  }
  async function dead(uid: string) { await admin.from("ig_accounts").update({ status: "expired" }).eq("user_id", uid); }
  async function limited(uid: string) { await admin.from("ig_accounts").update({ status: "limited" }).eq("user_id", uid).eq("status", "ok"); }
  // Numbers for one post; a missing insights permission marks the connection so the app can say "reconnect"
  async function numbers(uid: string, id: string, token: string): Promise<Record<string, number>> {
    try { return await insights(id, token); }
    catch (e) { if (e instanceof NoInsights) { await limited(uid); return {}; } throw e; }
  }

  // Log new posts whose caption has this person's auto-log phrase / word
  async function syncUser(uid: string): Promise<number> {
    const t = await tokenFor(uid); if (!t) return 0;
    const token = t.token, igId = t.row.ig_user_id;
    try {
      const { data: u } = await admin.auth.admin.getUserById(uid);
      const al = (u?.user?.user_metadata as any)?.autolog;
      const phrase = norm(al?.phrase || "");
      await admin.from("ig_accounts").update({ checked_at: new Date().toISOString() }).eq("user_id", uid);
      if (!phrase) return 0;
      const since = Date.parse(al?.since || "") || 0;
      const media = (await ig(`${igId}/media`, token, { fields: MEDIA_FIELDS, limit: "50" }))?.data || [];
      const hits = media.filter((m: any) => m.caption && norm(m.caption).includes(phrase) && Date.parse(m.timestamp) >= since);
      if (!hits.length) return 0;
      const { data: mine } = await admin.from("videos").select("data").eq("owner", uid);
      const have = new Set((mine || []).map((v: any) => codeOf(v?.data?.link || "")).filter(Boolean));
      let n = 0;
      for (const m of hits.reverse()) {
        const code = m.shortcode || codeOf(m.permalink); if (!code || have.has(code)) continue;
        const ts = Date.parse(m.timestamp) || Date.now(), now = Date.now();
        const real: Record<string, number> = { ...(await numbers(uid, m.id, token)) };
        if (m.like_count != null) real.likes = +m.like_count;
        if (m.comments_count != null) real.comments = +m.comments_count;
        const bars: Record<string, { movedAt: number }> = {};
        Object.keys(real).forEach(k => { if (real[k] > 0) bars[k] = { movedAt: now }; });
        const first = String(m.caption).split("\n")[0].trim();
        const title = first.length > 48 ? first.slice(0, 46) + "…" : (first || "Auto-logged video");
        const { error } = await admin.from("videos").insert({
          id: "ig" + crypto.randomUUID().replace(/-/g, "").slice(0, 14), owner: uid,
          data: { title, link: cleanLink(m.permalink), postedAt: ts, month: monthOf(ts), goals: {}, real, bars,
                  thumb: await cover(m.id, token), igId: String(m.id), checkedAt: now, auto: true },
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
        const { data: rows } = await admin.from("ig_accounts").select("user_id").in("status", ["ok", "limited"]);
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
      const u = new URL("https://www.facebook.com/dialog/oauth");
      Object.entries({ client_id: env("META_APP_ID"), config_id: env("META_CONFIG_ID"), override_default_response_type: "true", redirect_uri: SELF_URL, response_type: "code", state, prompt: "login" })
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
        let found: any = null;
        if (v.data?.igId) { try { found = await ig(String(v.data.igId), t.token, { fields: ONE_FIELDS }); } catch (e) { if (e instanceof IgError && e.code === 190) throw e; } }
        if (!found?.id) {
          const first = `${t.row.ig_user_id}/media`;
          let next = first;
          for (let page = 0; page < 3 && next && !found; page++) {
            const j = await ig(next, next === first ? t.token : "", next === first ? { fields: MEDIA_FIELDS, limit: "100" } : {});
            found = (j?.data || []).find((m: any) => (m.shortcode || codeOf(m.permalink)) === code) || null;
            next = j?.paging?.next || "";
          }
          if (found) found = { ...found, thumbnail_url: undefined };
        }
        if (!found?.id) return json({});
        const out: Record<string, unknown> = { igId: String(found.id), thumb: found.thumbnail_url || (await cover(found.id, t.token)), ...(await numbers(v.owner, found.id, t.token)) };
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
