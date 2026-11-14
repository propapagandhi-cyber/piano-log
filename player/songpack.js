// 練習プレーヤーの曲のデータ（楽譜の画像・音符の位置・音のデータ）を、合言葉で暗号化した
// packs/<曲>.bin から読み出す。player/index.html の本体より先に読み込まれ、
// 本体はここで用意した window.PLAYER_SOURCE を通して曲のデータを読む。
//
// packs/<曲>.bin = "PLK1" + 12 バイトの IV + AES-GCM の暗号文（中身は gzip した JSON：
// { "elise/data.json": "...", "elise/strips/1.svg": "...", ... }）
// 鍵 = PBKDF2-SHA256(合言葉, packs/meta.json の salt, iter 回)。合言葉は localStorage の pl.key に
// 入れておく（練習記録アプリの設定や、#k=… の付いたリンクからも入る）。
(() => {
  'use strict';
  const STORE = 'pl.key';
  const dec = new TextDecoder();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const getPass = () => { try { return localStorage.getItem(STORE) || ''; } catch (e) { return ''; } };
  const setPass = (v) => { try { if (v) localStorage.setItem(STORE, v); else localStorage.removeItem(STORE); } catch (e) { /* storage blocked */ } };

  let meta = null;
  let key = null;
  let pack = null, packSong = '';
  let blobs = {};

  async function loadMeta() {
    if (!meta) {
      const res = await fetch('packs/meta.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('meta ' + res.status);
      meta = await res.json();
    }
    return meta;
  }
  async function derive(pass) {
    const m = await loadMeta();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm(pass)), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(m.salt), iterations: m.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  function unseal(k, bytes) {
    if (dec.decode(bytes.subarray(0, 4)) !== 'PLK1') throw new Error('not a pack');
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(4, 16) }, k, bytes.subarray(16));
  }
  async function gunzip(buf) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  // 合言葉が正しければ鍵を返す（packs/meta.json の check が開けるか）
  async function tryPass(pass) {
    if (!norm(pass)) return null;
    const k = await derive(pass);
    try { await unseal(k, b64((await loadMeta()).check)); return k; } catch (e) { return null; }
  }

  // ---- 合言葉を聞く画面 ----
  function ask(message) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(20,16,18,.55);font-family:"Zen Maru Gothic","Hiragino Maru Gothic ProN",system-ui,sans-serif';
      wrap.innerHTML =
        '<form style="background:#fff;color:#261E20;border-radius:16px;padding:20px;width:min(360px,100%);display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.25)">' +
        '<b style="font-size:19px">楽譜の合言葉</b>' +
        '<span style="font-size:14px;line-height:1.6">楽譜を開くには、家族の合言葉が必要です。一度入れると、この端末では次から聞かれません。</span>' +
        '<span class="m" style="font-size:14px;color:#c2410c;font-weight:700"></span>' +
        '<input name="p" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx" ' +
        'style="font:inherit;font-size:18px;padding:10px 12px;border:1px solid #ccc;border-radius:10px;color:#261E20;background:#fff">' +
        '<button style="font:inherit;font-weight:700;font-size:17px;border:0;border-radius:12px;padding:12px;background:#261E20;color:#fff">開く</button>' +
        '</form>';
      wrap.querySelector('.m').textContent = message || '';
      const form = wrap.querySelector('form');
      const done = (v) => { window.removeEventListener('storage', onStore); wrap.remove(); resolve(v); };
      // 記録の画面（同じサイト）で合言葉が入ったら、それを使う
      const onStore = (e) => { if (e.key === STORE && e.newValue) done(e.newValue); };
      window.addEventListener('storage', onStore);
      form.addEventListener('submit', (e) => { e.preventDefault(); done(form.p.value); });
      document.body.append(wrap);
      setTimeout(() => form.p.focus(), 50);
    });
  }

  async function ensureKey() {
    if (key) return key;
    if (!window.crypto || !crypto.subtle || typeof DecompressionStream === 'undefined') {
      throw new Error('この端末のブラウザが古いため、楽譜を開けません（iPadOS を新しくしてください）');
    }
    let pass = getPass(), msg = '';
    for (;;) {
      if (!pass) pass = await ask(msg);
      const k = await tryPass(pass);
      if (k) { setPass(norm(pass)); key = k; return k; }
      setPass('');
      pass = '';
      msg = '合言葉がちがいます。もう一度入れてください';
    }
  }
  // 記録の画面で合言葉を変えたら、次に曲を開くときに読み直す
  window.addEventListener('storage', (e) => { if (e.key === STORE) key = null; });

  window.PLAYER_SOURCE = {
    async prepare(song) {
      const k = await ensureKey();
      if (packSong === song.key && pack) return;
      const res = await fetch('packs/' + song.key + '.bin');
      if (!res.ok) throw new Error(String(res.status));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const files = JSON.parse(dec.decode(await gunzip(await unseal(k, bytes))));
      Object.values(blobs).forEach((u) => URL.revokeObjectURL(u));
      blobs = {};
      pack = files;
      packSong = song.key;
    },
    url(path) {
      if (!blobs[path]) blobs[path] = URL.createObjectURL(new Blob([pack[path] || ''], { type: 'image/svg+xml' }));
      return blobs[path];
    },
    text: (path) => Promise.resolve(pack[path] || ''),
    json(path) {
      if (!(path in pack)) return Promise.reject(new Error('no ' + path));
      return Promise.resolve(JSON.parse(pack[path]));
    },
  };
})();
