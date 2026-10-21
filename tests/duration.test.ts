import { describe, expect, test } from "bun:test";
import { effectiveTrim, usableDurationSec, validateTrim, type Generation } from "../shared/domain";

function gen(requested: number, actual: number | null, trim: { inSec: number; outSec: number } | null = null): Generation {
  return {
    settings: { durationSec: requested, resolution: "768P", seed: null },
    output: actual === null ? null : { filename: "x.mp4", sizeBytes: 1, durationSec: actual, width: 1366, height: 768, hasAudio: true },
    trim,
  } as unknown as Generation;
}

describe("requested vs returned length", () => {
  test("a longer clip is used at the requested length (fal returns ~5.2 s for 5 s)", () => {
    expect(usableDurationSec(gen(5, 5.208))).toBe(5);
    expect(effectiveTrim(gen(5, 5.208))).toEqual({ inSec: 0, outSec: 5 });
    expect(usableDurationSec(gen(10, 10.21))).toBe(10);
  });
  test("tiny overruns (≤ 0.05 s) and shorter clips are used in full", () => {
    expect(usableDurationSec(gen(5, 5.04))).toBe(5.04);
    expect(usableDurationSec(gen(6, 5.8))).toBe(5.8);
    expect(effectiveTrim(gen(6, 5.8))).toEqual({ inSec: 0, outSec: 5.8 });
  });
  test("a saved trim reaching into the ignored tail stops at the requested end", () => {
    expect(effectiveTrim(gen(5, 5.208, { inSec: 1, outSec: 5.208 }))).toEqual({ inSec: 1, outSec: 5 });
    expect(effectiveTrim(gen(5, 5.208, { inSec: 1, outSec: 4 }))).toEqual({ inSec: 1, outSec: 4 });
  });
  test("a trim that lives only in the tail, or runs past the file, is kept as saved", () => {
    expect(effectiveTrim(gen(5, 5.208, { inSec: 4.95, outSec: 5.2 }))).toEqual({ inSec: 4.95, outSec: 5.2 });
    const bad = effectiveTrim(gen(5, 5.208, { inSec: 1, outSec: 99 }))!;
    expect(bad).toEqual({ inSec: 1, outSec: 99 });
    expect(validateTrim(bad, 5.208)).toMatch(/past the end/);
  });
  test("no output means no trim", () => {
    expect(effectiveTrim(gen(5, null))).toBeNull();
    expect(usableDurationSec(gen(5, null))).toBe(0);
  });
});
