type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** One frame at 30 fps: jump back while the last frame before the out point is on screen. */
const FRAME_SEC = 1 / 30;

/**
 * Loops playback inside [inSec, outSec) frame-accurately, so a trimmed clip or
 * a clip whose ignored tail follows `outSec` never shows frames past the out
 * point. Uses requestVideoFrameCallback (Chrome, Edge, Safari, recent Firefox);
 * callers keep a `timeupdate` check as a backstop for other browsers. When the
 * range runs to the file's end, the native `loop` attribute does the work.
 * Returns a cleanup function.
 */
export function loopWithinRange(video: HTMLVideoElement, range: () => { inSec: number; outSec: number } | undefined): () => void {
  const v = video as FrameVideo;
  if (!v.requestVideoFrameCallback) return () => undefined;
  let stopped = false;
  let handle = 0;
  const tick = (_now: number, meta: { mediaTime: number }) => {
    if (stopped) return;
    const r = range();
    const fileEnd = Number.isFinite(v.duration) ? v.duration : Infinity;
    if (r && !v.paused && r.outSec < fileEnd - 0.01 && meta.mediaTime >= r.outSec - FRAME_SEC) v.currentTime = r.inSec;
    handle = v.requestVideoFrameCallback!(tick);
  };
  handle = v.requestVideoFrameCallback(tick);
  return () => {
    stopped = true;
    v.cancelVideoFrameCallback?.(handle);
  };
}
