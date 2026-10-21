/**
 * FFmpeg / ffprobe process helpers. Always spawned with an argument array:
 * file names are never interpolated into a shell command line.
 */
export interface MediaTools {
  ffmpegPath: string;
  ffprobePath: string;
}

export class MediaToolError extends Error {
  constructor(message: string, readonly stderrTail: string) {
    super(message);
    this.name = "MediaToolError";
  }
}

async function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  } catch (err) {
    throw new MediaToolError(
      `Could not start ${bin}. Is it installed and on PATH (or set FFMPEG_PATH/FFPROBE_PATH)? ${(err as Error).message}`,
      "",
    );
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export async function runFfmpeg(tools: MediaTools, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  const { code, stderr } = await run(tools.ffmpegPath, ["-hide_banner", "-nostdin", "-y", ...args], timeoutMs);
  if (code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-12).join("\n");
    throw new MediaToolError(`ffmpeg exited with code ${code}: ${tail.split("\n").at(-1) ?? ""}`, tail);
  }
}

export async function runFfprobeJson(tools: MediaTools, args: string[], timeoutMs = 60_000): Promise<unknown> {
  const { code, stdout, stderr } = await run(
    tools.ffprobePath,
    ["-v", "error", "-print_format", "json", ...args],
    timeoutMs,
  );
  if (code !== 0) throw new MediaToolError(`ffprobe failed: ${stderr.trim().split(/\r?\n/).at(-1) ?? ""}`, stderr);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new MediaToolError("ffprobe returned unreadable output.", stdout.slice(0, 500));
  }
}

/** Returns the first line of `-version`, or throws a readable error. */
export async function toolVersion(bin: string): Promise<string> {
  const { code, stdout } = await run(bin, ["-version"], 15_000);
  if (code !== 0) throw new MediaToolError(`${bin} -version exited with ${code}`, "");
  return stdout.split(/\r?\n/)[0] ?? bin;
}
