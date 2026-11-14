'use strict';
(() => {
  const VERSION = '1.2（2026-11-15 高音域）';
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
  const GOALS = [0, 10, 15, 20, 30, 45, 60];
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
        { id: 'p1', name: 'おとうさん', goal: 20, color: 0 },
        { id: 'p2', name: '長男', goal: 15, color: 1 },
        { id: 'p3', name: '次男', goal: 15, color: 2 },
      ],
      autoMin: 5, sens: 'normal', cloudUrl: '', updatedAt: 0,
    };
  }
  let records = load(LS.records, []);
  let queue = load(LS.queue, []);
  let selected = new Set(load(LS.sel, []));
  let syncState = settings.cloudUrl ? 'wait' : 'local';

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
  function minutesOn(dateKey) {
    const m = new Map();
    for (const r of liveRecords()) if (r.date === dateKey) for (const id of r.people) m.set(id, (m.get(id) || 0) + (r.min || 0));
    return m;
  }
  function streak(id) {
    const days = new Set(liveRecords().filter((r) => r.people.includes(id) && r.min > 0).map((r) => r.date));
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
    const pendingAdd = queue.findIndex((q) => q.action === 'add' && q.record.id === id);
    if (pendingAdd >= 0) queue.splice(pendingAdd, 1);
    else queue.push({ action: 'delete', id });
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

  // ---------- cloud (Google Apps Script web app) ----------
  const validUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u || '');
  async function cloudGet() {
    const r = await fetch(settings.cloudUrl + '?action=list&t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'error');
    return j;
  }
  async function cloudPost(body) {
    const r = await fetch(settings.cloudUrl, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'error');
    return j;
  }
  let flushing = null;
  function flush() {
    if (!validUrl(settings.cloudUrl)) { syncState = 'local'; renderSync(); return Promise.resolve(); }
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        while (queue.length) {
          await cloudPost(queue[0]);
          queue.shift();
          save(LS.queue, queue);
        }
        syncState = 'ok';
      } catch (e) {
        syncState = 'offline';
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
    if (!validUrl(settings.cloudUrl)) { syncState = 'local'; renderSync(); return; }
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
        settings = Object.assign({}, settings, j.settings, { cloudUrl: settings.cloudUrl });
        save(LS.settings, settings);
      }
      syncState = queue.length ? 'offline' : 'ok';
    } catch (e) {
      syncState = 'offline';
    }
    if (!sess) renderHome();
    renderSync();
  }
  function pushSettings() {
    queue = queue.filter((q) => q.action !== 'settings');
    const { people, autoMin, sens, updatedAt } = settings;
    queue.push({ action: 'settings', settings: { people, autoMin, sens, updatedAt } });
    save(LS.queue, queue);
    flush();
  }
  function renderSync() {
    const el = $('sync');
    const pend = queue.filter((q) => q.action !== 'settings').length;
    el.classList.toggle('bad', syncState === 'offline' || (syncState === 'local' && records.length > 0));
    if (syncState === 'local') el.textContent = '記録はこの端末の中だけに保存しています（設定で Google スプレッドシートにつなげられます）';
    else if (syncState === 'offline') el.textContent = pend ? `まだ送れていない記録が ${pend}件あります。ネットにつながったら送ります` : 'スプレッドシートにつながりません。あとでもう一度ためします';
    else if (syncState === 'ok') el.textContent = 'スプレッドシートに保存ずみ';
    else el.textContent = 'スプレッドシートを確認しています…';
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
  function lightKey(freq) {
    if (!freq) return;
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const pc = ((midi % 12) + 12) % 12;
    const o = midi >= 60 ? 1 : 0;
    const el = document.getElementById(`k${o}-${pc}`);
    if (!el) return;
    const base = el.getAttribute('class').replace(' lit', '');
    el.setAttribute('class', base + ' lit');
    setTimeout(() => el.setAttribute('class', base), 350);
  }

  // ---------- home ----------
  function show(view) {
    for (const v of ['home', 'session', 'result']) $(v).hidden = v !== view;
    window.scrollTo(0, 0);
  }
  function renderHome() {
    const todayKey = dkey(new Date());
    $('today').textContent = fmtDate(todayKey);
    $('autoMinHint').textContent = settings.autoMin;
    const tm = minutesOn(todayKey);
    // players
    for (const id of [...selected]) if (!person(id)) selected.delete(id);
    $('people').replaceChildren(...settings.people.map((p) => {
      const min = tm.get(p.id) || 0;
      const pct = p.goal ? Math.min(100, Math.round(min / p.goal * 100)) : (min ? 100 : 0);
      const st = streak(p.id);
      return h('button', {
        class: 'person', type: 'button', 'aria-pressed': selected.has(p.id) ? 'true' : 'false',
        style: { '--c': colorOf(p) },
        onclick: () => { selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id); save(LS.sel, [...selected]); renderHome(); },
      },
      h('span', { class: 'check', 'aria-hidden': 'true' }, svgCheck()),
      h('span', { class: 'ring', style: { '--pct': pct } }, h('span', { class: 'face', text: (p.name || '？').slice(0, 1) })),
      h('span', { class: 'name', text: p.name || '？' }),
      h('span', { class: 'today' }, '今日 ', h('b', { class: 'num', text: min }), p.goal ? ` / ${p.goal}分` : '分'),
      h('span', { class: 'streak', text: st >= 2 ? `${st}日れんぞく` : '' }));
    }));
    const sel = settings.people.filter((p) => selected.has(p.id));
    $('start').disabled = !sel.length;
    $('startSub').textContent = !sel.length ? '名前をタップしてえらんでね'
      : sel.length === 1 ? `${sel[0].name} のれんしゅう` : `${sel.map((p) => p.name).join('・')} の連弾`;
    renderWeek();
    renderHist();
    renderSync();
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
    const today = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); days.push({ d, k: dkey(d), m: minutesOn(dkey(d)) }); }
    let max = 10;
    for (const p of settings.people) max = Math.max(max, p.goal || 0);
    for (const x of days) for (const v of x.m.values()) max = Math.max(max, v);
    const f = days[0].d, l = days[6].d;
    $('weekRange').textContent = `${f.getMonth() + 1}/${f.getDate()}〜${l.getMonth() + 1}/${l.getDate()}`;
    $('week').replaceChildren(...days.map((x, i) => h('div', { class: 'day' + (i === 6 ? ' today' : '') },
      h('div', { class: 'bars' }, settings.people.map((p) => {
        const v = x.m.get(p.id) || 0;
        return h('span', { class: 'bar' + (v ? '' : ' zero'), title: `${p.name} ${v}分`, style: { '--c': colorOf(p), height: `${(v / max * 100).toFixed(1)}%` } });
      })),
      h('div', { class: 'dl' }, i === 6 ? '今日' : WD[x.d.getDay()], h('br'), `${x.d.getDate()}`))));
    const weekTotal = new Map();
    for (const x of days) for (const [id, v] of x.m) weekTotal.set(id, (weekTotal.get(id) || 0) + v);
    const month = new Map();
    const mPrefix = dkey(today).slice(0, 7);
    for (const r of liveRecords()) if (r.date.startsWith(mPrefix)) for (const id of r.people) month.set(id, (month.get(id) || 0) + r.min);
    $('legend').replaceChildren(...settings.people.map((p) => h('span', { style: { '--c': colorOf(p) } },
      h('i'), p.name || '？', ' ', h('b', { class: 'num', text: fmtMin(weekTotal.get(p.id) || 0) }),
      h('span', { style: { color: 'var(--muted)' }, text: `（${today.getMonth() + 1}月 ${fmtMin(month.get(p.id) || 0)}）` }))));
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
        h('div', { class: 'min num', text: `${r.min}分` }),
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
  async function startMic(onNote, onJudge) {
    stopMic();
    const AC = window.AudioContext || window.webkitAudioContext;
    const a = { ctx: null, stream: null, det: null, lastMsg: 0, live: false, liveSince: Date.now(), error: '' };
    audio = a;
    try {
      a.ctx = new AC();
      a.ctx.resume().catch(() => {});
    } catch (e) {
      a.error = 'このブラウザでは音を調べられません';
      return a;
    }
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no getUserMedia'), { name: 'NoMedia' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      if (audio !== a) { stream.getTracks().forEach((t) => t.stop()); return a; }
      a.stream = stream;
      const ctx = a.ctx;
      a.det = new PianoDetector(ctx.sampleRate, Object.assign({}, SENS[settings.sens] || {}, { onNote }));
      a.det.onJudge = onJudge || null;
      const src = ctx.createMediaStreamSource(stream);
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
      src.connect(node); node.connect(sink); sink.connect(ctx.destination);
      a.src = src; a.node = node; a.sink = sink;
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
    lightKey(ev.f0);
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
    await startMic(onSessionNote);
  }
  function enterSessionView() {
    $('sessWho').replaceChildren(...sess.people.map((id) => chip(id)));
    keyboardSvg($('mini'), 2, 15, 70, true);
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
  }
  function showResult(s, rec, now) {
    const names = namesOf(s.people);
    $('resForce').hidden = true;
    $('resUndo').hidden = !rec;
    if (rec) {
      addRecord(rec);
      $('resMsg').textContent = `${names}、おつかれさま！`;
      $('resMin').replaceChildren(String(rec.min), h('small', { text: '分' }));
      const total = Math.round((now - s.start) / 60000);
      $('resNote').textContent = `${rec.start}〜${rec.end} の記録です` + (total - rec.min >= 2 ? `（スタートから ${total}分のうち、ピアノが鳴っていたあいだ）` : '');
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
    const tm = minutesOn(dkey(new Date()));
    $('resTally').replaceChildren(...s.people.map((id) => {
      const p = person(id);
      if (!p) return '';
      const min = tm.get(id) || 0;
      const st = streak(id);
      return h('div', { style: { '--c': colorOf(p) } }, chip(id),
        h('b', { class: 'num', text: `今日 ${fmtMin(min)}` }),
        p.goal && min >= p.goal ? h('span', { class: 'goal', text: '目標たっせい！' }) : (p.goal ? h('span', { class: 'small', text: `目標まで あと${p.goal - min}分` }) : ''),
        st >= 2 ? h('div', { class: 'small', text: `${st}日れんぞく` }) : '');
    }));
  }
  function backHome() { show('home'); renderHome(); refreshCloud(true); }

  // UI loop
  function tick() {
    if (!sess) return;
    const now = Date.now();
    $('timer').textContent = fmtClock(now - sess.start);
    const a = audio;
    const live = micLive();
    const st = $('micStatus');
    let auto = '';
    if (live) {
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
    const m = $('meter');
    m.style.width = `${live ? meterPct() : 0}%`;
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
    $('pEdit').replaceChildren(...settings.people.map((p, i) => h('div', { class: 'prow', style: { '--c': colorOf(p) } },
      h('i'),
      h('input', { type: 'text', value: p.name, maxlength: 12, 'aria-label': `${i + 1}人目の名前`, oninput: (e) => { p.name = e.target.value.trim(); } }),
      (() => {
        const s = h('select', { 'aria-label': `${p.name}の1日の目標`, onchange: (e) => { p.goal = Number(e.target.value); } },
          GOALS.map((g) => h('option', { value: g, text: g ? `${g}分` : 'なし' })));
        s.value = String(p.goal || 0);
        return s;
      })(),
      h('button', {
        class: 'del', type: 'button', 'aria-label': `${p.name}を消す`, text: '×', disabled: settings.people.length <= 1 ? true : null,
        onclick: () => { settings.people.splice(i, 1); renderSettings(); },
      }))));
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
    settings.people.push({ id: 'p' + n, name: '', goal: 15, color: c });
    renderSettings();
    const inputs = $('pEdit').querySelectorAll('input');
    inputs[inputs.length - 1].focus();
  });
  function openSettings(welcome) {
    $('welcome').hidden = !welcome;
    $('cloudUrl').value = settings.cloudUrl || '';
    $('cloudInfo').textContent = '';
    $('ver').textContent = `バージョン ${VERSION}`;
    renderSettings();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function closeSettings() {
    stopTest();
    settings.people.forEach((p, i) => { if (!p.name) p.name = `${i + 1}人目`; });
    const url = $('cloudUrl').value.trim();
    const urlChanged = url !== settings.cloudUrl;
    settings.cloudUrl = url;
    settings.updatedAt = Date.now();
    save(LS.settings, settings);
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
    if (urlChanged) { syncState = validUrl(url) ? 'wait' : 'local'; queue = queue.filter((q) => q.action !== 'settings'); save(LS.queue, queue); }
    if (validUrl(url)) {
      // after connecting a new sheet, send everything recorded on this device so far
      if (urlChanged) {
        const pending = new Set(queue.filter((q) => q.action === 'add').map((q) => q.record.id));
        for (const r of records) if (!pending.has(r.id)) queue.push({ action: 'add', record: r });
        save(LS.queue, queue);
      }
      pushSettings();
    }
    renderHome();
    refreshCloud(true);
  }
  $('openSettings').addEventListener('click', () => openSettings(false));
  $('closeSettings').addEventListener('click', closeSettings);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSettings(); });
  $('cloudTest').addEventListener('click', async () => {
    const url = $('cloudUrl').value.trim();
    const info = $('cloudInfo');
    if (!validUrl(url)) { info.textContent = 'URL の形がちがいます（…/exec で終わる URL）'; return; }
    info.textContent = 'たしかめています…';
    try {
      const r = await fetch(url + '?action=list&t=' + Date.now(), { cache: 'no-store' });
      const j = await r.json();
      info.textContent = j.ok ? `つながりました（記録 ${j.records.length}件）` : `エラー: ${j.error}`;
    } catch (e) {
      info.textContent = 'つながりません。URL と、デプロイの「アクセスできるユーザー：全員」を確認してください';
    }
  });

  $('copyCode').addEventListener('click', async () => {
    const info = $('copyInfo');
    try {
      const code = await (await fetch('apps-script.gs', { cache: 'no-store' })).text();
      await navigator.clipboard.writeText(code);
      info.textContent = 'コピーしました';
    } catch (e) {
      info.textContent = 'コピーできませんでした。apps-script.gs を開いてコピーしてください';
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
    if (firstRun) openSettings(true);
  }
  refreshCloud(true);
})();
