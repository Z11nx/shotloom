/** Unit tests for the editor's pure client modules. */
import { describe, expect, test } from "bun:test";
import { MOCK_I2V } from "../shared/models";
import { draftFromSettings, parseSettings } from "../src/lib/settings";
import { ViewGate } from "../src/lib/viewGate";

describe("ViewGate", () => {
  test("accepts the current selection's newest response only", () => {
    const g = new ViewGate();
    const a = g.select("A")!;
    const t1 = g.token(a);
    const t2 = g.token(a);
    expect(g.accept(t2, "A")).toBe(true);
    expect(g.accept(t1, "A")).toBe(false); // older than what is shown
  });

  test("rejects responses for another film", () => {
    const g = new ViewGate();
    const a = g.select("A")!;
    const t = g.token(a);
    g.select("B");
    expect(g.accept(t, "A")).toBe(false);
    expect(g.accept(t, "B")).toBe(false);
  });

  test("rejects a view whose film differs from its token", () => {
    const g = new ViewGate();
    const a = g.select("A")!;
    expect(g.accept(g.token(a), "B")).toBe(false);
  });

  test("A → B → A: a token from the first A session is stale in the second", () => {
    const g = new ViewGate();
    const a1 = g.select("A")!;
    const old = g.token(a1);
    g.select("B");
    const a2 = g.select("A")!;
    expect(a2.film).toBe("A");
    expect(a2.epoch).not.toBe(a1.epoch);
    expect(g.isCurrent(a1)).toBe(false);
    expect(g.accept(old, "A")).toBe(false);
    expect(g.accept(g.token(a2), "A")).toBe(true);
  });

  test("a token taken late for an old selection is still stale", () => {
    const g = new ViewGate();
    const a = g.select("A")!;
    g.select("B");
    const late = g.token(a); // e.g. after awaiting a delayed save
    expect(g.accept(late, "A")).toBe(false);
  });
});

describe("parseSettings (visible text is the truth)", () => {
  const draft = (durationText: string, seedText = "", resolution = "768P") => ({ durationText, seedText, resolution });

  test("valid settings round-trip exactly", () => {
    expect(parseSettings(MOCK_I2V, draft("9", "4242", "480P")).gen1).toEqual({ durationSec: 9, resolution: "480P", seed: 4242 });
    expect(parseSettings(MOCK_I2V, draftFromSettings({ durationSec: 6, resolution: "768P", seed: null })).gen1).toEqual({
      durationSec: 6,
      resolution: "768P",
      seed: null,
    });
  });

  test.each(["", "  ", "6.5", "6.0", "2", "16", "0", "-3", "1e1", "six"])("duration %p blocks Gen 1 and Gen 4", (d) => {
    const p = parseSettings(MOCK_I2V, draft(d));
    expect(p.gen1).toBeNull();
    expect(p.gen4).toBeNull();
    expect(p.errors.duration).not.toBeNull();
    expect(p.gen4Problems.length).toBeGreaterThan(0);
  });

  test("blank seed means random", () => {
    expect(parseSettings(MOCK_I2V, draft("6", "")).gen1?.seed).toBeNull();
  });

  test.each(["-1", "1.5", "99999999999", "1e3", "abc"])("seed %p blocks Gen 1 only", (seed) => {
    const p = parseSettings(MOCK_I2V, draft("6", seed));
    expect(p.gen1).toBeNull();
    expect(p.errors.seed).not.toBeNull();
    expect(p.gen4).toEqual({ durationSec: 6, resolution: "768P", seed: null });
  });

  test("an unknown resolution blocks both", () => {
    const p = parseSettings(MOCK_I2V, draft("6", "", "4K"));
    expect(p.gen1).toBeNull();
    expect(p.gen4).toBeNull();
  });
});
