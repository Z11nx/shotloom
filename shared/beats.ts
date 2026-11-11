/**
 * Beat-synced editing: the math shared by the interface and the renderer, so
 * what the timeline shows is exactly what preview and export cut.
 *
 * Film time 0 is the start beat. Clip i lasts a whole number of beats, so every
 * cut lands on a beat. Cut points are computed from the song's absolute beat
 * times and rounded to the nearest video frame individually, so rounding never
 * accumulates into drift over a long song.
 */
import { effectiveTrim, usableDurationSec, type BeatSync, type FilmState, type Generation, type TimelineClip } from "./domain";

export const BEAT_ANALYSIS_VERSION = 1;
/** Below this, the UI suggests setting the tempo by hand. */
export const LOW_CONFIDENCE = 0.35;
/** Beats-per-clip choices offered in the interface (any whole number 1–32 is valid). */
export const BEATS_CHOICES = [1, 2, 4, 8, 16] as const;
export const TEMPO_SCALES = [0.25, 0.5, 1, 2, 4] as const;

export interface BeatAnalysis {
  version: number;
  filename: string;
  /** Identity of the analyzed file; a change means re-analysis. */
  sizeBytes: number;
  modifiedMs: number;
  durationSec: number;
  /** Seconds actually analyzed (long files are analyzed up to a limit). */
  analyzedSec: number;
  bpm: number;
  beats: number[];
  confidence: number;
  energy: number[];
}

export interface BeatGrid {
  /** Beat times in song seconds (after tempo choice and nudge), ascending, ≥ 0. */
  times: number[];
  /** Typical beat length, used to continue the grid past the end of the song. */
  periodSec: number;
  bpm: number;
  /** Loudness 0..1 per grid beat (for display). */
  energy: number[];
}

export function defaultBeatSync(): BeatSync {
  return { enabled: true, beatsPerClip: 4, startBeat: 0, bpm: null, scale: 1, nudgeSec: 0 };
}

/** Beat sync only applies when it is switched on and there is a soundtrack. */
export function activeBeatSync(state: FilmState): BeatSync | null {
  return state.beatSync?.enabled && state.soundtrack ? state.beatSync : null;
}

/** The beat grid for a soundtrack under the user's tempo choices. */
export function beatGrid(a: BeatAnalysis, sync: Pick<BeatSync, "bpm" | "scale" | "nudgeSec">): BeatGrid {
  let times: number[];
  let energy: number[];
  let periodSec: number;
  if (sync.bpm !== null) {
    // Typed tempo: an even grid, phase-locked to the first detected beat.
    periodSec = 60 / sync.bpm;
    const anchor = a.beats[0] ?? 0;
    const first = anchor - Math.floor(anchor / periodSec) * periodSec;
    times = [];
    for (let t = first; t < a.durationSec; t += periodSec) times.push(t);
    energy = times.map((t) => a.energy[nearestIndex(a.beats, t)] ?? 0);
  } else {
    // Detected beats, optionally doubled (midpoints added) or halved (every other beat).
    times = a.beats;
    energy = a.energy;
    let scale = sync.scale;
    while (scale >= 2) {
      const next: number[] = [];
      const nextE: number[] = [];
      times.forEach((t, i) => {
        next.push(t);
        nextE.push(energy[i] ?? 0);
        const u = times[i + 1];
        if (u !== undefined) {
          next.push((t + u) / 2);
          nextE.push(energy[i] ?? 0);
        }
      });
      times = next;
      energy = nextE;
      scale /= 2;
    }
    while (scale <= 0.5) {
      times = times.filter((_, i) => i % 2 === 0);
      energy = energy.filter((_, i) => i % 2 === 0);
      scale *= 2;
    }
    periodSec = medianGap(times) || 60 / Math.max(1, a.bpm * sync.scale);
  }
  const shifted = times.map((t) => t + sync.nudgeSec);
  const keep = shifted.map((t) => t >= 0);
  return {
    times: shifted.filter((_, i) => keep[i]).map(round4),
    energy: energy.filter((_, i) => keep[i]),
    periodSec,
    bpm: Math.round((60 / periodSec) * 10) / 10,
  };
}

/** Song time of beat k; continues at the typical beat length after the last detected beat. */
export function beatTime(grid: BeatGrid, k: number): number {
  const n = grid.times.length;
  if (n === 0) return k * grid.periodSec;
  if (k < n) return grid.times[k]!;
  return grid.times[n - 1]! + (k - (n - 1)) * grid.periodSec;
}

export interface BeatCut {
  clipId: string;
  beats: number;
  /** Index of the beat this clip starts on. */
  startBeat: number;
  /** Film seconds (start beat = 0), on exact frame boundaries. */
  startSec: number;
  endSec: number;
  startFrame: number;
  frames: number;
}

export interface BeatPlan {
  grid: BeatGrid;
  /** Where in the song the film starts (seconds). */
  offsetSec: number;
  cuts: BeatCut[];
  totalSec: number;
}

export function clipBeats(clip: Pick<TimelineClip, "beats">, sync: Pick<BeatSync, "beatsPerClip">): number {
  return clip.beats ?? sync.beatsPerClip;
}

export function planBeatCuts(
  grid: BeatGrid,
  sync: Pick<BeatSync, "startBeat" | "beatsPerClip">,
  clips: Pick<TimelineClip, "id" | "beats">[],
  fps: number,
): BeatPlan {
  const offsetSec = beatTime(grid, sync.startBeat);
  const frameAt = (k: number) => Math.round((beatTime(grid, k) - offsetSec) * fps);
  let k = sync.startBeat;
  const cuts = clips.map((clip) => {
    const beats = clipBeats(clip, sync);
    const startFrame = frameAt(k);
    const endFrame = frameAt(k + beats);
    const cut: BeatCut = {
      clipId: clip.id,
      beats,
      startBeat: k,
      startFrame,
      frames: Math.max(1, endFrame - startFrame),
      startSec: startFrame / fps,
      endSec: Math.max(startFrame + 1, endFrame) / fps,
    };
    k += beats;
    return cut;
  });
  const totalSec = cuts.length ? cuts[cuts.length - 1]!.endSec : 0;
  return { grid, offsetSec, cuts, totalSec };
}

/**
 * Seconds of usable video from the clip's in-point (its out-point is ignored in
 * beat mode; the beat count sets the length).
 */
export function availableFromIn(g: Generation): number {
  const trim = effectiveTrim(g);
  return trim ? usableDurationSec(g) - trim.inSec : 0;
}

/** True when the clip has enough video from its in-point to fill its slot (half a frame of slack). */
export function fitsSlot(g: Generation, slotSec: number, fps: number): boolean {
  return slotSec <= availableFromIn(g) + 0.5 / fps;
}

function nearestIndex(xs: number[], t: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - t) < Math.abs(xs[best]! - t)) best = i;
  return best;
}

function medianGap(times: number[]): number {
  if (times.length < 2) return 0;
  const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
  return gaps[gaps.length >> 1]!;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
