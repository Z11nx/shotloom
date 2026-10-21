import { describe, expect, test } from "bun:test";
import type { PromptBlock } from "../shared/domain";
import { composePrompt } from "../shared/prompt";

const block = (id: string, text: string, enabled = true): PromptBlock => ({
  id,
  text,
  enabled,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("composePrompt", () => {
  test("enabled blocks in displayed order, then shot text, separated by blank lines", () => {
    const blocks = [block("a", "Style A"), block("b", "Style B"), block("c", "Style C")];
    expect(composePrompt(blocks, "The shot")).toBe("Style A\n\nStyle B\n\nStyle C\n\nThe shot");
  });

  test("respects a reordered array exactly", () => {
    const blocks = [block("c", "C"), block("a", "A"), block("b", "B")];
    expect(composePrompt(blocks, "S")).toBe("C\n\nA\n\nB\n\nS");
  });

  test("skips disabled blocks", () => {
    expect(composePrompt([block("a", "On"), block("b", "Off", false)], "S")).toBe("On\n\nS");
  });

  test("trims each segment and drops empty ones", () => {
    const blocks = [block("a", "  padded \n"), block("b", "   "), block("c", "")];
    expect(composePrompt(blocks, "\n shot text  ")).toBe("padded\n\nshot text");
  });

  test("keeps inner line breaks of a segment", () => {
    expect(composePrompt([block("a", "line 1\nline 2")], "")).toBe("line 1\nline 2");
  });

  test("empty when nothing is enabled and no shot text", () => {
    expect(composePrompt([block("a", "x", false)], "   ")).toBe("");
  });
});
