/* Order Tracker — a standalone screen for tracking orders on Instagram posts.
 *
 * Each order = one Instagram post with goals (views, likes, shares, saves, reposts, comments).
 * Each goal gets a progress bar that watches the real numbers climb:
 *   idle (blue 🤖, nothing yet) → 🟢 In progress → 🟡 Stalling (no movement 3 h) → 🔴 Needs review (6 h)
 *   → complete (hit 100%, or 80%+ and flat for 24 h, or marked complete by hand).
 * Finished stats leave the card; a fully finished order moves to "Completed". Older months go to the Archive.
 *
 * Mount it:   OrderTracker.mount(document.getElementById("app"), { ...options });
 * Options (all optional):
 *   store:    { load(): Promise<Order[]>, save(orders): Promise }   — default: this browser's localStorage
 *   preview:  { fetch(link): Promise<{thumb, views, likes, shares, saves, reposts, comments}|null> }
 *             — default: none (cards show an empty thumbnail spot until you plug one in; see README)
 *   monthlyTarget: number   — "4/10 orders" counter (default 10)
 *   prices:   { views, likes, shares, saves, reposts, comments } — $ per single one, for the Grand total (default: none → no $)
 *   rates:    { likes, shares, saves, reposts, comments } — per view, used to fill the other goals when you set a views goal
 *   refreshEveryMin: number — auto refresh while the screen is open (default 10)
 *   labels:   { order: "order", orders: "orders" }
 *   readOnly: boolean — hide every editing control (for viewers)
 *   onPick(order, stat, done) — host opens a service picker; done({qty, plan}) or done(null) to clear
 *   people(): [{id, label}] — show a person filter (id null = everyone); videos carry their owner in o._by
 *   me: the signed-in person's id (new videos get o._by = me)
 *   byLabel(o) — small "by …" tag on cards when everyone is shown
 *   planLabel(plan) — text shown next to a picked service (default: plan.site)
 *   deal(month): {per, cut, count} | null — the signed-in person's monthly deal; onDeal() opens the editor
 *   onLogged(o, setStat) — runs after a video is logged; setStat(stat, {qty, plan} | null)
 *   confirm(what, go) — host asks "are you sure?" before a delete, then calls go()
 *   linkPlaceholder: string — grey example text in the link box
 */
(function (global) {
  "use strict";
  const STATS = [["views","Views","👁️"],["likes","Likes","❤️"],["shares","Shares","📤"],["saves","Saves","🔖"],["reposts","Reposts","🔁"],["comments","Comments","💬"]];
  const H = 3600e3, STALL = 3 * H, REVIEW = 6 * H, AUTO_DONE = 24 * H;
  const DEF_RATES = { likes: .05, shares: .015, saves: .008, reposts: .006, comments: .0006 };
  // Instagram-style line icons (28×28 box, drawn in currentColor)
  const ICON_PATHS = {
    likes:'<path transform="translate(14.008 13.75) scale(0.8688 0.85) translate(-12 -12)" stroke-width="2.327" d="M12 21.2c-.3 0-.58-.11-.8-.32L3.87 13.8C1.7 11.7 1.5 8.3 3.4 5.87 5.48 3.2 9.33 2.82 11.67 5.4l.33.38.33-.38c2.34-2.58 6.19-2.2 8.27.47 1.9 2.43 1.7 5.83-.47 7.93l-7.330 7.08c-.22.21-.5.32-.8.32Z"/>',
    comments:'<path transform="translate(13.979 14.083) scale(0.9047 0.8812) translate(-12 -12)" stroke-width="2.229" d="M20.86 11.88c0-5.02-3.960-9.08-8.84-9.08-4.89 0-8.86 4.06-8.86 9.08s3.97 9.08 8.86 9.08c1.67 0 3.24-.48 4.57-1.31l4.15 1.4c.49.16.95-.3.8-.8l-1.36-4.28c.44-1.22.68-2.63.68-4.090Z"/>',
    shares:'<path transform="translate(0.333 0)" stroke-width="2" d="M5.685 9.675A1.9 1.9 0 0 1 7.153 6.581L20.272 6.516A1.9 1.9 0 0 1 21.922 9.374L15.207 20.876A1.7 1.7 0 0 1 12.175 20.684L9.5 14.395ZM9.5 14.395L16.7 10.3"/>',
    saves:'<path stroke-width="2.075" d="M7.367 6.5H20.633V21L14 15.406L7.367 21Z"/>',
    reposts:'<path stroke-width="1.85" d="M7.5 15V11.35A3.1 3.1 0 0 1 10.6 8.25H17.5M14.4 5.15L17.5 8.25L14.4 11.35M20.5 13V16.65A3.1 3.1 0 0 1 17.4 19.75H10.5M13.6 16.65L10.5 19.75L13.6 22.85"/>'
  };
  const icon = (s, size = 30) => ICON_PATHS[s] ? `<svg viewBox="0 0 28 28" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[s]}</svg>` : "";

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => { n = +n || 0; const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "M";
    if (a >= 1e4) return Math.round(n / 1e3) + "K";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n)); };
  const num = n => (+n || 0).toLocaleString("en-US");
  const usd = n => "$" + (Math.round((+n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parseNum = s => { s = String(s || "").trim().toLowerCase().replace(/[,\s]/g, ""); const m = s.match(/^(\d*\.?\d+)([km]?)$/); if (!m) return null;
    return Math.round(parseFloat(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1)); };
  const monthKey = t => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
  const monthName = k => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" }) + (y !== new Date().getFullYear() ? " " + y : ""); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // clean Instagram link: https://www.instagram.com/p/<code>/ (nothing after the last slash)
  const cleanLink = u => { const m = String(u || "").match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? `https://www.instagram.com/${m[1].toLowerCase() === "tv" ? "tv" : "p"}/${m[2]}/` : String(u || "").trim(); };

  const localStore = key => ({
    async load() { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; } },
    async save(o) { try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) {} }
  });

  function mount(root, opt) {
    opt = opt || {};
    const store = opt.store || localStore("order-tracker-v1");
    const preview = opt.preview || null;
    const target = opt.monthlyTarget || 10;
    const prices = opt.prices || null;
    const rates = Object.assign({}, DEF_RATES, opt.rates || {});
    const L = Object.assign({ order: "order", orders: "orders" }, opt.labels || {});
    const st = { orders: [], month: monthKey(Date.now()), edit: null, open: null, ask: null, busy: false, arch: null, who: null, shown: {} };
    const vis = () => st.who ? st.orders.filter(o => o._by === st.who) : st.orders;
    const planText = p => opt.planLabel ? opt.planLabel(p) : (p.site || p.name || "");
    root.classList.add("ot");

    // ---- bar logic ------------------------------------------------------------
    const bar = (o, s) => (o.bars = o.bars || {}, o.bars[s] = o.bars[s] || {}, o.bars[s]);
    const goal = (o, s) => +((o.goals || {})[s]) || 0;
    const real = (o, s) => +((o.real || {})[s]) || 0;
    const pct = (o, s) => goal(o, s) ? Math.min(100, Math.round(real(o, s) / goal(o, s) * 100)) : 0;
    function state(o, s, now) {
      const g = goal(o, s); if (!g) return "none";
      const b = bar(o, s); if (b.done) return "g";
      const p = real(o, s) / g;
      if (p >= 1) return "g";
      if (!b.movedAt) return "idle";
      const quiet = now - b.movedAt;
      if (p >= .8 && quiet >= AUTO_DONE) return "g";
      if (quiet >= REVIEW) return "r";
      if (quiet >= STALL) return "y";
      return "mv";
    }
    const mark = (o, s) => { const p = goal(o, s) ? real(o, s) / goal(o, s) : 0; return p >= .8 ? ["g", "✓"] : p >= .5 ? ["y", "✓"] : ["r", "✕"]; };
    const finished = (o, now) => STATS.some(([s]) => goal(o, s)) && STATS.every(([s]) => !goal(o, s) || state(o, s, now) === "g");
    const planOf = (o, s) => (o.plan || {})[s] || null;
    const statValue = (o, s) => { const p = planOf(o, s); if (p && goal(o, s)) return (+p.price || 0) * goal(o, s) / 1000; return prices ? (+prices[s] || 0) * (goal(o, s) || real(o, s)) : 0; };
    const value = o => STATS.reduce((t, [s]) => t + statValue(o, s), 0);
    const RO = !!opt.readOnly;

    // new numbers came in → remember when each stat last moved
    function applyReal(o, r, now) {
      o.real = o.real || {};
      STATS.forEach(([s]) => { if (r[s] == null) return; const v = +r[s] || 0, b = bar(o, s);
        if (v > (+o.real[s] || 0) && o.real[s] != null) b.movedAt = now;
        if (o.real[s] == null && v > 0) b.movedAt = now;
        o.real[s] = v; });
      if (r.thumb) o.thumb = r.thumb;
      o.checkedAt = now;
    }

    // ---- data -----------------------------------------------------------------
    const save = async () => { try { await store.save(st.orders); } catch (e) { toast("Not saved: " + ((e && e.message) || e)); } };
    async function refresh(quiet) {
      if (!preview || st.busy) { if (!quiet && !preview) toast("Live numbers arrive in the next update."); return; }
      st.busy = true; draw();
      const now = Date.now();
      for (const o of st.orders) { if (o.month < prevMonth()) continue;
        try { const r = await preview.fetch(o.link); if (r) applyReal(o, r, now); } catch (e) {} }
      st.busy = false; await save(); draw(); if (!quiet) toast("All up to date!");
    }
    const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKey(d); };
    const shownMonths = () => { const cur = monthKey(Date.now()), pm = prevMonth(); return vis().some(o => o.month === pm) ? [pm, cur] : [cur]; };

    // ---- drawing --------------------------------------------------------------
    function barRow(o, s, label, S) {
      const p = pct(o, s);
      return `<div class="ot-bar-r"><div class="ot-bar s-${S}"><i style="width:${S === "idle" ? 0 : p}%"></i></div><span class="ot-pct s-${S}">${p}%</span>
        <button class="ot-bot s-${S}" type="button" data-ot-bot="${esc(o.id)}|${s}" aria-label="${label} options">🤖</button></div>`;
    }
    function statCard(o, s, label, ic, now) {
      const S = state(o, s, now); if (S === "none" || S === "g") return "";
      const p = planOf(o, s);
      return `<div class="ot-stc s-${S}"${RO ? "" : ` data-ot-pick="${esc(o.id)}|${s}"`}><span class="ic">${icon(s) || ic}</span><div class="bd">
        <div class="n"><b>${fmt(real(o, s))} / ${fmt(goal(o, s))}</b><small>${label}</small>${p ? `<em class="ot-plan">${esc(planText(p))} · ${usd(statValue(o, s))}</em>` : ""}</div>${barRow(o, s, label, S)}</div></div>`;
    }
    function card(o, n, now) {
      const ed = st.edit === o.id, vg = goal(o, "views"), vS = state(o, "views", now);
      const head = `<div class="ot-hd"><div class="ot-name"><small class="ot-num">${esc(L.order[0].toUpperCase() + L.order.slice(1))} ${n}${!st.who && opt.byLabel && opt.byLabel(o) ? ` <span class="ot-by">${esc(opt.byLabel(o))}</span>` : ""}</small>${o.title ? esc(o.title) : ""}</div>
        ${RO ? "" : `<button class="ot-edbtn" type="button" data-ot-edit="${esc(o.id)}">${ed ? "Done" : "✏️ Edit"}</button>`}</div>`;
      if (ed) return `<div class="ot-card">${head}
        <div class="ot-egrid" style="grid-template-columns:1fr"><label>Title<input class="ot-in" data-ot-f="title" value="${esc(o.title)}"></label>
        <label>Post link<input class="ot-in" data-ot-f="link" inputmode="url" value="${esc(o.link)}"></label></div>
        <div class="ot-egrid">${STATS.map(([s, lb]) => `<label>${lb} goal<input class="ot-in" inputmode="decimal" data-ot-g="${s}" value="${goal(o, s) ? num(goal(o, s)) : ""}" placeholder="—"></label>`).join("")}</div>
        <div class="ot-row"><button class="ot-btn" type="button" data-ot-save="${esc(o.id)}">Save</button><button class="ot-btn danger" type="button" data-ot-del="${esc(o.id)}">Delete ${esc(L.order)}</button></div></div>`;
      const done = STATS.filter(([s]) => goal(o, s) && s !== "views" && state(o, s, now) === "g");
      const usdV = value(o);
      return `<div class="ot-card">${head}
        <div class="ot-views"${RO ? "" : ` data-ot-pick="${esc(o.id)}|views"`}>${num(real(o, "views"))}<span class="g"> / ${vg ? fmt(vg) : "---"}</span><small>views</small>${vS === "g" ? `<span class="ot-chk">✓</span>` : ""}${planOf(o, "views") ? `<em class="ot-plan">${esc(planText(planOf(o, "views")))} · ${usd(statValue(o, "views"))}</em>` : ""}</div>
        ${vg && vS !== "g" ? barRow(o, "views", "Views", vS) : ""}
        <div class="ot-mid">${o.link ? `<a class="ot-thumb" href="${esc(o.link)}" target="_blank" rel="noopener" style="${o.thumb ? `background-image:url('${esc(o.thumb)}')` : ""}" aria-label="Open the post"></a>` : `<span class="ot-thumb"></span>`}
          ${o.link ? `<button class="ot-copy" type="button" data-ot-copy="${esc(o.link)}">🔗 Copy link</button>` : ""}</div>
        <div class="ot-stats">${STATS.slice(1).map(([s, lb, ic]) => statCard(o, s, lb, ic, now)).join("")}</div>
        ${!RO && opt.onPick && STATS.some(([s]) => !goal(o, s)) ? `<div class="ot-adds">${STATS.filter(([s]) => !goal(o, s)).map(([s, lb, ic]) => `<button class="ot-add" type="button" data-ot-pick="${esc(o.id)}|${s}">+ ${icon(s, 18) || ic} ${lb}</button>`).join("")}</div>` : ""}
        ${done.length ? `<div class="ot-done">Done ${done.map(([s, lb, ic]) => { const [c, sy] = mark(o, s); return `<span class="ot-chip mk-${c}" title="${lb}">${sy} ${icon(s, 18) || ic}</span>`; }).join("")}</div>` : ""}
        ${usdV ? `<div class="ot-usd">${usd(usdV)}</div>` : ""}</div>`;
    }
    const cash = v => "$" + (Math.round(v * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const showDeal = () => !RO && opt.deal && (!st.who || st.who === opt.me);
    const dealOf = m => { try { return opt.deal(m); } catch (e) { return null; } };
    const ownIn = m => st.orders.filter(o => o.month === m && (!opt.me || !o._by || o._by === opt.me));
    function dealCard(cur) {
      const d = dealOf(st.month);
      if (!d) return st.month === cur ? `<button class="ot-dset" type="button" data-ot-deal="1"><b>🎯 Set monthly deal</b><small>Pick your pay per video and how many videos a month</small></button>` : "";
      const n = Math.max(1, +d.count || 1), net = (+d.per || 0) * (1 - (+d.cut || 0) / 100), posted = ownIn(st.month).length, done = Math.min(posted, n);
      const earned = done * net, rest = (n - done) * net, over = st.month < cur;
      return `<button class="ot-deal" type="button" data-ot-deal="1" aria-label="Monthly deal, tap to change">
        <div class="ot-segs${n > 20 ? " many" : ""}">${Array.from({ length: n }, (_, i) => `<i class="${i < done ? "on" : ""}"></i>`).join("")}</div>
        <div class="ot-dnums"><div><b class="ot-earn" data-ot-count="${earned}">${cash(earned)}</b><small>earned</small></div><div class="r"><b>${cash(rest)}</b><small>${over ? "missed" : "left to earn"}</small></div></div>
        <div class="ot-dline">${over ? (done >= n ? "✅ Month over · " : "📅 Month over · ") : ""}${posted} of ${n} ${esc(n === 1 ? L.order : L.orders)} posted</div></button>`;
    }
    function countUp() {
      const el = root.querySelector("[data-ot-count]"); if (!el) return;
      const to = +el.dataset.otCount, key = st.month + "|" + (st.who || ""), from = st.shown[key] == null ? 0 : st.shown[key];
      st.shown[key] = to; if (from === to) return;
      const t0 = performance.now(), dur = 900;
      const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = cash(from + (to - from) * e); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
      el.textContent = cash(from); requestAnimationFrame(step);
    }
    const people = () => { try { return (opt.people && opt.people()) || []; } catch (e) { return []; } };
    function draw() {
      const now = Date.now(), months = shownMonths(); if (!months.includes(st.month)) st.month = months[months.length - 1];
      const cur = monthKey(now), mine = vis().filter(o => o.month === st.month).sort((a, b) => a.postedAt - b.postedAt);
      const live = mine.filter(o => !finished(o, now)), fin = mine.filter(o => finished(o, now));
      const total = mine.reduce((t, o) => t + value(o), 0), dl = showDeal() ? dealOf(st.month) : null, left = dl ? Math.max(0, (+dl.count || 0) - ownIn(st.month).length) : 0;
      const arch = [...new Set(vis().map(o => o.month).filter(m => !months.includes(m)))].sort().reverse();
      let h = `<div class="ot-top"><div class="ot-seg">${months.map(m => `<button type="button" data-ot-m="${m}" aria-pressed="${m === st.month}">${monthName(m)}</button>`).join("")}</div>
        <button class="ot-ref ${st.busy ? "spin" : ""}" type="button" data-ot-ref="1"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>Refresh</button></div>
        ${people().length > 2 ? `<div class="ot-who">${people().map(x => `<button type="button" data-ot-who="${x.id == null ? "" : esc(x.id)}" aria-pressed="${(x.id || null) === st.who}">${esc(x.label)}</button>`).join("")}</div>` : ""}
        ${showDeal() ? dealCard(cur) : ""}
        <div class="ot-grand"><span class="lb">Grand total · ${monthName(st.month)}</span><b>${usd(total)}</b></div>
        <div class="ot-key"><span>🟢 In progress</span><span>🟡 Stalling</span><span>🔴 Needs review</span></div>`;
      h += live.length ? live.map(o => card(o, mine.indexOf(o) + 1, now)).join("") : (st.month === cur && !RO && !fin.length
        ? `<button class="ot-big" type="button" data-ot-focus="1"><i aria-hidden="true">+</i>Add an ${esc(L.order === "video" ? "order" : L.order)}</button>`
        : `<div class="ot-empty">No ${esc(L.orders)} yet for ${monthName(st.month)}.</div>`);
      if (st.month === cur && !RO) h += `<form class="ot-log" data-ot-log="1" autocomplete="off"><div class="ot-log-h">${dl && left ? `📌 <b>${left}</b> left this month` : dl ? `🔥 Deal complete · log extras here` : `Log a posted ${esc(L.order)}`}</div>
        <label class="ot-lbl">Title<input class="ot-in" name="title" placeholder="Title your video"></label><label class="ot-lbl">Link<input class="ot-in" name="link" inputmode="url" autocapitalize="off" placeholder="${esc(opt.linkPlaceholder || "Instagram post link")}"></label>
        <button class="ot-btn ot-logbtn" type="submit"><i aria-hidden="true">+</i>Log ${esc(L.order)}</button></form>`;
      if (fin.length) h += `<div class="ot-sec"><div class="ot-sec-h">Completed</div>${fin.map(o => `<button class="ot-arow" type="button" data-ot-open="${esc(o.id)}">${esc(o.title || L.order + " " + (mine.indexOf(o) + 1))}<span>${fmt(real(o, "views"))} views ${st.open === o.id ? "▾" : "›"}</span></button>${st.open === o.id ? card(o, mine.indexOf(o) + 1, now) : ""}`).join("")}</div>`;
      if (arch.length) h += `<div class="ot-sec"><div class="ot-sec-h">Archive</div>${arch.map(m => { const a = vis().filter(o => o.month === m);
        return `<button class="ot-arow" type="button" data-ot-arch="${m}">${monthName(m)}<span>${fmt(a.reduce((t, o) => t + real(o, "views"), 0))} views · ${a.length} ${a.length === 1 ? esc(L.order) : esc(L.orders)}</span></button>${st.arch === m ? a.map((o, i) => card(o, i + 1, now)).join("") : ""}`; }).join("")}</div>`;
      if (st.ask) { const [id, s] = st.ask, o = st.orders.find(x => x.id === id), lb = (STATS.find(x => x[0] === s) || [])[1];
        h += `<div class="ot-pop" data-ot-x="1"><div><b>${esc(lb)}</b><p>${fmt(real(o, s))} of ${fmt(goal(o, s))} (${pct(o, s)}%). Mark this goal complete?</p>
          <div class="ot-row"><button class="ot-btn" type="button" data-ot-mark="1">Mark complete</button><button class="ot-btn ghost" type="button" data-ot-x="1">Cancel</button></div></div></div>`; }
      root.innerHTML = h; countUp();
    }
    function toast(m) { const t = document.createElement("div"); t.className = "ot-toast"; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }

    // ---- taps -----------------------------------------------------------------
    root.addEventListener("click", async e => {
      const b = e.target.closest("[data-ot-m],[data-ot-ref],[data-ot-edit],[data-ot-save],[data-ot-del],[data-ot-copy],[data-ot-bot],[data-ot-mark],[data-ot-x],[data-ot-open],[data-ot-arch],[data-ot-pick],[data-ot-focus],[data-ot-who],[data-ot-deal]");
      if (!b) return; const d = b.dataset;
      if (d.otX && e.target !== b) return;
      if (d.otPick && e.target.closest("[data-ot-bot]")) return;
      if (d.otDeal) { if (opt.onDeal && !RO) opt.onDeal(); }
      else if (d.otWho !== undefined) { st.who = d.otWho || null; st.open = null; st.arch = null; draw(); }
      else if (d.otM) { st.month = d.otM; draw(); }
      else if (d.otRef) refresh(false);
      else if (d.otEdit) { st.edit = st.edit === d.otEdit ? null : d.otEdit; draw(); }
      else if (d.otSave) { const o = st.orders.find(x => x.id === d.otSave), c = b.closest(".ot-card"); o.goals = o.goals || {};
        c.querySelectorAll("[data-ot-f]").forEach(i => { o[i.dataset.otF] = i.dataset.otF === "link" ? cleanLink(i.value) : i.value.trim(); });
        const oldV = goal(o, "views");
        c.querySelectorAll("[data-ot-g]").forEach(i => { const v = i.value.trim() === "" ? 0 : parseNum(i.value); if (v != null) o.goals[i.dataset.otG] = v; });
        // a new views goal fills any empty goals from your rates (type them yourself and they stick)
        if (goal(o, "views") && goal(o, "views") !== oldV) STATS.slice(1).forEach(([s]) => { if (!goal(o, s)) o.goals[s] = Math.max(1, Math.round(goal(o, "views") * rates[s])); });
        st.edit = null; await save(); draw(); toast("Saved"); }
      else if (d.otDel) { const go = async () => { st.orders = st.orders.filter(x => x.id !== d.otDel); st.edit = null; await save(); draw(); toast("Deleted"); };
        if (opt.confirm) opt.confirm(L.order, go); else if (confirm("Delete this " + L.order + "?")) go(); }
      else if (d.otCopy) { try { await navigator.clipboard.writeText(d.otCopy); toast("Link copied"); } catch (er) { toast(d.otCopy); } }
      else if (d.otBot) { const [id, s] = d.otBot.split("|"), o = st.orders.find(x => x.id === id), S = state(o, s, Date.now());
        if (S === "idle" || RO) { b.animate([{ transform: "scale(.8)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], 380); return; }
        st.ask = [id, s]; draw(); }
      else if (d.otMark) { const [id, s] = st.ask, o = st.orders.find(x => x.id === id); bar(o, s).done = Date.now(); st.ask = null; await save(); draw(); }
      else if (d.otX) { st.ask = null; draw(); }
      else if (d.otOpen) { st.open = st.open === d.otOpen ? null : d.otOpen; draw(); }
      else if (d.otArch) { st.arch = st.arch === d.otArch ? null : d.otArch; draw(); }
      else if (d.otFocus) { const f = root.querySelector(".ot-log [name=title]"); if (f) { f.scrollIntoView({ behavior: "smooth", block: "center" }); f.focus(); } }
      else if (d.otPick && opt.onPick && !RO) { const [id, s] = d.otPick.split("|"), o = st.orders.find(x => x.id === id); if (!o) return;
        opt.onPick(o, s, res => setStat(o, s, res)); }
    });
    async function setStat(o, s, res) { o.goals = o.goals || {}; o.plan = o.plan || {};
      if (!res) { delete o.goals[s]; delete o.plan[s]; } else { o.goals[s] = res.qty; if (res.plan) o.plan[s] = res.plan; else delete o.plan[s]; }
      await save(); draw(); }
    root.addEventListener("submit", async e => {
      if (!e.target.matches("[data-ot-log]")) return; e.preventDefault();
      const f = e.target, link = cleanLink(f.link.value), title = f.title.value.trim();
      if (!link) { toast("Paste the post link"); return; }
      const o = { id: uid(), title, link, postedAt: Date.now(), month: monthKey(Date.now()), goals: {}, real: {}, bars: {} };
      if (opt.me) o._by = opt.me; if (st.who && st.who !== o._by) st.who = null;
      st.orders.push(o); await save(); draw(); toast("Logged");
      if (opt.onLogged && !RO) opt.onLogged(o, (s, res) => setStat(o, s, res));
      if (preview) { try { const r = await preview.fetch(link); if (r) { applyReal(o, r, Date.now()); await save(); draw(); } } catch (er) {} }
    });

    // ---- start ----------------------------------------------------------------
    store.load().then(o => { st.orders = Array.isArray(o) ? o : []; draw(); refresh(true); });
    const every = (opt.refreshEveryMin || 10) * 60e3;
    const tick = setInterval(() => { if (!document.hidden) refresh(true); }, every);
    const redraw = setInterval(() => { if (!document.hidden && !root.querySelector("input:focus")) draw(); }, 60e3); // stall colors move with time
    async function reload() { if (st.edit || st.ask || root.querySelector("input:focus")) return;
      try { const o = await store.load(); if (Array.isArray(o)) { st.orders = o; draw(); } } catch (e) {} }
    return { refresh: () => refresh(false), reload, redraw: () => draw(), destroy() { clearInterval(tick); clearInterval(redraw); root.innerHTML = ""; root.classList.remove("ot"); }, get orders() { return st.orders; } };
  }

  global.OrderTracker = { mount, cleanLink };
})(typeof window !== "undefined" ? window : globalThis);
