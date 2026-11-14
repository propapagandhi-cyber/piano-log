/* PianoDetector — tells piano notes apart from speech, knocks and room noise.
 *
 * Feed it mono samples with push(Float32Array); it calls onNote(ev) for every
 * note it is confident was a piano (or piano-like) note.
 *
 * How it decides, per note onset:
 *   1. Onset: a sudden rise of energy in many frequency bins (SuperFlux-style
 *      spectral flux, compared with the frame two hops back, max-filtered
 *      across ±1 bin so vibrato and gliding voices make little flux).
 *   2. Tonal: ~30 ms after the onset the spectrum must have clear peaks
 *      (partials) standing well above their neighbours and the noise floor.
 *   3. Steady: for the next ~50-130 ms those peaks must stay at the same
 *      frequency (a piano string cannot glide; speech pitch moves) and keep
 *      existing (knocks and claps die within a few tens of ms).
 *   4. Decaying: energy must not swell after the attack (piano notes only
 *      decay; spoken syllables swell into the vowel).
 *
 * Works in the browser (global PianoDetector) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    N: 2048,            // FFT size
    H: 512,             // hop
    fLo: 60,            // analysis band
    fHi: 4500,
    peakHi: 4000,       // partials searched below this
    fluxMin: 0.5,       // dB per band bin: absolute onset threshold
    fluxK: 2.0,         // onset must exceed recent mean flux × fluxK
    gateDb: 8,          // frame energy must exceed the energy floor by this
    refLag: 5,          // frames after the onset where partials are picked (window filled)
    newRise: 0,         // >0: partials must have risen this many dB since before the onset
                        //     (tested: hurts repeated notes and lets some speech through, so off)
    minFrames: 5,       // frames after refLag needed to judge (≈53 ms)
    maxFrames: 12,      // frames after refLag used at most (≈128 ms)
    peakRange: 30,      // partials within this many dB of the frame maximum
    peakProm: 10,       // dB above the surroundings (±4 bins)
    peakOverFloor: 15,  // dB above the per-bin noise floor
    maxPeaks: 6,
    keepDrop: 25,       // a partial still "exists" until it falls this many dB
    minStable: 0.75,    // share of (partial × frame) observations still present
    maxDrift: 0.012,    // relative frequency drift of the 3 strongest partials
    maxRise: 6,         // dB the energy may grow after the reference frame
    persist: 0,         // >0: drift is measured only on partials present in this share of frames
    persistTop: false,  //     and (if true) the strongest partial must be one of them
                        //     (tested: lets speech and knocks through, so off)
    highF: 1000,        // high-note rule: strongest partial at or above this (Hz; 0 = off)…
    highKeep: 0.9,      // …present in this share of the frames…
    highDrift: 0.006,   // …and drifting less than this
  };

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }

  class PianoDetector {
    constructor(sampleRate, opts) {
      const o = Object.assign({}, DEFAULTS, opts || {});
      this.o = o;
      this.sr = sampleRate;
      this.N = o.N;
      this.H = o.H;
      this.binHz = sampleRate / o.N;
      this.kLo = Math.max(2, Math.ceil(o.fLo / this.binHz));
      this.kHi = Math.min(o.N / 2 - 5, Math.floor(o.fHi / this.binHz));
      this.kPk = Math.min(this.kHi, Math.floor(o.peakHi / this.binHz));
      this.win = new Float32Array(o.N);
      for (let i = 0; i < o.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / o.N);
      this.frame = new Float32Array(o.N);
      this.fill = 0;            // samples in this.frame
      this.re = new Float64Array(o.N);
      this.im = new Float64Array(o.N);
      const K = o.N / 2 + 1;
      this.hist = [];           // last few dB spectra (newest last)
      this.nf = null;           // per-bin noise floor (dB)
      this.eFloor = null;       // energy floor (dB)
      this.fluxHist = [];       // recent flux values
      this.E = -120;            // latest band energy (dB)
      this.t = 0;               // frames processed
      this.lastOnset = -1e9;
      this.cands = [];
      this.onNote = (opts && opts.onNote) || null;
      this.onOnset = (opts && opts.onOnset) || null;
      this.K = K;
      this.riseFloor = 0.5 * o.H / sampleRate;   // dB per frame (0.5 dB/s)
    }

    /** Seconds of audio analysed so far. */
    get time() { return this.t * this.H / this.sr; }

    push(x) {
      let i = 0;
      while (i < x.length) {
        const take = Math.min(x.length - i, this.N - this.fill);
        this.frame.set(x.subarray(i, i + take), this.fill);
        this.fill += take;
        i += take;
        if (this.fill === this.N) {
          this._process();
          this.frame.copyWithin(0, this.H);
          this.fill = this.N - this.H;
        }
      }
    }

    _process() {
      const o = this.o, N = this.N, re = this.re, im = this.im, w = this.win, f = this.frame;
      for (let i = 0; i < N; i++) { re[i] = f[i] * w[i]; im[i] = 0; }
      fft(re, im);
      const P = new Float32Array(this.K);
      const scale = 4 / (N * N);   // so a full-scale sine reads ≈ 0 dB
      let sum = 0, pmax = -200;
      for (let k = 0; k < this.K; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) * scale;
        const db = 10 * Math.log10(p + 1e-14);
        P[k] = db;
        if (k >= this.kLo && k <= this.kHi) {
          sum += p;
          if (db > pmax) pmax = db;
        }
      }
      const E = 10 * Math.log10(sum + 1e-14);
      this.E = E;
      // noise floors: fall fast, rise 0.5 dB/s
      if (!this.nf) {
        this.nf = Float32Array.from(P);
        this.eFloor = E;
      } else {
        const nf = this.nf, r = this.riseFloor;
        for (let k = 0; k < this.K; k++) nf[k] = P[k] < nf[k] ? 0.7 * nf[k] + 0.3 * P[k] : nf[k] + r;
        this.eFloor = E < this.eFloor ? 0.7 * this.eFloor + 0.3 * E : this.eFloor + r;
      }
      // SuperFlux against the frame two hops back
      let flux = 0;
      const ref = this.hist.length >= 2 ? this.hist[this.hist.length - 2] : null;
      if (ref) {
        const nf = this.nf;
        for (let k = this.kLo; k <= this.kHi; k++) {
          const r = Math.max(ref[k - 1], ref[k], ref[k + 1], nf[k] + 10);
          const d = P[k] - r;
          if (d > 0) flux += d;
        }
        flux /= (this.kHi - this.kLo + 1);
      }
      this.hist.push(P);
      if (this.hist.length > 4) this.hist.shift();
      this.Pnow = P;
      this.pmax = pmax;

      // onset = local maximum of flux at the previous frame
      const fh = this.fluxHist;
      fh.push(flux);
      if (fh.length > 40) fh.shift();
      const n = fh.length;
      if (n >= 3) {
        const prev = fh[n - 2];
        let mean = 0;
        for (let i = 0; i < n - 2; i++) mean += fh[i];
        mean = n > 2 ? mean / (n - 2) : 0;
        const thr = Math.max(o.fluxMin, mean * o.fluxK);
        const onsetFrame = this.t - 1;
        if (prev > thr && prev >= fh[n - 3] && prev > flux &&
            onsetFrame - this.lastOnset >= 5 &&
            this.prevE > this.eFloor + o.gateDb) {
          this.lastOnset = onsetFrame;
          // a new onset ends the judging window of earlier candidates
          for (const c of this.cands) c.cut = true;
          // spectrum before the onset: partials of the new note must rise above it
          const h = this.hist;
          const before = h.length >= 4 ? h[h.length - 4] : null;
          this.cands.push({ o: onsetFrame, before, peaks: null, frames: 0, obs: 0, hit: 0, drift: [], ph: [], pd: [], Eref: 0, Emax: -200, cut: false, flux: prev });
          if (this.onOnset) this.onOnset({ time: onsetFrame * this.H / this.sr, flux: prev });
        }
      }
      this.prevE = E;

      this._judge(P, E);
      this.t++;
    }

    _peaks(P, before) {
      const o = this.o, nf = this.nf;
      const out = [];
      for (let k = this.kLo + 2; k <= this.kPk; k++) {
        const v = P[k];
        if (!(v >= P[k - 1] && v >= P[k + 1] && v > P[k - 2] && v > P[k + 2])) continue;
        if (v < this.pmax - o.peakRange || v < nf[k] + o.peakOverFloor) continue;
        if (before && o.newRise > 0 && v - Math.max(before[k - 1], before[k], before[k + 1]) < o.newRise) continue;
        let lo = Infinity;
        for (let j = k - 4; j <= k + 4; j++) if (j !== k && P[j] < lo) lo = P[j];
        if (v - lo < o.peakProm) continue;
        out.push({ k, v, f: this._freq(P, k) });
      }
      out.sort((a, b) => b.v - a.v);
      return out.slice(0, o.maxPeaks);
    }

    _freq(P, k) {
      const a = P[k - 1], b = P[k], c = P[k + 1];
      const d = a - 2 * b + c;
      const off = d < 0 ? 0.5 * (a - c) / d : 0;
      return (k + off) * this.binHz;
    }

    _judge(P, E) {
      const o = this.o;
      const keep = [];
      for (const c of this.cands) {
        const age = this.t - c.o;
        if (age < o.refLag) { keep.push(c); continue; }
        if (age === o.refLag) {
          c.peaks = this._peaks(P, c.before);
          c.before = null;
          c.Eref = E;
          if (!c.peaks.length) { this._decide(c, 'no-partials'); continue; }
          keep.push(c);
          continue;
        }
        // after the reference frame
        if (c.cut && c.frames >= 0) {
          // a newer onset started: judge with what we have
          this._decide(c);
          continue;
        }
        c.frames++;
        if (E > c.Emax) c.Emax = E;
        for (let i = 0; i < c.peaks.length; i++) {
          const p = c.peaks[i];
          let best = -1;
          for (let k = p.k - 1; k <= p.k + 1; k++) {
            if (P[k] >= P[k - 1] && P[k] >= P[k + 1] && (best < 0 || P[k] > P[best])) best = k;
          }
          c.obs++;
          if (best >= 0 && P[best] >= p.v - o.keepDrop && P[best] <= p.v + 4) {
            c.hit++;
            c.ph[i] = (c.ph[i] || 0) + 1;
            c.pd[i] = Math.max(c.pd[i] || 0, Math.abs(this._freq(P, best) - p.f) / p.f);
            if (i < 3) {
              const fr = this._freq(P, best);
              const d = Math.abs(fr - p.f) / p.f;
              c.drift[i] = Math.max(c.drift[i] || 0, d);
            }
          } else if (i < 3) {
            c.drift[i] = Math.max(c.drift[i] || 0, 1);   // lost = maximal drift
          }
        }
        if (c.frames >= o.maxFrames) { this._decide(c); continue; }
        keep.push(c);
      }
      this.cands = keep;
    }

    _decide(c, why) {
      const o = this.o;
      const ev = {
        time: c.o * this.H / this.sr,
        frames: c.frames,
        stable: c.obs ? c.hit / c.obs : 0,
        drift: 0,
        rise: c.Emax - c.Eref,
        partials: c.peaks ? c.peaks.length : 0,
        flux: c.flux,
        piano: false,
        why: why || '',
      };
      if (c.peaks && c.peaks.length) {
        let ds;
        if (o.persist > 0) {
          // only partials that kept ringing count: the "knock" of a hammer also makes peaks
          // right after the attack, and high notes have few real partials below 4 kHz
          ds = [];
          for (let i = 0; i < c.peaks.length && ds.length < 3; i++) {
            if ((c.ph[i] || 0) >= o.persist * c.frames) ds.push(c.pd[i] || 0);
            else if (i === 0 && o.persistTop) { ds = []; break; }
          }
          ds.sort((a, b) => a - b);
        } else {
          ds = c.drift.filter((d) => d !== undefined).sort((a, b) => a - b);
        }
        ev.drift = ds.length ? ds[Math.floor((ds.length - 1) / 2)] : 1;   // median of the 3 strongest
        // rough pitch for display: the lowest partial within 12 dB of the strongest
        const top = c.peaks[0].v;
        ev.f0 = Math.min(...c.peaks.filter((p) => p.v >= top - 12).map((p) => p.f));
      }
      if (!why) {
        if (c.frames < o.minFrames) ev.why = 'short';
        else if (ev.stable < o.minStable) ev.why = 'unstable';
        else if (ev.drift > o.maxDrift) ev.why = 'drift';
        else if (ev.rise > o.maxRise) ev.why = 'swell';
        else ev.piano = true;
        // high notes (C6 and up): one strong partial (the 2nd harmonic is often above 4 kHz)
        // next to the hammer's knock, which dies at once. Judge them on that partial alone.
        if (!ev.piano && o.highF > 0 && c.frames >= o.minFrames && ev.rise <= o.maxRise) {
          const top = c.peaks[0];
          if (top.f >= o.highF && (c.ph[0] || 0) >= o.highKeep * c.frames && (c.pd[0] || 0) <= o.highDrift) {
            ev.piano = true;
            ev.via = 'high';
            ev.why = '';
            ev.f0 = top.f;
          }
        }
      }
      if (this.onNote && ev.piano) this.onNote(ev);
      if (this.onJudge) this.onJudge(ev);
    }
  }

  PianoDetector.DEFAULTS = DEFAULTS;
  if (typeof module !== 'undefined' && module.exports) module.exports = PianoDetector;
  else root.PianoDetector = PianoDetector;
})(typeof globalThis !== 'undefined' ? globalThis : this);
