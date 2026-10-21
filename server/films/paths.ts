/**
 * Safe handling of user-controlled names and paths.
 *
 * Every film name and file name that arrives over HTTP passes through here
 * before touching the filesystem. Rules are Windows-strict even on other
 * platforms so a film folder made on one machine works on another.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { AppError, badRequest } from "../errors";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const FILM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
// Characters Windows forbids in file names, plus control chars.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

function isReservedBase(name: string): boolean {
  const base = name.split(".")[0] ?? "";
  return WINDOWS_RESERVED.test(base.trim());
}

/** Returns an error message, or null when the film name is acceptable. */
export function filmNameProblem(name: string): string | null {
  if (!FILM_NAME_RE.test(name)) {
    return "Film names may use letters, numbers, spaces, hyphens and underscores (1–64 characters, starting with a letter or number).";
  }
  if (name.endsWith(" ")) return "Film names cannot end with a space.";
  if (isReservedBase(name)) return `"${name}" is a reserved name on Windows.`;
  return null;
}

export function assertFilmName(name: string): string {
  const problem = filmNameProblem(name);
  if (problem) throw badRequest(problem);
  return name;
}

/** Returns an error message, or null when a plain file name (no directories) is acceptable. */
export function fileNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 255) return "File name length is invalid.";
  if (name === "." || name === "..") return "Invalid file name.";
  if (FORBIDDEN_CHARS.test(name)) return "File name contains characters that are not allowed.";
  if (name.startsWith(".")) return "Hidden files are not served.";
  if (/[. ]$/.test(name)) return "File names cannot end with a dot or space.";
  if (isReservedBase(name)) return "File name is reserved on Windows.";
  return null;
}

export function assertFileName(name: string): string {
  const problem = fileNameProblem(name);
  if (problem) throw badRequest(problem);
  return name;
}

/**
 * Decodes one URL path segment exactly once. Rejects anything that decodes to
 * a path separator (so %2F / %5C cannot smuggle directories) or is malformed.
 */
export function decodeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw badRequest("Malformed URL encoding.");
  }
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    throw badRequest("Path separators are not allowed here.");
  }
  return decoded;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0];
  return first !== "..";
}

function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Verifies that `abs` is inside `root`, both lexically and after resolving
 * symlinks/junctions. `root` is the trust anchor (always the configured films
 * root, resolved to its real location, so a root that is itself a link works).
 *
 * For a path that does not exist yet, its nearest existing ancestor must
 * resolve inside the root; a dangling link anywhere on the way is refused,
 * because writing through it would create the file at the link's target.
 *
 * Comparison is component-wise via path.relative (never a string prefix) and
 * case-insensitive on Windows.
 */
export async function assertUnderRoot(root: string, abs: string): Promise<string> {
  const lexical = path.resolve(abs);
  const lexRoot = path.resolve(root);
  if (!isInside(normalizeForCompare(lexRoot), normalizeForCompare(lexical))) {
    throw outsideRoot(lexRoot, lexical);
  }
  let realRoot: string;
  try {
    realRoot = await realpath(lexRoot);
  } catch {
    return lexical; // root missing: nothing exists yet that could lead outside it
  }
  let probe = lexical;
  for (;;) {
    let real: string | null = null;
    try {
      real = await realpath(probe);
    } catch {
      real = null;
    }
    if (real !== null) {
      if (!isInside(normalizeForCompare(realRoot), normalizeForCompare(real))) throw outsideRoot(lexRoot, lexical);
      return lexical;
    }
    // Not resolvable: either it does not exist, or it is a dangling link.
    const st = await lstat(probe).catch(() => null);
    if (st) throw outsideRoot(lexRoot, lexical, "a link whose target is missing");
    const parent = path.dirname(probe);
    if (parent === probe || !isInside(normalizeForCompare(lexRoot), normalizeForCompare(parent))) return lexical;
    probe = parent;
  }
}

function outsideRoot(root: string, target: string, what = "a link or junction that points outside it"): AppError {
  const rel = path.relative(root, target) || ".";
  return new AppError(
    400,
    "PATH_OUTSIDE_ROOT",
    `“${rel}” goes through ${what}. Shotloom only reads and writes inside the films folder (${root}). ` +
      "Replace the link with a real folder, or move the files into the films folder.",
  );
}

/** Joins validated segments under root and verifies the result with assertUnderRoot. */
export async function resolveInside(root: string, ...segments: string[]): Promise<string> {
  return assertUnderRoot(root, path.resolve(root, ...segments));
}
