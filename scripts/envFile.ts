/**
 * Keeps .env in step with .env.example when Shotloom gains a new setting.
 *
 * - No .env yet: it is created as a copy of .env.example.
 * - .env exists: any setting that .env.example defines and .env does not
 *   mention at all (set or commented out) is appended at the end, with its
 *   explanatory comment and its example value. Every example value equals the
 *   built-in default, so appending one never changes behavior.
 *
 * Existing lines are never changed, reordered or removed, line endings are
 * kept, and values are never printed. Writes are atomic (temp file + rename).
 */
import { existsSync } from "node:fs";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const MENTION = /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export interface ExampleSetting {
  key: string;
  /** The comment lines directly above the setting, then the setting line itself. */
  lines: string[];
}

/** Settings that .env.example assigns (uncommented), each with its comment block. */
export function exampleSettings(example: string): ExampleSetting[] {
  const lines = example.split(/\r?\n/);
  const out: ExampleSetting[] = [];
  lines.forEach((line, i) => {
    const m = ASSIGN.exec(line);
    if (!m) return;
    let start = i;
    while (start > 0 && /^\s*#/.test(lines[start - 1]!) && !MENTION.test(lines[start - 1]!)) start--;
    out.push({ key: m[1]!, lines: lines.slice(start, i + 1) });
  });
  return out;
}

/** Every key .env mentions, whether set or commented out (a commented key is a deliberate choice). */
export function mentionedKeys(env: string): Set<string> {
  const keys = new Set<string>();
  for (const line of env.split(/\r?\n/)) {
    const m = MENTION.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

export type EnvUpdate = { action: "created" } | { action: "added"; keys: string[] } | { action: "none" };

export async function ensureEnvSettings(envPath: string, examplePath: string): Promise<EnvUpdate> {
  if (!existsSync(examplePath)) return { action: "none" };
  const example = await readFile(examplePath, "utf8");
  if (!existsSync(envPath)) {
    await atomicWrite(envPath, example);
    return { action: "created" };
  }
  const target = await realpath(envPath); // if .env is a link, update the file it points to
  const current = await readFile(target, "utf8");
  const have = mentionedKeys(current);
  const missing = exampleSettings(example).filter((s) => !have.has(s.key));
  if (missing.length === 0) return { action: "none" };

  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const block = [
    "",
    `# Added by Shotloom on ${new Date().toISOString().slice(0, 10)}: new setting${missing.length > 1 ? "s" : ""}, at ${missing.length > 1 ? "their" : "its"} default.`,
    ...missing.flatMap((s, i) => (i === 0 ? s.lines : ["", ...s.lines])),
  ].join(eol);
  const sep = current === "" || current.endsWith("\n") ? "" : eol;
  await atomicWrite(target, `${current}${sep}${block}${eol}`);
  return { action: "added", keys: missing.map((s) => s.key) };
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.env.shotloom-${process.pid}.tmp`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
