'use strict';
(() => {
  const VERSION = '3.0（2026-11-16 記録を GitHub に保存）';
  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  const LS = { settings: 'pl.settings', records: 'pl.records', queue: 'pl.queue', session: 'pl.session', sel: 'pl.sel' };
  function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }

  const SENS = {
    strict: { maxDrift: 0.009, minStable: 0.8, highDrift: 0.004 },
    normal: {},
    loose: { maxDrift: 0.015, minStable: 0.7, highF: 800 },
  };
  const SENS_LABEL = [['strict', 'きびしめ'], ['normal', 'ふつう'], ['loose', 'ゆるめ']];
  const AUTO_OPTS = [3, 5, 10, 15];
  const GOALS = [0, 10, 15, 20, 30, 45, 60, 90, 120];
  const DEFAULT_GOAL = { w: 20, h: 45 };   // minutes on weekdays / on Saturdays, Sundays and holidays (2026-11-15)
  const NCOLORS = 5;
  const CONFIRM_MS = 15000; // a note counts as practice when another note was heard within 15 s
  const LEAD_MS = 5000;     // record from 5 s before the first piano sound…
  const TAIL_MS = 10000;    // …to 10 s after the last one
  const MIN_SEC = 30;       // shorter than this is not recorded

  let settings = load(LS.settings, null);
  const firstRun = !settings;
  if (!settings) {
    settings = {
      people: [
        { id: 'p1', name: 'おとうさん', goalW: DEFAULT_GOAL.w, goalH: DEFAULT_GOAL.h, color: 0 },
        { id: 'p2', name: '長男', goalW: DEFAULT_GOAL.w, goalH: DEFAULT_GOAL.h, color: 1 },
        { id: 'p3', name: '次男', goalW: DEFAULT_GOAL.w, goalH: DEFAULT_GOAL.h, color: 2 },
      ],
      autoMin: 5, sens: 'normal', cloud: '', updatedAt: 0,
    };
  }
  // before v2.2 there was one goal per person; weekday/holiday goals start from the new defaults
  function normalizePeople(s) {
    let changed = false;
    for (const p of s.people) {
      if (p.goalW === undefined || p.goalH === undefined) { p.goalW = DEFAULT_GOAL.w; p.goalH = DEFAULT_GOAL.h; changed = true; }
      if ('goal' in p) { delete p.goal; changed = true; }
    }
    return changed;
  }
  if (normalizePeople(settings) && !firstRun) { settings.updatedAt = Date.now(); save(LS.settings, settings); }
  if (!settings.since) {
    // the first day of use: the earliest record, or today
    const ks = load(LS.records, []).map((r) => r.date).sort();
    const t = new Date();
    settings.since = ks[0] || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    if (!firstRun) save(LS.settings, settings);
  }
  let records = load(LS.records, []);
  let queue = load(LS.queue, []);
  let selected = new Set(load(LS.sel, []));
  let syncState = settings.cloud ? 'wait' : 'local';

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const dkey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const WD = '日月火水木金土';
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmtDate(k) { const d = parseKey(k); return `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }
  function fmtMin(min) { if (min < 60) return `${min}分`; const h = Math.floor(min / 60), m = min % 60; return m ? `${h}時間${m}分` : `${h}時間`; }
  // practice time with seconds: 0分 / 45秒 / 12分34秒 / 1時間5分12秒
  function fmtSec(sec) {
    const s = Math.max(0, Math.round(sec));
    const hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    if (!s) return '0分';
    const tail = ss ? `${ss}秒` : '';
    if (hh) return `${hh}時間${m}分${tail}`;
    if (!m) return `${ss}秒`;
    return `${m}分${tail}`;
  }
  // goals: weekday or holiday (Saturday, Sunday and 祝日 — calendar.js)
  const isOff = (d) => JPCal.isOff(d);
  const goalOn = (p, d) => (isOff(d) ? p.goalH : p.goalW) || 0;
  function dayKind(d) {
    const name = JPCal.holidayName(d);
    return name || (isOff(d) ? '休日' : '平日');
  }
  function mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.entries(v).forEach(([a, b]) => el.style.setProperty(a, b));
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  const colorOf = (p) => `var(--p${(p ? p.color : 0) % NCOLORS})`;
  const person = (id) => settings.people.find((p) => p.id === id);
  function namesOf(ids, recNames) {
    const ns = ids.map((id) => person(id)).filter(Boolean).map((p) => p.name || '？');
    return ns.length ? ns.join('・') : (recNames || '');
  }
  function chip(id, fallback) {
    const p = person(id);
    return h('span', { class: 'chip', style: { '--c': colorOf(p) }, text: p ? (p.name || '？') : (fallback || id) });
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- records ----------
  function liveRecords() {
    const del = new Set(queue.filter((q) => q.action === 'delete').map((q) => q.id));
    return records.filter((r) => !del.has(r.id));
  }
  const secOf = (r) => (r.sec > 0 ? r.sec : (r.min || 0) * 60);
  // seconds practiced per person on one day
  function secondsOn(dateKey) {
    const m = new Map();
    for (const r of liveRecords()) if (r.date === dateKey) for (const id of r.people) m.set(id, (m.get(id) || 0) + secOf(r));
    return m;
  }
  // a Monday-to-Sunday week: goal for the whole week, goal for the days before `upTo`, and seconds practiced
  // goals count from the first day the app was used (no shortfall for the days before it)
  function sinceKey() {
    let k = settings.since || dkey(new Date());
    for (const r of liveRecords()) if (r.date < k) k = r.date;
    return k;
  }
  function weekOf(p, monday, upTo) {
    let goalAll = 0, goalPast = 0, done = 0;
    const since = sinceKey();
    for (let i = 0; i < 7; i++) {
      const d = addDays(monday, i);
      if (dkey(d) < since) continue;
      const g = goalOn(p, d) * 60;
      goalAll += g;
      if (d < upTo) goalPast += g;
      done += secondsOn(dkey(d)).get(p.id) || 0;
    }
    return { goalAll, goalPast, done };
  }
  function streak(id) {
    const days = new Set(liveRecords().filter((r) => r.people.includes(id) && secOf(r) > 0).map((r) => r.date));
    let d = new Date(), n = 0;
    if (!days.has(dkey(d))) d = addDays(d, -1);
    while (days.has(dkey(d))) { n++; d = addDays(d, -1); }
    return n;
  }
  function addRecord(rec) {
    records.push(rec);
    queue.push({ action: 'add', record: rec });
    save(LS.records, records); save(LS.queue, queue);
    flush();
  }
  function removeRecord(id) {
    const pendingAdd = flushing ? -1 : queue.findIndex((q) => q.action === 'add' && q.record.id === id);
    const rec = records.find((r) => r.id === id);
    if (pendingAdd >= 0) queue.splice(pendingAdd, 1);
    else queue.push({ action: 'delete', id, date: rec ? rec.date : '' });
    records = records.filter((r) => r.id !== id || pendingAdd < 0);
    save(LS.records, records); save(LS.queue, queue);
    flush();
  }
  function makeRecord(begin, end, sec, ids, how) {
    const b = new Date(begin), e = new Date(end);
    return {
      id: newId(), date: dkey(b), start: hm(b), end: hm(e),
      min: Math.max(1, Math.round(sec / 60)), sec,
      people: ids.slice(), names: namesOf(ids), how, savedAt: new Date().toISOString(),
    };
  }

  // ---------- cloud (private data repository on GitHub, shared with 習慣きろく; see ghstore.js) ----------
  // settings.cloud holds the 接続コード (KIROKU1:…). Records live in piano/records-<year>.json, the settings in piano/settings.json.
  const validCode = (c) => GHStore.isCode(c);
  const L = GHStore.Layout;
  const yearOf = (r) => +String(r.date).slice(0, 4);
  let store = null, storeCode = '', fileCache = {};   // fileCache: path → { sha, records | settings } as last read
  function theStore() {
    if (storeCode !== settings.cloud) { storeCode = settings.cloud; store = GHStore.create(GHStore.decodeCode(storeCode)); fileCache = {}; }
    return store;
  }
  // everything in the repository; only files that changed since the last look are read again
  async function cloudGet() {
    const st = theStore();
    let recs = [], set = null;
    for (const f of await st.tree()) {
      const k = L.kindOf(f.path);
      if (!k || (k.kind !== 'pianoYear' && k.kind !== 'pianoSettings')) continue;
      let c = fileCache[f.path];
      if (!c || c.sha !== f.sha) {
        const text = await st.blob(f.sha);
        c = fileCache[f.path] = k.kind === 'pianoYear' ? { sha: f.sha, records: L.parsePianoYear(text) } : { sha: f.sha, settings: L.json(text) };
      }
      if (k.kind === 'pianoYear') recs = recs.concat(c.records); else set = c.settings;
    }
    return { ok: true, records: recs, settings: set };
  }
  // adds sessions of one year (those already there are left alone)
  function cloudAdd(list, year) {
    return theStore().update(L.pianoYear(year), (text) => {
      const have = text ? L.parsePianoYear(text) : [];
      const ids = new Set(have.map((r) => r.id));
      const fresh = list.filter((r) => !ids.has(r.id));
      return { text: fresh.length || !text ? L.formatPianoYear(year, have.concat(fresh)) : text };
    }, `piano: ${list[0].date}${list.length > 1 ? ` (+${list.length - 1})` : ''}`);
  }
  async function cloudDelete(id, date) {
    const st = theStore();
    // the year is known from the date; a delete queued by an older version has none, so look in every year
    const paths = date ? [L.pianoYear(yearOf({ date }))]
      : (await st.tree()).map((f) => f.path).filter((p) => (L.kindOf(p) || {}).kind === 'pianoYear');
    for (const path of paths) {
      await st.update(path, (text) => {
        if (!text) return { text: L.formatPianoYear((L.kindOf(path) || {}).year, []) };
        const have = L.parsePianoYear(text);
        const left = have.filter((r) => r.id !== id);
        return { text: left.length === have.length ? text : L.formatPianoYear(L.kindOf(path).year, left) };
      }, 'piano: delete');
    }
  }
  function cloudSettings(set) {
    return theStore().update(L.pianoSettings, (text) => {
      const remote = text ? L.json(text) : null;
      if (remote && (remote.updatedAt || 0) > (set.updatedAt || 0)) return { text };   // a newer one is already saved
      return { text: L.formatJson(set) };
    }, 'piano: settings');
  }
  let syncKind = '';
  let flushing = null;
  function flush() {
    if (!validCode(settings.cloud)) { syncState = 'local'; renderSync(); return Promise.resolve(); }
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        while (queue.length) {
          const q = queue[0];
          let sent = [q];
          if (q.action === 'add') {
            // all waiting sessions of the same year go up in one write
            sent = queue.filter((x) => x.action === 'add' && yearOf(x.record) === yearOf(q.record));
            await cloudAdd(sent.map((x) => x.record), yearOf(q.record));
          } else if (q.action === 'delete') {
            await cloudDelete(q.id, q.date);
            // gone from the repository: drop it here too (until now only the waiting delete hid it)
            records = records.filter((r) => r.id !== q.id);
            save(LS.records, records);
          } else {
            await cloudSettings(q.settings);
          }
          queue = queue.filter((x) => !sent.includes(x));
          save(LS.queue, queue);
        }
        syncState = 'ok';
      } catch (e) {
        syncState = 'offline';
        syncKind = (e && e.kind) || '';
      }
    })().finally(() => {
      // runs after the assignment below, even when the queue was already empty
      flushing = null;
      renderSync();
    });
    return flushing;
  }
  let lastRefresh = 0;
  async function refreshCloud(force) {
    if (!validCode(settings.cloud)) { syncState = 'local'; renderSync(); return; }
    if (!force && Date.now() - lastRefresh < 20000) return;
    lastRefresh = Date.now();
    await flush();
    try {
      const j = await cloudGet();
      const pending = queue.filter((q) => q.action === 'add').map((q) => q.record);
      const ids = new Set(j.records.map((r) => r.id));
      records = j.records.concat(pending.filter((r) => !ids.has(r.id)));
      save(LS.records, records);
      if (j.settings && j.settings.people && (j.settings.updatedAt || 0) > (settings.updatedAt || 0)) {
        settings = Object.assign({}, settings, j.settings, { cloud: settings.cloud });
        if (normalizePeople(settings)) pushSettings();
        save(LS.settings, settings);
      }
      syncState = queue.length ? 'offline' : 'ok';
    } catch (e) {
      syncState = 'offline';
      syncKind = (e && e.kind) || '';
    }
    if (!sess) renderHome();
    renderSync();
  }
  function pushSettings() {
    queue = queue.filter((q) => q.action !== 'settings');
    const { people, autoMin, sens, since, updatedAt } = settings;
    queue.push({ action: 'settings', settings: { people, autoMin, sens, since, updatedAt } });
    save(LS.queue, queue);
    flush();
  }
  function renderSync() {
    const el = $('sync');
    const pend = queue.filter((q) => q.action !== 'settings').length;
    el.classList.toggle('bad', syncState === 'offline' || (syncState === 'local' && records.length > 0));
    const codeTrouble = syncState === 'offline' && ['auth', 'forbidden', 'notfound'].includes(syncKind);
    if (syncState === 'local') el.textContent = '記録はこの端末の中だけに保存しています（設定で保存先につなげられます）';
    else if (codeTrouble) el.textContent = `保存先につながりません（接続コードの期限切れかもしれません）。設定の「記録の保存先」を見てください${pend ? `（送れていない記録 ${pend}件）` : ''}`;
    else if (syncState === 'offline') el.textContent = pend ? `まだ送れていない記録が ${pend}件あります。ネットにつながったら送ります` : '保存先につながりません。あとでもう一度ためします';
    else if (syncState === 'ok') el.textContent = '保存ずみ';
    else el.textContent = '保存先を確認しています…';
  }

  // ---------- keyboard drawings ----------
  const WHITE_PC = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]]; // [pitch class, after white index]
  function keyboardSvg(svg, octaves, w, ht, withIds) {
    const ns = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', `0 0 ${octaves * 7 * w} ${ht}`);
    svg.replaceChildren();
    for (let o = 0; o < octaves; o++) {
      WHITE_PC.forEach((pc, i) => {
        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', (o * 7 + i) * w + 0.5); r.setAttribute('y', 0.5);
        r.setAttribute('width', w - 1); r.setAttribute('height', ht - 1); r.setAttribute('rx', 2);
        r.setAttribute('class', 'w');
        if (withIds) r.id = `k${o}-${pc}`;
        svg.append(r);
      });
    }
    for (let o = 0; o < octaves; o++) {
      BLACK.forEach(([pc, after]) => {
        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', (o * 7 + after + 1) * w - w * 0.3); r.setAttribute('y', 0);
        r.setAttribute('width', w * 0.6); r.setAttribute('height', ht * 0.6); r.setAttribute('rx', 1.5);
        r.setAttribute('class', 'b');
        if (withIds) r.id = `k${o}-${pc}`;
        svg.append(r);
      });
    }
  }

  // ---------- home ----------
  function show(view) {
    for (const v of ['home', 'session', 'result']) $(v).hidden = v !== view;
    window.scrollTo(0, 0);
  }
  function renderHome() {
    const now = new Date();
    const todayKey = dkey(now);
    $('today').textContent = `${fmtDate(todayKey)}・${dayKind(now)}`;
    $('autoMinHint').textContent = settings.autoMin;
    const ts = secondsOn(todayKey);
    // players
    for (const id of [...selected]) if (!person(id)) selected.delete(id);
    $('people').replaceChildren(...settings.people.map((p) => {
      const sec = ts.get(p.id) || 0;
      const goal = goalOn(p, now);
      const pct = goal ? Math.min(100, Math.round(sec / (goal * 60) * 100)) : (sec ? 100 : 0);
      const st = streak(p.id);
      return h('button', {
        class: 'person', type: 'button', 'aria-pressed': selected.has(p.id) ? 'true' : 'false',
        style: { '--c': colorOf(p) },
        onclick: () => { selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id); save(LS.sel, [...selected]); renderHome(); },
      },
      h('span', { class: 'check', 'aria-hidden': 'true' }, svgCheck()),
      h('span', { class: 'ring', style: { '--pct': pct } }, h('span', { class: 'face', text: (p.name || '？').slice(0, 1) })),
      h('span', { class: 'name', text: p.name || '？' }),
      h('span', { class: 'today' }, h('b', { class: 'num', text: fmtSec(sec) })),
      h('span', { class: 'goalline', text: goal ? (sec >= goal * 60 ? '今日の目標 たっせい' : `今日の目標 ${goal}分`) : '' }),
      h('span', { class: 'streak', text: st >= 2 ? `${st}日れんぞく` : '' }));
    }));
    renderAlert(now);
    const sel = settings.people.filter((p) => selected.has(p.id));
    $('start').disabled = !sel.length;
    $('startSub').textContent = !sel.length ? '名前をタップしてえらんでね'
      : sel.length === 1 ? `${sel[0].name} のれんしゅう` : `${sel.map((p) => p.name).join('・')} の連弾`;
    renderWeek();
    renderHist();
    renderSync();
  }
  // weekly check (Monday–Sunday): this week's practice against the goals of the days before today
  // (today's goal only counts once today is over). On Mondays: how last week ended.
  function renderAlert(now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const mon = mondayOf(today);
    const rows = [], last = [];
    for (const p of settings.people) {
      const w = weekOf(p, mon, today);
      const short = w.goalPast - w.done;
      if (short > 0) {
        rows.push(h('div', { class: 'arow' }, chip(p.id),
          h('span', null, 'あと ', h('b', { class: 'num', text: fmtSec(short) }), ' 足りません',
            h('span', { class: 'adetail num', text: `きのうまでの目標 ${fmtMin(Math.round(w.goalPast / 60))}・今週 ${fmtSec(w.done)}` }))));
      }
    }
    if (today.getDay() === 1) {
      const lastMon = addDays(mon, -7);
      for (const p of settings.people) {
        const w = weekOf(p, lastMon, mon);
        const short = w.goalAll - w.done;
        if (short > 0) {
          last.push(h('div', { class: 'arow' }, chip(p.id),
            h('span', null, '先週は ', h('b', { class: 'num', text: fmtSec(short) }), ' 足りませんでした',
              h('span', { class: 'adetail num', text: `目標 ${fmtMin(Math.round(w.goalAll / 60))}・練習 ${fmtSec(w.done)}` }))));
        }
      }
    }
    const box = $('alert');
    box.hidden = !rows.length && !last.length;
    if (box.hidden) return;
    box.replaceChildren(
      h('div', { class: 'atitle', text: rows.length ? '今週の練習が足りていません' : '先週の練習が足りませんでした' }),
      ...rows, ...last,
      h('div', { class: 'ahint', text: rows.length ? 'ほかの日に少し長く弾いて、今週のうちに取りもどそう' : '今週はがんばろう' }));
  }
  function svgCheck() {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#fff'); s.setAttribute('stroke-width', '3.5');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    s.append(p);
    return s;
  }
  function renderWeek() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const mon = mondayOf(today);
    const days = [];
    for (let i = 0; i < 7; i++) { const d = addDays(mon, i); days.push({ d, k: dkey(d), m: secondsOn(dkey(d)) }); }
    let max = 600;
    for (const p of settings.people) max = Math.max(max, (p.goalW || 0) * 60, (p.goalH || 0) * 60);
    for (const x of days) for (const v of x.m.values()) max = Math.max(max, v);
    const l = days[6].d;
    $('weekRange').textContent = `${mon.getMonth() + 1}/${mon.getDate()}（月）〜${l.getMonth() + 1}/${l.getDate()}（日）`;
    $('week').replaceChildren(...days.map((x) => {
      const isToday = x.k === dkey(today), future = x.d > today;
      return h('div', { class: 'day' + (isToday ? ' today' : '') + (isOff(x.d) ? ' off' : '') + (future ? ' future' : ''), title: dayKind(x.d) },
        h('div', { class: 'bars' }, settings.people.map((p) => {
          const v = x.m.get(p.id) || 0;
          return h('span', { class: 'bar' + (v ? '' : ' zero'), title: `${p.name} ${fmtSec(v)}`, style: { '--c': colorOf(p), height: `${(v / max * 100).toFixed(1)}%` } });
        })),
        h('div', { class: 'dl' }, isToday ? '今日' : WD[x.d.getDay()], h('br'), `${x.d.getDate()}`));
    }));
    const month = new Map();
    const mPrefix = dkey(today).slice(0, 7);
    for (const r of liveRecords()) if (r.date.startsWith(mPrefix)) for (const id of r.people) month.set(id, (month.get(id) || 0) + secOf(r));
    $('legend').replaceChildren(...settings.people.map((p) => {
      const w = weekOf(p, mon, today);
      return h('div', { class: 'lrow', style: { '--c': colorOf(p) } },
        h('i'), h('span', { class: 'lname', text: p.name || '？' }),
        h('span', { class: 'num' }, h('b', { text: fmtSec(w.done) }), w.goalAll ? ` / ${fmtMin(Math.round(w.goalAll / 60))}` : ''),
        h('span', { class: 'lmonth num', text: `${today.getMonth() + 1}月 ${fmtSec(month.get(p.id) || 0)}` }));
    }));
  }
  function renderHist() {
    const list = liveRecords().slice().sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)).slice(0, 30);
    if (!list.length) {
      $('hist').replaceChildren(h('div', { class: 'empty', text: 'まだ記録がありません。名前をえらんで「れんしゅうスタート」を押してね。' }));
      return;
    }
    $('hist').replaceChildren(...list.map((r) => {
      const del = h('button', { class: 'del', type: 'button', text: '消す' });
      del.addEventListener('click', () => {
        if (!del.classList.contains('sure')) {
          del.classList.add('sure'); del.textContent = '本当に消す';
          setTimeout(() => { del.classList.remove('sure'); del.textContent = '消す'; }, 4000);
          return;
        }
        removeRecord(r.id); renderHome(); toast('記録を消しました');
      });
      const who = r.people.length ? r.people.map((id) => chip(id, r.names)) : [h('span', { class: 'chip', text: r.names })];
      return h('div', { class: 'hrow' },
        h('div', null, h('div', { class: 'when num', text: `${fmtDate(r.date)} ${r.start}${r.how === '手で追加' ? '（手で追加）' : ''}` }), h('div', { class: 'who' }, who)),
        h('div', { class: 'min num', text: fmtSec(secOf(r)) }),
        del);
    }));
  }

  // manual entry
  const manualSel = new Set();
  function renderManual() {
    $('manualWho').replaceChildren(...settings.people.map((p) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': manualSel.has(p.id) ? 'true' : 'false',
      style: { '--c': colorOf(p), border: manualSel.has(p.id) ? '2px solid var(--c)' : '2px solid transparent', padding: '4px 12px 4px 10px' },
      onclick: () => { manualSel.has(p.id) ? manualSel.delete(p.id) : manualSel.add(p.id); renderManual(); },
      text: p.name || '？',
    })));
  }
  $('addManual').addEventListener('click', () => {
    const f = $('manual');
    f.hidden = !f.hidden;
    if (!f.hidden) { $('manualDate').value = dkey(new Date()); $('manualMin').value = ''; manualSel.clear(); selected.forEach((id) => manualSel.add(id)); renderManual(); }
  });
  $('manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const min = Math.round(Number($('manualMin').value));
    const date = $('manualDate').value;
    const ids = settings.people.filter((p) => manualSel.has(p.id)).map((p) => p.id);
    if (!ids.length) { toast('だれの記録か えらんでください'); return; }
    if (!(min > 0 && min <= 600) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('日付と分を入れてください'); return; }
    const rec = { id: newId(), date, start: '', end: '', min, sec: min * 60, people: ids, names: namesOf(ids), how: '手で追加', savedAt: new Date().toISOString() };
    addRecord(rec);
    $('manual').hidden = true;
    renderHome();
    toast(`${rec.names} ${min}分 を追加しました`);
  });

  // ---------- microphone ----------
  let audio = null;
  // paused: build everything but leave the microphone off (the score player is sounding);
  // resumeMic() connects it later without a tap, because the AudioContext was started by this tap
  async function startMic(onNote, onJudge, paused) {
    stopMic();
    const AC = window.AudioContext || window.webkitAudioContext;
    const a = { ctx: null, stream: null, det: null, lastMsg: 0, live: false, liveSince: Date.now(), error: '', paused: false };
    audio = a;
    try {
      a.ctx = new AC();
      a.ctx.resume().catch(() => {});
    } catch (e) {
      a.error = 'このブラウザでは音を調べられません';
      return a;
    }
    const ctx = a.ctx;
    a.det = new PianoDetector(ctx.sampleRate, Object.assign({}, SENS[settings.sens] || {}, { onNote }));
    a.det.onJudge = onJudge || null;
    let node;
    try {
      await ctx.audioWorklet.addModule('tap-worklet.js');
      node = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => { a.lastMsg = Date.now(); a.det.push(e.data); };
    } catch (e) {
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => { a.lastMsg = Date.now(); a.det.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
    }
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink); sink.connect(ctx.destination);
    a.node = node; a.sink = sink;
    if (audio !== a) return a;
    if (paused) { a.paused = true; return a; }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no getUserMedia'), { name: 'NoMedia' });
      const stream = await getMic();
      if (audio !== a) { stream.getTracks().forEach((t) => t.stop()); return a; }
      a.stream = stream;
      a.src = ctx.createMediaStreamSource(stream);
      a.src.connect(node);
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    } catch (e) {
      const n = e && e.name;
      a.error = n === 'NotAllowedError' ? 'マイクが許可されていません（Safari の設定でマイクを「許可」に）'
        : n === 'NotFoundError' ? 'マイクが見つかりません'
        : n === 'NoMedia' ? 'このページではマイクを使えません（https で開いてください）'
        : `マイクを使えません（${n || e}）`;
    }
    return a;
  }
  function stopMic() {
    const a = audio;
    audio = null;
    if (!a) return;
    try { a.node && (a.node.port ? (a.node.port.onmessage = null) : (a.node.onaudioprocess = null)); } catch (e) { /* ignore */ }
    try { a.src && a.src.disconnect(); a.node && a.node.disconnect(); a.sink && a.sink.disconnect(); } catch (e) { /* ignore */ }
    try { a.stream && a.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { a.ctx && a.ctx.close(); } catch (e) { /* ignore */ }
    setSessionType(navigator, 'auto');
  }

  // iPad (Safari): the score player sets navigator.audioSession.type = 'playback' to play loudly, and
  // while any document of the page is 'playback', getUserMedia fails with InvalidStateError.
  // So before recording: this page asks for 'play-and-record' and the player's frame goes back to 'auto'.
  function setSessionType(nav, type) {
    try { if (nav && nav.audioSession && nav.audioSession.type !== type) nav.audioSession.type = type; } catch (e) { /* ignore */ }
  }
  function prepareCapture() {
    setSessionType(navigator, 'play-and-record');
    if (playerSound) return;   // the player is sounding: leave it alone (the mic is paused then anyway)
    try {
      const f = document.querySelector('#scoreView iframe');
      const nav = f && f.contentWindow && f.contentWindow.navigator;
      if (nav && nav.audioSession && nav.audioSession.type === 'playback') setSessionType(nav, 'auto');
    } catch (e) { /* ignore */ }
  }
  const MIC = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } };
  async function getMic() {
    prepareCapture();
    try {
      return await navigator.mediaDevices.getUserMedia(MIC);
    } catch (e) {
      if (!e || e.name !== 'InvalidStateError') throw e;
      // the audio session may need a moment to switch: try once more
      await new Promise((r) => setTimeout(r, 400));
      prepareCapture();
      return navigator.mediaDevices.getUserMedia(MIC);
    }
  }
  // 楽譜の音を鳴らしているあいだはマイクを止める（iPad は録音中だと再生の音が小さくなるため）。
  // AudioContext は動かしたままにして、止めたあとはタップなしでマイクだけつなぎ直す
  function pauseMic() {
    const a = audio;
    if (!a || !a.stream) return;
    a.paused = true;
    try { a.src && a.src.disconnect(); } catch (e) { /* ignore */ }
    try { a.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    a.stream = null;
    a.live = false;
    setSessionType(navigator, 'auto');   // let the player's 'playback' decide while it sounds
  }
  async function resumeMic() {
    const a = audio;
    if (!a || !a.paused) return;
    try {
      const stream = await getMic();
      if (audio !== a || !a.paused) { stream.getTracks().forEach((t) => t.stop()); return; }
      a.stream = stream;
      a.src = a.ctx.createMediaStreamSource(stream);
      a.src.connect(a.node);
      a.paused = false;
      if (a.ctx.state !== 'running') a.ctx.resume().catch(() => {});
    } catch (e) {
      a.paused = false;
      a.error = `マイクを再開できませんでした（${(e && e.name) || e}）`;
    }
  }
  function micLive() {
    const a = audio;
    if (!a || !a.stream) return false;
    const t = a.stream.getAudioTracks()[0];
    const ok = a.ctx.state === 'running' && !!t && t.readyState === 'live' && !t.muted && Date.now() - a.lastMsg < 2500;
    if (ok && !a.live) a.liveSince = Date.now();
    a.live = ok;
    return ok;
  }
  function meterPct() {
    const a = audio;
    if (!a || !a.det) return 0;
    return Math.max(0, Math.min(100, (a.det.E + 72) / 60 * 100));
  }

  // keep the screen on while practicing
  let wakeLock = null;
  async function wake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { wakeLock = null; }
  }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }

  // ---------- practice session ----------
  let sess = null;
  let lastPersist = 0;
  function persistSession(force) {
    if (!sess) { save(LS.session, null); return; }
    if (force || Date.now() - lastPersist > 5000) { save(LS.session, sess); lastPersist = Date.now(); }
  }
  function onSessionNote(ev) {
    if (!sess) return;
    const now = Date.now();
    const st = $('micStatus');
    st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
    if (sess.prevNote && now - sess.prevNote <= CONFIRM_MS) {
      if (!sess.first) sess.first = sess.prevNote;
      sess.last = now;
    }
    sess.prevNote = now;
    persistSession();
  }
  async function startSession() {
    const ids = settings.people.filter((p) => selected.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    sess = { start: Date.now(), people: ids, first: 0, last: 0, prevNote: 0 };
    persistSession(true);
    enterSessionView();
    wake();
    await startMic(onSessionNote, null, playerSound);
    if (playerSound) pauseMic();   // the player started while the microphone was opening
  }
  function enterSessionView() {
    $('sessWho').replaceChildren(...sess.people.map((id) => chip(id)));
    show('session');
  }
  function finish(how) {
    if (!sess) return;
    const s = sess;
    sess = null;
    persistSession(true);
    stopMic();
    releaseWake();
    const now = Date.now();
    let rec = null;
    if (s.first) {
      const begin = Math.max(s.start, s.first - LEAD_MS);
      const end = Math.min(now, s.last + TAIL_MS);
      const sec = Math.round((end - begin) / 1000);
      if (sec >= MIN_SEC) rec = makeRecord(begin, end, sec, s.people, how);
    }
    showResult(s, rec, now);
    setView('log');   // ended while the score was shown: show the result
  }
  function showResult(s, rec, now) {
    const names = namesOf(s.people);
    $('resForce').hidden = true;
    $('resUndo').hidden = !rec;
    if (rec) {
      addRecord(rec);
      $('resMsg').textContent = `${names}、おつかれさま！`;
      const m = Math.floor(rec.sec / 60), sc = rec.sec % 60;
      $('resMin').replaceChildren(...(m ? [String(m), h('small', { text: '分' })] : []), String(sc), h('small', { text: '秒' }));
      const totalSec = Math.round((now - s.start) / 1000);
      $('resNote').textContent = `${rec.start}〜${rec.end} の記録です` + (totalSec - rec.sec >= 120 ? `（スタートから ${fmtSec(totalSec)}のうち、ピアノが鳴っていたあいだ）` : '');
      $('resUndo').onclick = () => { removeRecord(rec.id); toast('記録を取り消しました'); backHome(); };
    } else {
      const total = Math.round((now - s.start) / 60000);
      $('resMsg').textContent = s.first ? 'とても短かったので、記録していません' : 'ピアノの音が聞こえませんでした';
      $('resMin').replaceChildren(h('small', { text: '記録していません' }));
      $('resNote').textContent = s.first ? '' : 'マイクがピアノの音を拾えなかったときは、下のボタンで記録できます。';
      if (total >= 1) {
        const f = $('resForce');
        f.hidden = false;
        f.textContent = `それでも記録する（${total}分）`;
        f.onclick = () => showResult(s, makeRecord(s.start, now, Math.round((now - s.start) / 1000), s.people, 'マイクなし'), now);
      }
    }
    renderTally(s);
    show('result');
  }
  function renderTally(s) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ts = secondsOn(dkey(now));
    $('resTally').replaceChildren(...s.people.map((id) => {
      const p = person(id);
      if (!p) return '';
      const sec = ts.get(id) || 0;
      const goal = goalOn(p, now) * 60;
      const st = streak(id);
      // this week including today: how much is still missing of the goals up to and including today
      const w = weekOf(p, mondayOf(today), addDays(today, 1));
      const weekShort = w.goalPast - w.done;
      return h('div', { style: { '--c': colorOf(p) } }, chip(id),
        h('b', { class: 'num', text: `今日 ${fmtSec(sec)}` }),
        goal && sec >= goal ? h('span', { class: 'goal', text: '今日の目標たっせい！' }) : (goal ? h('span', { class: 'small num', text: `今日の目標まで あと${fmtSec(goal - sec)}` }) : ''),
        weekShort > 0 ? h('div', { class: 'small num warnline', text: `今週は あと${fmtSec(weekShort)} 足りません` }) : '',
        st >= 2 ? h('div', { class: 'small', text: `${st}日れんぞく` }) : '');
    }));
  }
  function backHome() { show('home'); renderHome(); refreshCloud(true); }

  // UI loop
  function tick() {
    renderPill();
    if (!sess) return;
    const now = Date.now();
    $('timer').textContent = fmtClock(now - sess.start);
    const a = audio;
    const live = micLive();
    const st = $('micStatus');
    let auto = '';
    if (playerSound) {
      // the score player is making sound: count it as practice, the microphone rests
      if (!sess.first) sess.first = now;
      sess.last = now;
      sess.prevNote = now;
      st.className = 'status on';
      $('micText').textContent = '楽譜の音を鳴らしています（れんしゅう中として数えます）';
    } else if (live) {
      const heard = sess.prevNote && now - sess.prevNote < 4000;
      st.className = 'status' + (heard ? ' on' : '') + (st.classList.contains('flash') ? ' flash' : '');
      $('micText').textContent = heard ? 'ピアノが聞こえています' : 'ピアノの音を待っています';
      const ref = Math.max(sess.last || sess.start, a.liveSince);
      const limit = settings.autoMin * 60000;
      const silent = now - ref;
      if (silent >= limit) { finish('自動'); return; }
      if (silent > 60000) auto = `ピアノの音が聞こえないと、あと ${fmtClock(limit - silent)} で自動で終わります`;
    } else {
      st.className = 'status off';
      $('micText').textContent = (a && a.error) ? a.error + '（タップでやり直す）' : (a && !a.stream ? 'マイクを準備しています…' : 'マイクが止まっています。ここをタップして再開');
      auto = 'マイクが止まっているあいだは、自動では終わりません';
    }
    $('autoInfo').textContent = auto;
    persistSession();
  }
  setInterval(tick, 200);

  $('start').addEventListener('click', startSession);
  $('stop').addEventListener('click', () => finish('ボタン'));
  $('micStatus').addEventListener('click', async () => {
    if (!sess) return;
    const a = audio;
    if (a && a.stream && a.ctx && a.stream.getAudioTracks()[0].readyState === 'live' && a.ctx.state !== 'running') {
      await a.ctx.resume().catch(() => {});
      if (a.ctx.state === 'running') return;
    }
    if (!micLive()) { wake(); await startMic(onSessionNote); }
  });
  $('resOk').addEventListener('click', backHome);

  // ---------- score player (player/index.html in an iframe) ----------
  let view = 'log';
  let playerSound = false;
  function setView(v) {
    view = v;
    document.body.classList.toggle('score', v === 'score');
    $('scoreView').hidden = v !== 'score';
    $('tabLog').setAttribute('aria-selected', String(v === 'log'));
    $('tabScore').setAttribute('aria-selected', String(v === 'score'));
    if (v === 'score' && !$('scoreView').firstChild) {
      $('scoreView').append(h('iframe', { src: 'player/index.html', title: '楽譜プレーヤー', allow: 'fullscreen; screen-wake-lock; autoplay' }));
    }
    renderPill();
  }
  function renderPill() {
    const show = !!sess && view === 'score';
    $('pill').hidden = !show;
    if (show) $('pillText').textContent = `れんしゅう中 ${fmtClock(Date.now() - sess.start)}`;
  }
  $('tabLog').addEventListener('click', () => setView('log'));
  $('tabScore').addEventListener('click', () => setView('score'));
  $('pill').addEventListener('click', () => setView('log'));
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'player-sound') return;
    const on = !!e.data.on;
    if (on === playerSound) return;
    playerSound = on;
    if (!sess) return;
    if (on) pauseMic(); else resumeMic();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (sess) wake();
    else if (!$('home').hidden) { renderHome(); refreshCloud(); }
  });
  window.addEventListener('online', () => flush());

  // ---------- settings ----------
  const dlg = $('settings');
  let testing = null;
  function renderSettings() {
    const goalSelect = (p, field, label) => {
      const s = h('select', { 'aria-label': `${p.name}の${label}の目標`, onchange: (e) => { p[field] = Number(e.target.value); } },
        GOALS.map((g) => h('option', { value: g, text: g ? `${g}分` : 'なし' })));
      s.value = String(p[field] || 0);
      return h('label', { class: 'gsel' }, h('span', { text: label }), s);
    };
    $('pEdit').replaceChildren(...settings.people.map((p, i) => h('div', { class: 'prow', style: { '--c': colorOf(p) } },
      h('i'),
      h('input', { type: 'text', value: p.name, maxlength: 12, 'aria-label': `${i + 1}人目の名前`, oninput: (e) => { p.name = e.target.value.trim(); } }),
      h('button', {
        class: 'del', type: 'button', 'aria-label': `${p.name}を消す`, text: '×', disabled: settings.people.length <= 1 ? true : null,
        onclick: () => { settings.people.splice(i, 1); renderSettings(); },
      }),
      h('div', { class: 'goals' }, goalSelect(p, 'goalW', '平日'), goalSelect(p, 'goalH', '休日・祝日')))));
    $('pAdd').disabled = settings.people.length >= 6;
    $('autoSeg').replaceChildren(...AUTO_OPTS.map((m) => h('button', {
      type: 'button', 'aria-pressed': settings.autoMin === m ? 'true' : 'false', text: `${m}分`,
      onclick: () => { settings.autoMin = m; renderSettings(); },
    })));
    $('sensSeg').replaceChildren(...SENS_LABEL.map(([k, label]) => h('button', {
      type: 'button', 'aria-pressed': settings.sens === k ? 'true' : 'false', text: label,
      onclick: () => { settings.sens = k; renderSettings(); if (testing) { stopTest(); startTest(); } },
    })));
  }
  $('pAdd').addEventListener('click', () => {
    let n = 1;
    while (settings.people.some((p) => p.id === 'p' + n)) n++;
    const used = new Set(settings.people.map((p) => p.color));
    let c = 0;
    while (used.has(c) && c < NCOLORS - 1) c++;
    settings.people.push({ id: 'p' + n, name: '', goalW: DEFAULT_GOAL.w, goalH: DEFAULT_GOAL.h, color: c });
    renderSettings();
    const inputs = $('pEdit').querySelectorAll('input');
    inputs[inputs.length - 1].focus();
  });
  // what the settings were when the dialog opened: only a real change is sent to the repository,
  // so that connecting a new device does not put its default names over the family's
  let settingsSnap = '';
  const settingsText = () => JSON.stringify([settings.people, settings.autoMin, settings.sens]);
  function openSettings(welcome) {
    settingsSnap = settingsText();
    $('welcome').hidden = !welcome;
    $('cloudCode').value = settings.cloud || '';
    $('cloudInfo').textContent = '';
    $('songKey').value = fmtKey(getSongKey());
    $('songKeyInfo').textContent = '';
    $('setupInfo').textContent = '';
    $('ver').textContent = `バージョン ${VERSION}`;
    renderSettings();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  // set the connection code; after connecting a new repository, send everything recorded on this device so far
  function connectCloud(url) {
    const changed = url !== settings.cloud;
    settings.cloud = url;
    save(LS.settings, settings);
    if (!changed) return;
    syncState = validCode(url) ? 'wait' : 'local';
    queue = queue.filter((q) => q.action !== 'settings');
    if (validCode(url)) {
      const pending = new Set(queue.filter((q) => q.action === 'add').map((q) => q.record.id));
      for (const r of records) if (!pending.has(r.id)) queue.push({ action: 'add', record: r });
    }
    save(LS.queue, queue);
    // settings made on this device before it was connected go up too (a newer one in the repository stays)
    if (validCode(url) && settings.updatedAt) pushSettings();
  }
  function closeSettings() {
    stopTest();
    settings.people.forEach((p, i) => { if (!p.name) p.name = `${i + 1}人目`; });
    const k = normKey($('songKey').value);
    if (k !== getSongKey()) setSongKey(k);
    const changed = settingsText() !== settingsSnap;
    if (changed) settings.updatedAt = Date.now();
    connectCloud($('cloudCode').value.trim());
    save(LS.settings, settings);
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    if (changed && validCode(settings.cloud)) pushSettings();
    renderHome();
    refreshCloud(true);
  }

  // ---------- 楽譜の合言葉（player/songpack.js と同じ方法で確かめる） ----------
  const KEY_STORE = 'pl.key';
  const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fmtKey = (s) => normKey(s).replace(/(.{4})(?=.)/g, '$1-');
  const getSongKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } };
  // saving fires a "storage" event in the score player's frame, which then uses the new passphrase
  function setSongKey(v) { try { const n = normKey(v); if (n) localStorage.setItem(KEY_STORE, n); else localStorage.removeItem(KEY_STORE); } catch (e) { /* storage blocked */ } }
  async function checkSongKey(pass) {
    const m = await (await fetch('player/packs/meta.json', { cache: 'no-cache' })).json();
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normKey(pass)), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(m.salt), iterations: m.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const c = b64(m.check);
    try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.subarray(4, 16) }, k, c.subarray(16)); return true; } catch (e) { return false; }
  }
  $('songKeyTest').addEventListener('click', async () => {
    const info = $('songKeyInfo');
    if (!normKey($('songKey').value)) { info.textContent = '合言葉を入れてください'; return; }
    info.textContent = 'たしかめています…';
    try {
      info.textContent = (await checkSongKey($('songKey').value)) ? '合言葉は正しいです（とじると保存します）' : '合言葉がちがいます';
    } catch (e) {
      info.textContent = 'たしかめられませんでした（ネットにつながっているか確認してください）';
    }
  });
  $('setupLink').addEventListener('click', async () => {
    const info = $('setupInfo');
    const k = normKey($('songKey').value) || getSongKey();
    const c = $('cloudCode').value.trim();
    const parts = [];
    if (k) parts.push('k=' + k);
    if (validCode(c)) parts.push('c=' + encodeURIComponent(c));
    if (!parts.length) { info.textContent = '合言葉か記録の保存先を入れてから作ってください'; return; }
    const link = location.origin + location.pathname + '#' + parts.join('&');
    try {
      await navigator.clipboard.writeText(link);
      info.textContent = 'コピーしました。LINE やメモに貼って残してください';
    } catch (e) {
      info.textContent = link;   // copy by hand
    }
  });
  // opening a setup link (#k=…&c=…) stores the passphrase and the connection code, then removes them from the address bar
  function readSetupLink() {
    const hash = location.hash.replace(/^#/, '');
    if (!/(^|&)(k|c)=/.test(hash)) return '';
    const p = new URLSearchParams(hash);
    const done = [];
    if (p.get('k')) { setSongKey(p.get('k')); done.push('楽譜の合言葉'); }
    const c = p.get('c');
    if (c && validCode(c)) { connectCloud(c); done.push('記録の保存先'); }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (done.length) setTimeout(() => toast(`${done.join('と')}を設定しました`), 400);
    return done.join(',');
  }
  $('openSettings').addEventListener('click', () => openSettings(false));
  $('closeSettings').addEventListener('click', closeSettings);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSettings(); });
  $('cloudTest').addEventListener('click', async () => {
    const code = $('cloudCode').value.trim();
    const info = $('cloudInfo');
    if (!validCode(code)) { info.textContent = '接続コードの形がちがいます（KIROKU1: で始まる文字をまるごと貼ってください）'; return; }
    info.textContent = 'たしかめています…';
    try {
      const tree = await GHStore.create(GHStore.decodeCode(code)).tree();
      const n = tree.filter((f) => (L.kindOf(f.path) || {}).kind === 'pianoYear').length;
      info.textContent = `つながりました（ピアノの記録ファイル ${n}こ）。とじると保存します`;
    } catch (e) {
      info.textContent = e.kind === 'offline' ? 'ネットにつながっていません'
        : e.kind === 'auth' ? 'つながりません。接続コードの期限が切れているかもしれません'
          : 'つながりません。接続コードを確認してください';
    }
  });

  // microphone test
  const REASON = { drift: '音の高さがゆれる', unstable: 'すぐ消える音', short: '短すぎる', swell: 'あとから大きくなる', 'no-partials': '音程のない音' };
  function startTest() {
    let nP = 0, nO = 0;
    $('tPiano').textContent = '0'; $('tOther').textContent = '0';
    $('tLog').replaceChildren();
    const log = (txt) => { const l = $('tLog'); l.prepend(h('div', { text: txt })); while (l.childNodes.length > 30) l.lastChild.remove(); };
    const t0 = Date.now();
    startMic(null, (ev) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      if (ev.piano) { nP++; $('tPiano').textContent = nP; log(`${t}秒  ピアノ${ev.via === 'high' ? '（高音）' : ''}  (${Math.round(ev.f0 || 0)} Hz)`); }
      else { nO++; $('tOther').textContent = nO; log(`${t}秒  ピアノ以外：${REASON[ev.why] || ev.why}`); }
    }).then((a) => {
      if (a.error) $('tInfo').textContent = a.error;
      else $('tInfo').textContent = `録音中（${Math.round(a.ctx.sampleRate / 100) / 10} kHz）`;
    });
    testing = setInterval(() => {
      $('tMeter').style.width = `${micLive() ? meterPct() : 0}%`;
      if (audio && audio.stream && !micLive()) $('tInfo').textContent = 'マイクが止まっています';
    }, 100);
    $('tStart').textContent = 'テスト終了';
  }
  function stopTest() {
    if (!testing) return;
    clearInterval(testing);
    testing = null;
    if (!sess) stopMic();
    $('tStart').textContent = 'テスト開始';
    $('tInfo').textContent = '';
    $('tMeter').style.width = '0%';
  }
  $('tStart').addEventListener('click', () => { if (testing) stopTest(); else startTest(); });

  // ---------- start ----------
  keyboardSvg($('keys'), 6, 12, 40, false);
  const fromLink = readSetupLink();
  const saved = load(LS.session, null);
  if (saved && saved.start && saved.people) {
    sess = saved;
    const ref = sess.last || sess.start;
    if (Date.now() - ref > settings.autoMin * 60000) {
      finish('自動');      // left open: record up to the last piano sound
    } else {
      enterSessionView();  // the microphone restarts when the status bar is tapped
    }
  } else {
    show('home');
    renderHome();
    // a setup link with the connection code brings the names from the repository, so no need to ask for them
    if (firstRun && !fromLink.includes('記録の保存先')) openSettings(true);
  }
  refreshCloud(true);
})();
