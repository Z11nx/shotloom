/**
 * Minimal model descriptors.
 *
 * A descriptor tells the UI and the orchestrator what a model accepts, in
 * provider-neutral terms. The UI renders controls from it and never needs to
 * know a provider's request schema or model id string.
 *
 * Adding a model = add a descriptor here + teach one provider adapter how to
 * map GenerationSettings onto that model's request (see docs/FUTURE.md).
 */
import type { GenerationSettings } from "./domain";

export interface ModelDescriptor {
  /** Stable key stored on jobs and used by the UI. */
  key: string;
  providerId: string;
  /** Provider's own model/endpoint id. Only the adapter interprets it. */
  modelId: string;
  label: string;
  isMock: boolean;
  duration: {
    min: number;
    max: number;
    step: number;
    default: number;
    /** Where the bounds come from, shown in docs/tooltips. */
    note: string;
  };
  resolutions: { value: string; label: string }[];
  defaultResolution: string;
  seed: { supported: boolean; min: number; max: number };
  /** Lower-case extensions (with dot) this model is known to accept as the source image. */
  sourceImageExtensions: string[];
  /**
   * Structured controls the model natively supports (future motion controls).
   * Empty means none; the UI must not offer controls that are not listed here.
   */
  nativeControls: string[];
}

export const MINIMAX_H3_MAX_I2V: ModelDescriptor = {
  key: "fal-minimax-h3-max-i2v",
  providerId: "fal",
  modelId: "minimax/h3-max/image-to-video",
  label: "MiniMax H3 Max · image to video (fal)",
  isMock: false,
  duration: {
    min: 5,
    max: 15,
    step: 1,
    default: 6,
    note:
      "App bounds carried over from the reference UI. fal's docs give no min/max (API default 5s); " +
      "output can run up to ~0.7s longer than requested.",
  },
  resolutions: [
    { value: "480P", label: "480P" },
    { value: "768P", label: "768P" },
    { value: "1080P", label: "1080P (refined from 768P)" },
  ],
  defaultResolution: "768P",
  seed: { supported: true, min: 0, max: 2_147_483_647 },
  // fal's page lists no formats; these are conventional, GIF is deliberately excluded.
  sourceImageExtensions: [".jpg", ".jpeg", ".png", ".webp"],
  nativeControls: [],
};

export const MOCK_I2V: ModelDescriptor = {
  key: "mock-i2v",
  providerId: "mock",
  modelId: "mock/image-to-video",
  label: "Mock image to video (local, free)",
  isMock: true,
  duration: { ...MINIMAX_H3_MAX_I2V.duration, note: "Mock mode mirrors the real model's bounds." },
  resolutions: MINIMAX_H3_MAX_I2V.resolutions,
  defaultResolution: "768P",
  seed: MINIMAX_H3_MAX_I2V.seed,
  sourceImageExtensions: [".jpg", ".jpeg", ".png", ".webp"],
  nativeControls: [],
};

export const MODELS: readonly ModelDescriptor[] = [MINIMAX_H3_MAX_I2V, MOCK_I2V];

export function getModel(key: string): ModelDescriptor | undefined {
  return MODELS.find((m) => m.key === key);
}

export function defaultSettings(model: ModelDescriptor): GenerationSettings {
  return { durationSec: model.duration.default, resolution: model.defaultResolution, seed: null };
}

/** Provider-neutral validation of settings against a descriptor. Returns error messages. */
export function validateSettings(model: ModelDescriptor, s: GenerationSettings): string[] {
  const errors: string[] = [];
  const d = model.duration;
  if (!Number.isInteger(s.durationSec) || s.durationSec < d.min || s.durationSec > d.max) {
    errors.push(`Duration must be a whole number from ${d.min} to ${d.max} seconds.`);
  }
  if (!model.resolutions.some((r) => r.value === s.resolution)) {
    errors.push(`Resolution must be one of: ${model.resolutions.map((r) => r.value).join(", ")}.`);
  }
  if (s.seed !== null) {
    if (!model.seed.supported) errors.push("This model does not accept a seed.");
    else if (!Number.isInteger(s.seed) || s.seed < model.seed.min || s.seed > model.seed.max) {
      errors.push(`Seed must be a whole number from ${model.seed.min} to ${model.seed.max}.`);
    }
  }
  return errors;
}

export function isSupportedSourceImage(model: ModelDescriptor, filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return model.sourceImageExtensions.includes(ext);
}
