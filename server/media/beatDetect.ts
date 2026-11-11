/**
 * Beat detection for soundtracks. Pure functions over mono PCM samples; no
 * dependencies. Decoding is done by FFmpeg (see decodeMono in beatService.ts).
 *
 * Method (the standard one from music information retrieval):
 *  1. Onset strength: how much new energy appears in each ~12 ms frame
 *     (log-magnitude spectral flux over a short-time Fourier transform).
 *  2. Tempo: the beat period whose autocorrelation of the onset strength is
 *     strongest, weighted toward common tempos (log-normal prior around 120 BPM).
 *  3. Beats: dynamic programming (D. Ellis, "Beat Tracking by Dynamic
 *     Programming", 2007) picks the onset peaks that best fit that period while
 *     tolerating small tempo drift.
 *
 * Reliable on music with a steady pulse; weaker on rubato or ambient music,
 * which `confidence` reports so the UI can suggest setting the tempo by hand.
 */

export const ANALYSIS_SAMPLE_RATE = 22050;
const N_FFT = 1024;
const HOP = 256;
const MIN_BPM = 50;
const MAX_BPM = 220;
const PRIOR_BPM = 120;
/** How strongly beats must keep the tempo (higher = stricter). Ellis's default. */
const TIGHTNESS = 100;
/**
 * Spectral flux peaks slightly before a sound's attack (the analysis window
 * reaches it early). Measured at about 10 ms on test material; added back so
 * cuts land on the attack rather than just before it.
 */
const ATTACK_LATENCY_SEC = 0.01;

export interface BeatDetection {
  durationSec: number;
  bpm: number;
  /** Beat times in seconds from the start of the file. */
  beats: number[];
  /** 0..1: how clearly the beats stand out from the rest of the music. */
  confidence: number;
  /** Loudness between each beat and the next, 0..1 relative to the loudest. Same length as beats. */
  energy: number[];
}

export function detectBeats(samples: Float32Array, sampleRate = ANALYSIS_SAMPLE_RATE): BeatDetection {
  const durationSec = samples.length / sampleRate;
  const frameRate = sampleRate / HOP;
  const onset = onsetStrength(samples);
  const none: BeatDetection = { durationSec, bpm: 0, beats: [], confidence: 0, energy: [] };
  if (onset.length < frameRate * 2 || max(onset) <= 1e-9) return none;

  const periodFrames = estimatePeriod(onset, frameRate);
  const beatFrames = trackBeats(onset, periodFrames);
  if (beatFrames.length < 2) return none;

  const frameSec = HOP / sampleRate;
  const beats = beatFrames.map((f) => round4(Math.max(0, refinePeak(onset, f) * frameSec + ATTACK_LATENCY_SEC)));
  // Tempo reported from the beats actually found (median spacing), not the estimate.
  const bpm = round2(60 / median(diffs(beats)));
  return { durationSec, bpm, beats, confidence: confidenceOf(onset, periodFrames), energy: beatEnergy(samples, sampleRate, beats) };
}

// ---------------------------------------------------------------------------
// 1. Onset strength
// ---------------------------------------------------------------------------

/** Log-magnitude spectral flux per hop, centered frames, mean-removed, ≥ 0, unit std. */
export function onsetStrength(samples: Float32Array): Float32Array {
  const nFrames = Math.floor(samples.length / HOP) + 1;
  const bins = N_FFT / 2 + 1;
  const window = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const flux = new Float32Array(nFrames);
  const half = N_FFT / 2;
  for (let t = 0; t < nFrames; t++) {
    const start = t * HOP - half; // centered frame
    for (let i = 0; i < N_FFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s]! * window[i]! : 0;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
      const v = Math.log1p(100 * mag);
      cur[k] = v;
      if (t > 0) {
        const d = v - prev[k]!;
        if (d > 0) sum += d;
      }
    }
    flux[t] = sum;
    [prev, cur] = [cur, prev];
  }
  // Remove the slowly varying part (local mean over ~0.4 s) so loud passages
  // don't dominate, then keep only rises.
  const local = movingAverage(flux, Math.round((0.4 * ANALYSIS_SAMPLE_RATE) / HOP));
  const out = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t++) out[t] = Math.max(0, flux[t]! - local[t]!);
  const sd = std(out);
  if (sd > 0) for (let t = 0; t < nFrames; t++) out[t] = out[t]! / sd;
  return out;
}

// ---------------------------------------------------------------------------
// 2. Tempo
// ---------------------------------------------------------------------------

/** Beat period in onset frames (fractional). */
export function estimatePeriod(onset: Float32Array, frameRate: number): number {
  const minLag = Math.floor((60 * frameRate) / MAX_BPM);
  const maxLag = Math.ceil((60 * frameRate) / MIN_BPM);
  const ac = autocorrelation(onset, maxLag * 2 + 2);
  // Score each lag by its own autocorrelation plus its multiples, which favors
  // the true beat over its subdivisions; weight by a log-normal tempo prior.
  let best = minLag;
  let bestScore = -Infinity;
  const score = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2);
    const s = (ac[lag]! + 0.5 * (ac[2 * lag] ?? 0)) * prior;
    score[lag] = s;
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // Parabolic interpolation for a sub-frame period.
  const a = score[best - 1] ?? score[best]!;
  const b = score[best]!;
  const c = score[best + 1] ?? score[best]!;
  const denom = a - 2 * b + c;
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return best + shift;
}

function autocorrelation(x: Float32Array, maxLag: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i]! * x[i - lag]!;
    out[lag] = s / (n - lag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Beat tracking (Ellis dynamic programming)
// ---------------------------------------------------------------------------

export function trackBeats(onset: Float32Array, period: number): number[] {
  const n = onset.length;
  // Local score: onset strength smoothed by a Gaussian about period/32 wide.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(3 * sigma);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const v = onset[t + k];
      if (v !== undefined) s += v * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[t] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let bestV = -Infinity;
    let bestJ = -1;
    for (let d = lo; d <= hi; d++) {
      const j = t - d;
      if (j < 0) break;
      const v = cum[j]! - TIGHTNESS * Math.log(d / period) ** 2;
      if (v > bestV) {
        bestV = v;
        bestJ = j;
      }
    }
    cum[t] = local[t]! + (bestJ >= 0 ? Math.max(0, bestV) : 0);
    back[t] = bestJ >= 0 && bestV > 0 ? bestJ : -1;
  }
  // Last beat: the last local maximum of the cumulative score that is reasonably strong.
  const peaks: number[] = [];
  for (let t = 1; t < n - 1; t++) if (cum[t]! > cum[t - 1]! && cum[t]! >= cum[t + 1]!) peaks.push(t);
  if (peaks.length === 0) return [];
  const threshold = 0.5 * median(peaks.map((t) => cum[t]!));
  let last = peaks[peaks.length - 1]!;
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (cum[peaks[i]!]! >= threshold) {
      last = peaks[i]!;
      break;
    }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]!) {
    beats.push(t);
    if (back[t]! < 0) break;
  }
  beats.reverse();
  // Drop weak beats at either end (silence or fade before the music starts/after it ends).
  const rms = Math.sqrt(beats.reduce((s, b) => s + local[b]! ** 2, 0) / beats.length);
  const strong = (b: number) => local[b]! >= 0.5 * rms;
  let a = 0;
  let z = beats.length - 1;
  while (a < z && !strong(beats[a]!)) a++;
  while (z > a && !strong(beats[z]!)) z--;
  return beats.slice(a, z + 1);
}

/** Sub-frame position of a peak by parabolic interpolation of the onset strength. */
function refinePeak(onset: Float32Array, f: number): number {
  const a = onset[f - 1];
  const b = onset[f]!;
  const c = onset[f + 1];
  if (a === undefined || c === undefined) return f;
  const denom = a - 2 * b + c;
  if (denom >= 0) return f;
  return f + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}

/**
 * How periodic the music is at the chosen beat: the normalized autocorrelation
 * of the onset strength at one beat period (best of period ±1 frame), which is
 * near 0 for noise or random hits and clearly positive for a steady pulse.
 */
function confidenceOf(onset: Float32Array, period: number): number {
  const m = mean(onset);
  let den = 0;
  for (let i = 0; i < onset.length; i++) den += (onset[i]! - m) ** 2;
  if (den <= 0) return 0;
  let best = 0;
  for (const lag of [Math.floor(period), Math.round(period), Math.ceil(period)]) {
    let num = 0;
    for (let i = lag; i < onset.length; i++) num += (onset[i]! - m) * (onset[i - lag]! - m);
    best = Math.max(best, num / den);
  }
  return round2(Math.max(0, Math.min(1, (best - 0.05) / 0.3)));
}

function beatEnergy(samples: Float32Array, sampleRate: number, beats: number[]): number[] {
  const out = beats.map((b, i) => {
    const s = Math.max(0, Math.floor(b * sampleRate));
    const e = Math.min(samples.length, Math.floor((beats[i + 1] ?? b + (beats[i]! - (beats[i - 1] ?? b - 0.5))) * sampleRate));
    let sum = 0;
    for (let k = s; k < e; k++) sum += samples[k]! * samples[k]!;
    return e > s ? Math.sqrt(sum / (e - s)) : 0;
  });
  const top = Math.max(...out, 1e-9);
  return out.map((v) => round2(v / top));
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function movingAverage(x: Float32Array, width: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(width / 2));
  let sum = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let t = 0; t < x.length; t++) {
    while (hi < Math.min(x.length - 1, t + half)) sum += x[++hi]!, count++;
    while (lo < t - half) sum -= x[lo++]!, count--;
    out[t] = sum / count;
  }
  return out;
}

const mean = (x: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return x.length ? s / x.length : 0;
};
const std = (x: ArrayLike<number>) => {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i]! - m) ** 2;
  return x.length ? Math.sqrt(s / x.length) : 0;
};
const max = (x: ArrayLike<number>) => {
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i]! > m) m = x[i]!;
  return m;
};
export function median(x: number[]): number {
  if (x.length === 0) return 0;
  const s = [...x].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const diffs = (x: number[]) => x.slice(1).map((v, i) => v - x[i]!);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
