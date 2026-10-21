import type { PromptBlock } from "./domain";

/**
 * Builds the text submitted to a provider: enabled shared blocks in their
 * displayed order, then the shot's own text. Each segment is trimmed, empty
 * segments are dropped, and segments are separated by a blank line.
 *
 * Used by both the server (authoritative) and the client (read-only preview),
 * so the preview always matches what is sent.
 */
export function composePrompt(blocks: readonly PromptBlock[], shotText: string): string {
  const segments = [...blocks.filter((b) => b.enabled).map((b) => b.text), shotText];
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Editable starter block added to new films. Original wording; delete or change freely. */
export const DEFAULT_STYLE_BLOCK_TEXT =
  "Cinematic live-action footage with natural, motivated lighting. Steady, deliberate camera. " +
  "Keep the subject, framing and colors faithful to the source image.";
