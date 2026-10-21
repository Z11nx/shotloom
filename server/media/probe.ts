import { runFfprobeJson, type MediaTools } from "./ffmpeg";

export interface ProbeResult {
  durationSec: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probeMedia(tools: MediaTools, file: string): Promise<ProbeResult> {
  const out = (await runFfprobeJson(tools, ["-show_format", "-show_streams", file])) as FfprobeOutput;
  const streams = out.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(out.format?.duration ?? video?.duration ?? audio?.duration ?? NaN);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine media duration.");
  return {
    durationSec: Math.round(duration * 1000) / 1000,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}
