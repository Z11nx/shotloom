/**
 * Synthetic test songs with known beat times: kick on beats 1 and 3, snare on
 * 2 and 4, hi-hats on eighth notes, a bass line on the beat and a sustained
 * chord pad underneath. Deterministic (seeded noise), so tests are repeatable.
 */
export interface SongSpec {
  bpm: number;
  durationSec: number;
  /** Silence before the first beat. */
  leadInSec?: number;
  sampleRate?: number;
  /** Delays every second eighth-note hi-hat by this fraction of an eighth (0 = straight). */
  swing?: number;
  /** Leaves out the kick and snare, keeping hats, bass and pad (a harder case). */
  noDrums?: boolean;
  /** Gradual tempo change: the last beat's BPM (defaults to bpm). */
  endBpm?: number;
}

export interface Song {
  samples: Float32Array;
  sampleRate: number;
  beats: number[];
}

export function makeSong(spec: SongSpec): Song {
  const sr = spec.sampleRate ?? 22050;
  const n = Math.round(spec.durationSec * sr);
  const out = new Float32Array(n);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };

  // Beat times, allowing a linear tempo ramp.
  const beats: number[] = [];
  let t = spec.leadInSec ?? 0;
  const endBpm = spec.endBpm ?? spec.bpm;
  while (t < spec.durationSec - 0.05) {
    beats.push(Math.round(t * 10000) / 10000);
    const bpm = spec.bpm + (endBpm - spec.bpm) * (t / spec.durationSec);
    t += 60 / bpm;
  }

  const add = (startSec: number, len: number, fn: (k: number, tSec: number) => number) => {
    const s = Math.round(startSec * sr);
    for (let k = 0; k < len && s + k < n; k++) if (s + k >= 0) out[s + k]! += fn(k, k / sr);
  };
  const bassNotes = [55, 55, 65.4, 49];
  beats.forEach((b, i) => {
    const next = beats[i + 1] ?? b + 60 / spec.bpm;
    const period = next - b;
    if (!spec.noDrums) {
      if (i % 2 === 0) {
        // Kick: pitch-dropping sine, fast decay.
        add(b, Math.round(0.25 * sr), (_k, ts) => 0.9 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-ts * 30)) * ts) * Math.exp(-ts * 14));
      } else {
        // Snare: noise burst plus a tone.
        add(b, Math.round(0.18 * sr), (_k, ts) => (0.5 * noise() + 0.25 * Math.sin(2 * Math.PI * 190 * ts)) * Math.exp(-ts * 22));
      }
    }
    // Hi-hats on eighths.
    for (const [j, off] of [0, 0.5 + (spec.swing ?? 0) * 0.5].entries()) {
      add(b + off * period, Math.round(0.05 * sr), () => (j === 0 ? 0.16 : 0.1) * noise() * 1);
    }
    // Bass on each beat.
    const f = bassNotes[Math.floor(i / 4) % bassNotes.length]!;
    add(b, Math.round(period * 0.9 * sr), (_k, ts) => 0.28 * Math.sin(2 * Math.PI * f * ts) * Math.min(1, ts * 200) * Math.exp(-ts * 3));
  });
  // Pad: a sustained chord across the whole song.
  for (let k = 0; k < n; k++) {
    const ts = k / sr;
    out[k]! += 0.05 * (Math.sin(2 * Math.PI * 220 * ts) + Math.sin(2 * Math.PI * 277.2 * ts) + Math.sin(2 * Math.PI * 329.6 * ts));
  }
  // Normalize to -1 dBFS.
  let peak = 0;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(out[k]!));
  const g = 0.89 / (peak || 1);
  for (let k = 0; k < n; k++) out[k]! *= g;
  return { samples: out, sampleRate: sr, beats };
}

/** Writes a song as a 16-bit mono WAV (for render tests through FFmpeg). */
export function wavBytes(song: Song): Uint8Array {
  const { samples, sampleRate } = song;
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return new Uint8Array(buf);
}

/** For each true beat, the distance to the nearest detected beat (seconds). */
export function beatErrors(truth: number[], found: number[]): number[] {
  return truth.map((b) => Math.min(...found.map((f) => Math.abs(f - b))));
}
