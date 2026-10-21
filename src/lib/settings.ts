/**
 * Generation settings exactly as typed, and strict parsing of them.
 *
 * The visible text is the source of truth: generation is allowed only when
 * what is on screen parses to valid settings, and then exactly those values
 * are sent. Nothing falls back to an older valid value.
 */
import type { GenerationSettings } from "../../shared/domain";
import type { ModelDescriptor } from "../../shared/models";

export interface SettingsDraft {
  durationText: string;
  resolution: string;
  /** Blank means "random". */
  seedText: string;
}

export interface ParsedSettings {
  /** Settings for Gen 1, or null if anything visible is invalid. */
  gen1: GenerationSettings | null;
  /** Settings for Gen 4 (seed is never used: four random seeds), or null if invalid. */
  gen4: GenerationSettings | null;
  errors: { duration: string | null; resolution: string | null; seed: string | null };
  /** Messages that block Gen 1 / Gen 4, in display order. */
  gen1Problems: string[];
  gen4Problems: string[];
}

export function draftFromSettings(s: GenerationSettings): SettingsDraft {
  return { durationText: String(s.durationSec), resolution: s.resolution, seedText: s.seed === null ? "" : String(s.seed) };
}

const WHOLE = /^\d+$/;

export function parseSettings(model: ModelDescriptor, draft: SettingsDraft): ParsedSettings {
  const d = model.duration;
  const durationRaw = draft.durationText.trim();
  let duration: string | null = null;
  let durationSec = NaN;
  if (durationRaw === "") duration = `Enter a duration (${d.min}–${d.max} seconds).`;
  else if (!WHOLE.test(durationRaw)) duration = `Duration must be a whole number of seconds (${d.min}–${d.max}).`;
  else {
    durationSec = Number(durationRaw);
    if (durationSec < d.min || durationSec > d.max) duration = `Duration must be from ${d.min} to ${d.max} seconds.`;
  }

  const resolution = model.resolutions.some((r) => r.value === draft.resolution)
    ? null
    : `Choose a resolution: ${model.resolutions.map((r) => r.value).join(", ")}.`;

  const seedRaw = draft.seedText.trim();
  let seed: string | null = null;
  let seedValue: number | null = null;
  if (seedRaw !== "") {
    if (!model.seed.supported) seed = "This model does not accept a seed; leave it blank.";
    else if (!WHOLE.test(seedRaw) || Number(seedRaw) < model.seed.min || Number(seedRaw) > model.seed.max) {
      seed = `Seed must be a whole number from ${model.seed.min} to ${model.seed.max}, or blank for random.`;
    } else seedValue = Number(seedRaw);
  }

  const base = [duration, resolution].filter((m): m is string => m !== null);
  const gen1Problems = seed ? [...base, seed] : base;
  const valid = base.length === 0;
  return {
    gen1: valid && !seed ? { durationSec, resolution: draft.resolution, seed: seedValue } : null,
    gen4: valid ? { durationSec, resolution: draft.resolution, seed: null } : null,
    errors: { duration, resolution, seed },
    gen1Problems,
    gen4Problems: base,
  };
}
