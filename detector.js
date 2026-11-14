/* PianoDetector — tells piano notes apart from speech, knocks and room noise.
 *
 * Feed it mono samples with push(Float32Array); it calls onNote(ev) for every
 * note it is confident was a piano (or piano-like) note.
 *
 * How it decides, per note onset:
 *   1. Onset: a sudden rise of energy in many frequency bins (SuperFlux-style
 *      spectral flux, compared with the frame two hops back, max-filtered
 *      across ±1 bin so vibrato and gliding voices make little flux).
 *   2. Tonal: ~50 ms after the onset the spectrum must have clear peaks
 *      (partials) standing well above their neighbours and the noise floor.
 *   3. Steady: for the next ~50-130 ms those peaks must stay at the same
 *      frequency (a piano string cannot glide; speech pitch moves) and keep
 *      existing (knocks and claps die within a few tens of ms).
 *   4. Decaying: energy must not swell after the attack (piano notes only
 *      decay; spoken syllables swell into the vowel).
 *
 * Low register: below about C3 the partials of a note are only 2-5 bins apart
 * in the 2048-point spectrum (23 Hz bins), so neighbouring partials blur and
 * beat and the "steady" test fails. A second analysis therefore looks at
 * 40-600 Hz with 4× finer bins (input decimated to ~12 kHz, 2048-point FFT,
 * ≈170 ms window). A note also counts as piano when, in that view, partials
 * that rose at the onset stay at the same frequency for ≥6 hops.
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
    // low-register analysis
    low: true,
    lowRate: 12000,     // decimate to about this rate
    lowN: 2048,         // FFT size at the low rate (≈170 ms, ≈5.9 Hz bins)
    lowFLo: 40,
    lowFHi: 600,
    lowRef: 16,         // hops after the onset where low partials are picked: the 170 ms
                        // window must be past the attack, or the step biases the peaks
    lowMinFrames: 6,
    lowMaxFrames: 12,
    lowRise: 6,         // low partials must have risen this many dB since before the onset
    lowProm: 10,        // dB above the surroundings (±6 bins)
    lowOverFloor: 15,
    lowRange: 30,
    lowPeaks: 4,
    lowStable: 0.8,
    lowDrift: 0.006,
    lowMinSlope: -5,    // dB the strongest low partial may fall over the judged ≈130 ms
                        // (test set: piano median −1.6 dB, spoken vowels −7 to −13 dB)
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

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  // parabolic interpolation of a peak in a dB spectrum → frequency
  function peakFreq(P, k, binHz) {
    const a = P[k - 1], b = P[k], c = P[k + 1];
    const d = a - 2 * b + c;
    const off = d < 0 ? 0.5 * (a - c) / d : 0;
    return (k + off) * binHz;
  }

  function median(xs) {
    const s = xs.filter((d) => d !== undefined).sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : 1;
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
      this.win = hann(o.N);
      this.frame = new Float32Array(o.N);
      this.fill = 0;            // samples in this.frame
      this.re = new Float64Array(o.N);
      this.im = new Float64Array(o.N);
      this.K = o.N / 2 + 1;
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
      this.riseFloor = 0.5 * o.H / sampleRate;   // dB per frame (0.5 dB/s)
      if (o.low) this._initLow();
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

    // ---------- low-register branch ----------
    _initLow() {
      const o = this.o;
      const D = Math.max(1, Math.round(this.sr / o.lowRate));
      this.D = D;
      this.lsr = this.sr / D;
      this.lbin = this.lsr / o.lowN;
      // windowed-sinc low-pass (cut-off 1.5 kHz) before decimating
      const M = 16 * D + 1;
      const fc = 1500 / this.sr;
      const taps = new Float32Array(M);
      let s = 0;
      for (let n = 0; n < M; n++) {
        const m = n - (M - 1) / 2;
        const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
        const bl = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (M - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (M - 1));
        taps[n] = sinc * bl;
        s += taps[n];
      }
      for (let n = 0; n < M; n++) taps[n] /= s;
      this.taps = taps;
      this.dline = new Float32Array(M);   // circular delay line
      this.dpos = 0;
      this.dphase = 0;
      this.lbuf = new Float32Array(o.lowN);
      this.lwin = hann(o.lowN);
      this.lre = new Float64Array(o.lowN);
      this.lim = new Float64Array(o.lowN);
      this.lkLo = Math.max(3, Math.ceil(o.lowFLo / this.lbin));
      this.lkHi = Math.floor(o.lowFHi / this.lbin);
      this.lK = this.lkHi + 10;
      this.lnf = null;
      this.lhist = [];
    }

    _lowSpectrum() {
      const o = this.o, N = this.N, H = this.H, D = this.D, taps = this.taps, M = taps.length;
      const dl = this.dline, f = this.frame, lb = this.lbuf;
      // decimate the newest hop into the low buffer
      const out = [];
      for (let i = N - H; i < N; i++) {
        dl[this.dpos] = f[i];
        this.dpos = (this.dpos + 1) % M;
        if (++this.dphase === D) {
          this.dphase = 0;
          let acc = 0;
          for (let j = 0, p = this.dpos; j < M; j++, p = (p + 1) % M) acc += taps[j] * dl[p];
          out.push(acc);
        }
      }
      const n = out.length;
      lb.copyWithin(0, n);
      for (let i = 0; i < n; i++) lb[lb.length - n + i] = out[i];
      // spectrum of the low buffer
      const L = o.lowN, re = this.lre, im = this.lim, w = this.lwin;
      for (let i = 0; i < L; i++) { re[i] = lb[i] * w[i]; im[i] = 0; }
      fft(re, im);
      const P = new Float32Array(this.lK);
      const scale = 4 / (L * L);
      for (let k = 0; k < this.lK; k++) P[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) * scale + 1e-14);
      if (!this.lnf) this.lnf = Float32Array.from(P);
      else {
        const nf = this.lnf, r = this.riseFloor;
        for (let k = 0; k < this.lK; k++) nf[k] = P[k] < nf[k] ? 0.7 * nf[k] + 0.3 * P[k] : nf[k] + r;
      }
      this.lhist.push(P);
      if (this.lhist.length > 4) this.lhist.shift();
      return P;
    }

    _lowPeaks(P, before) {
      const o = this.o, nf = this.lnf;
      let pmax = -200;
      for (let k = this.lkLo; k <= this.lkHi; k++) if (P[k] > pmax) pmax = P[k];
      const out = [];
      for (let k = this.lkLo; k <= this.lkHi; k++) {
        const v = P[k];
        if (!(v >= P[k - 1] && v >= P[k + 1] && v > P[k - 2] && v > P[k + 2])) continue;
        if (v < pmax - o.lowRange || v < nf[k] + o.lowOverFloor) continue;
        if (before && v - Math.max(before[k - 1], before[k], before[k + 1]) < o.lowRise) continue;
        let lo = Infinity;
        for (let j = k - 6; j <= k + 6; j++) if (j !== k && j >= 0 && P[j] < lo) lo = P[j];
        if (v - lo < o.lowProm) continue;
        out.push({ k, v, f: peakFreq(P, k, this.lbin) });
      }
      out.sort((a, b) => b.v - a.v);
      return out.slice(0, o.lowPeaks);
    }

    _judgeLow(c, P) {
      const o = this.o, lb = c.lb;
      const age = this.t - c.o;
      if (age < o.lowRef) return;
      if (age === o.lowRef) {
        lb.peaks = this._lowPeaks(P, lb.before);
        lb.before = null;
        if (!lb.peaks.length) { lb.done = true; lb.why = 'low-none'; }
        return;
      }
      if (lb.cut) { this._decideLow(c); return; }
      lb.frames++;
      for (let i = 0; i < lb.peaks.length; i++) {
        const p = lb.peaks[i];
        let best = -1;
        for (let k = p.k - 1; k <= p.k + 1; k++) {
          if (P[k] >= P[k - 1] && P[k] >= P[k + 1] && (best < 0 || P[k] > P[best])) best = k;
        }
        lb.obs++;
        if (i === 0) lb.levels.push(best >= 0 ? P[best] : -200);
        if (best >= 0 && P[best] >= p.v - 20 && P[best] <= p.v + 4) {
          lb.hit++;
          if (i < 3) lb.drift[i] = Math.max(lb.drift[i] || 0, Math.abs(peakFreq(P, best, this.lbin) - p.f) / p.f);
        } else if (i < 3) {
          lb.drift[i] = 1;
        }
      }
      if (lb.frames >= o.lowMaxFrames) this._decideLow(c);
    }

    _decideLow(c) {
      const o = this.o, lb = c.lb;
      lb.done = true;
      lb.stable = lb.obs ? lb.hit / lb.obs : 0;
      lb.driftMed = median(lb.drift);
      // how the strongest partial's level moves: piano strings only decay
      const lv = [lb.peaks[0].v].concat(lb.levels);
      let bump = 0, lo = lv[0];
      for (let i = 1; i < lv.length; i++) { bump = Math.max(bump, lv[i] - lo); lo = Math.min(lo, lv[i]); }
      lb.bump = bump;
      lb.slope = lv[lv.length - 1] - lv[0];
      if (lb.frames < o.lowMinFrames) lb.why = 'low-short';
      else if (lb.stable < o.lowStable) lb.why = 'low-unstable';
      else if (lb.driftMed > o.lowDrift) lb.why = 'low-drift';
      else if (lb.slope < o.lowMinSlope) lb.why = 'low-fade';   // a spoken vowel ending, not a ringing string
      else lb.piano = true;
    }

    // ---------- main analysis ----------
    _process() {
      const o = this.o, N = this.N, re = this.re, im = this.im, w = this.win, f = this.frame;
      const Lspec = o.low ? this._lowSpectrum() : null;
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
          for (const c of this.cands) { c.cut = true; if (c.lb) c.lb.cut = true; }
          const h = this.hist, lh = this.lhist;
          const before = h.length >= 4 ? h[h.length - 4] : null;
          const c = { o: onsetFrame, before, peaks: null, frames: 0, obs: 0, hit: 0, drift: [], Eref: 0, Emax: -200, cut: false, flux: prev, done: false, ev: null };
          if (o.low) c.lb = { before: lh && lh.length >= 3 ? lh[lh.length - 3] : null, peaks: null, frames: 0, obs: 0, hit: 0, drift: [], levels: [], cut: false, done: false, piano: false, why: '' };
          this.cands.push(c);
          if (this.onOnset) this.onOnset({ time: onsetFrame * this.H / this.sr, flux: prev });
        }
      }
      this.prevE = E;

      this._judge(P, E, Lspec);
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
        out.push({ k, v, f: peakFreq(P, k, this.binHz) });
      }
      out.sort((a, b) => b.v - a.v);
      return out.slice(0, o.maxPeaks);
    }

    _judge(P, E, Lspec) {
      const o = this.o;
      const keep = [];
      for (const c of this.cands) {
        if (!c.done) this._judgeMain(c, P, E);
        if (c.lb && !c.lb.done) this._judgeLow(c, Lspec);
        const lowDone = !c.lb || c.lb.done;
        // report as soon as either view says "piano"; otherwise when both are done
        if (!c.reported && ((c.done && c.ev.piano) || (c.lb && c.lb.piano) || (c.done && lowDone))) {
          this._report(c);
        }
        if (!(c.done && lowDone)) keep.push(c);
      }
      this.cands = keep;
    }

    _judgeMain(c, P, E) {
      const o = this.o;
      const age = this.t - c.o;
      if (age < o.refLag) return;
      if (age === o.refLag) {
        c.peaks = this._peaks(P, c.before);
        c.before = null;
        c.Eref = E;
        if (!c.peaks.length) this._decide(c, 'no-partials');
        return;
      }
      if (c.cut) { this._decide(c); return; }   // a newer onset started: judge with what we have
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
          if (i < 3) {
            const d = Math.abs(peakFreq(P, best, this.binHz) - p.f) / p.f;
            c.drift[i] = Math.max(c.drift[i] || 0, d);
          }
        } else if (i < 3) {
          c.drift[i] = Math.max(c.drift[i] || 0, 1);   // lost = maximal drift
        }
      }
      if (c.frames >= o.maxFrames) this._decide(c);
    }

    _decide(c, why) {
      const o = this.o;
      c.done = true;
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
        via: '',
      };
      if (c.peaks && c.peaks.length) {
        ev.drift = median(c.drift);   // median of the 3 strongest
        // rough pitch for display: the lowest partial within 12 dB of the strongest
        const top = c.peaks[0].v;
        ev.f0 = Math.min(...c.peaks.filter((p) => p.v >= top - 12).map((p) => p.f));
      }
      if (!why) {
        if (c.frames < o.minFrames) ev.why = 'short';
        else if (ev.stable < o.minStable) ev.why = 'unstable';
        else if (ev.drift > o.maxDrift) ev.why = 'drift';
        else if (ev.rise > o.maxRise) ev.why = 'swell';
        else { ev.piano = true; ev.via = 'main'; }
      }
      c.ev = ev;
    }

    _report(c) {
      c.reported = true;
      let ev = c.ev;
      if (!ev) {   // the low view decided before the main one
        ev = { time: c.o * this.H / this.sr, frames: c.frames, stable: 0, drift: 0, rise: 0, partials: 0, flux: c.flux, piano: false, why: '', via: '' };
      }
      ev = Object.assign({}, ev);
      const lb = c.lb;
      if (lb) {
        ev.lowWhy = lb.why;
        ev.lowStable = lb.stable;
        ev.lowDrift = lb.driftMed;
        ev.lowBump = lb.bump;
        ev.lowSlope = lb.slope;
        ev.lowF = lb.peaks && lb.peaks.length ? lb.peaks.map((p) => Math.round(p.f)) : [];
        if (!ev.piano && lb.piano) {
          ev.piano = true;
          ev.via = 'low';
          ev.why = '';
          const top = lb.peaks[0].v;
          ev.f0 = Math.min(...lb.peaks.filter((p) => p.v >= top - 12).map((p) => p.f));
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
