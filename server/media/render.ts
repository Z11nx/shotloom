/**
 * One rendering pipeline for both preview and export, so they always agree.
 *
 * 1. Each timeline clip is cut to its trim range and normalized to the target
 *    canvas (scale to cover, center crop, square pixels, 30 fps, yuv420p H.264).
 *    Its audio is resampled to 48 kHz stereo PCM; muted or silent clips get
 *    generated silence so every segment has the same stream layout.
 * 2. Segments are joined with the concat demuxer (video copied).
 * 3. Audio is encoded once (AAC) for the whole film — optionally mixed with the
 *    soundtrack — and faded out over min(3 s, half the film). The output length
 *    is pinned to the timeline length, so a short soundtrack never shortens the video.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASPECT_CANVAS, effectiveTrim, findGeneration, validateTrim, type AspectRatio, type FilmState } from "../../shared/domain";
import { AppError } from "../errors";
import { filmDir, generationsDir } from "../films/layout";
import { assertFileName, assertUnderRoot } from "../films/paths";
import { runFfmpeg, type MediaTools } from "./ffmpeg";
import { probeMedia, type ProbeResult } from "./probe";

export const FPS = 30;

export interface PlanClip {
  clipId: string;
  label: string;
  sourcePath: string;
  inSec: number;
  durationSec: number;
  useClipAudio: boolean;
}

export interface RenderPlan {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
  clips: PlanClip[];
  totalSec: number;
  soundtrack: { path: string; offsetSec: number } | null;
}

/** Validates the whole timeline up front and returns a self-contained snapshot to render. */
export async function buildRenderPlan(
  root: string,
  film: string,
  state: FilmState,
  audioFiles: string[],
  tools: MediaTools,
): Promise<RenderPlan> {
  const problems: string[] = [];
  if (state.timeline.length === 0) problems.push("The timeline is empty. Add at least one clip.");
  const clips: PlanClip[] = [];
  // Every file the render will read must resolve inside the films root.
  const genDir = await assertUnderRoot(root, generationsDir(root, film));
  const clipPaths = new Map<string, string>();
  for (const clip of state.timeline) {
    const out = findGeneration(state, clip.generationId)?.generation.output;
    if (out) clipPaths.set(clip.generationId, await assertUnderRoot(root, path.join(genDir, assertFileName(out.filename))));
  }
  state.timeline.forEach((clip, i) => {
    const label = `Clip ${i + 1}`;
    const found = findGeneration(state, clip.generationId);
    if (!found) return problems.push(`${label}: its generation no longer exists.`);
    const { shot, generation } = found;
    const name = `${label} (${shot.filename})`;
    if (generation.status !== "completed" || !generation.output) return problems.push(`${name} is not a completed output.`);
    const sourcePath = clipPaths.get(generation.id)!;
    if (!existsSync(sourcePath)) return problems.push(`${name}: its video file is missing from disk.`);
    const trim = effectiveTrim(generation)!;
    const trimProblem = validateTrim(trim, generation.output.durationSec);
    if (trimProblem) return problems.push(`${name}: ${trimProblem}`);
    const durationSec = Math.min(trim.outSec, generation.output.durationSec) - trim.inSec;
    if (durationSec < 1 / FPS) return problems.push(`${name}: the trimmed range is shorter than one frame.`);
    clips.push({
      clipId: clip.id,
      label: name,
      sourcePath,
      inSec: trim.inSec,
      durationSec,
      useClipAudio: generation.output.hasAudio && !clip.muted,
    });
  });

  let soundtrack: RenderPlan["soundtrack"] = null;
  if (state.soundtrack) {
    const { filename, offsetSec } = state.soundtrack;
    const p = await assertUnderRoot(root, path.join(filmDir(root, film), assertFileName(filename)));
    if (!audioFiles.includes(filename) || !existsSync(p)) {
      problems.push(`Soundtrack "${filename}" is no longer in the film folder. Choose another or none.`);
    } else {
      let info: ProbeResult | null = null;
      try {
        info = await probeMedia(tools, p);
      } catch (err) {
        problems.push(`Soundtrack "${filename}" could not be read: ${(err as Error).message}`);
      }
      if (info && !info.hasAudio) problems.push(`Soundtrack "${filename}" has no audio stream.`);
      else if (info && offsetSec >= info.durationSec) {
        problems.push(`Soundtrack start (${offsetSec}s) is past the end of "${filename}" (${info.durationSec.toFixed(1)}s).`);
      } else if (info) soundtrack = { path: p, offsetSec };
    }
  }

  if (problems.length) throw new AppError(400, "TIMELINE_INVALID", problems.join(" "), { problems });
  const canvas = ASPECT_CANVAS[state.aspectRatio];
  const totalSec = clips.reduce((sum, c) => sum + c.durationSec, 0);
  return { aspectRatio: state.aspectRatio, width: canvas.width, height: canvas.height, clips, totalSec, soundtrack };
}

const sec = (n: number) => n.toFixed(3);

export async function renderPlan(
  tools: MediaTools,
  plan: RenderPlan,
  outPath: string,
  workDir: string,
  onStep: (step: string) => void = () => undefined,
): Promise<ProbeResult> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const partPath = `${outPath}.part`;
  try {
    const { width: W, height: H } = plan;
    const segmentNames: string[] = [];
    for (const [i, clip] of plan.clips.entries()) {
      onStep(`Preparing ${clip.label} (${i + 1}/${plan.clips.length})`);
      const segName = `seg_${String(i).padStart(3, "0")}.mkv`;
      const video = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[v]`;
      const audio = clip.useClipAudio
        ? `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,apad[a]`
        : `[1:a]anull[a]`;
      await runFfmpeg(tools, [
        "-ss", sec(clip.inSec),
        "-t", sec(clip.durationSec),
        "-i", clip.sourcePath,
        "-f", "lavfi",
        "-i", "anullsrc=r=48000:cl=stereo",
        "-filter_complex", `${video};${audio}`,
        "-map", "[v]",
        "-map", "[a]",
        "-t", sec(clip.durationSec),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-g", String(FPS),
        "-c:a", "pcm_s16le",
        path.join(workDir, segName),
      ]);
      segmentNames.push(segName);
    }

    // Names are generated here, never user-controlled, and resolved relative to the list file.
    const listPath = path.join(workDir, "concat.txt");
    await writeFile(listPath, segmentNames.map((n) => `file '${n}'`).join("\n") + "\n");

    onStep("Mixing audio and writing the video");
    const fadeDur = Math.min(3, plan.totalSec / 2);
    const fadeStart = Math.max(0, plan.totalSec - fadeDur);
    const fade = `afade=t=out:st=${sec(fadeStart)}:d=${sec(fadeDur)}`;
    const args = ["-f", "concat", "-safe", "0", "-i", listPath];
    let graph: string;
    if (plan.soundtrack) {
      args.push("-ss", sec(plan.soundtrack.offsetSec), "-i", plan.soundtrack.path);
      graph =
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[st];` +
        `[0:a][st]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0[mix];` +
        `[mix]${fade}[aout]`;
    } else {
      graph = `[0:a]${fade}[aout]`;
    }
    args.push(
      "-filter_complex", graph,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-t", sec(plan.totalSec),
      "-movflags", "+faststart",
      "-f", "mp4",
      partPath,
    );
    await runFfmpeg(tools, args);
    onStep("Checking the result");
    const probe = await probeMedia(tools, partPath);
    await rename(partPath, outPath);
    return probe;
  } finally {
    await rm(partPath, { force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Removes leftovers from renders interrupted by a crash. */
export async function cleanRenderScratch(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(path.join(dir, n), { recursive: true, force: true })));
}
