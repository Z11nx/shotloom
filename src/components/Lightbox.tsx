import { useEffect, useRef, useState } from "react";
import type { LightboxRequest } from "../lib/filmContext";
import { isTypingTarget } from "../lib/format";
import { loopWithinRange } from "../lib/loopRange";

/** Enlarged viewer. Generated clips loop with sound. Escape closes, ←/→ step through items, Space plays/pauses. */
export function Lightbox({ request, onClose }: { request: LightboxRequest; onClose: () => void }) {
  const [index, setIndex] = useState(request.index);
  const item = request.items[index];
  const video = useRef<HTMLVideoElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  useEffect(() => {
    closeBtn.current?.focus();
    const back = restoreFocus.current;
    return () => back?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
      else if (e.key === "ArrowRight" && index < request.items.length - 1) setIndex(index + 1);
      else if (e.key === " " && video.current) {
        e.preventDefault();
        const v = video.current;
        if (v.paused) void v.play().catch(() => undefined);
        else v.pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, request.items.length, onClose]);

  // Frame-accurate looping inside the clip's range (trim, or requested length).
  useEffect(() => {
    const v = video.current;
    if (!v || item?.kind !== "video" || !item.loop) return;
    return loopWithinRange(v, () => item.range);
  }, [item]);

  if (!item) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={item.title} onClick={onClose}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <span>{item.title}</span>
          {request.items.length > 1 && (
            <span className="tabular muted">
              {index + 1} / {request.items.length} · ← → to step
            </span>
          )}
          <button ref={closeBtn} type="button" className="btn" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
        {item.kind === "image" ? (
          <img src={item.src} alt={item.title} />
        ) : (
          <video
            key={item.src}
            ref={video}
            src={item.range ? `${item.src}#t=${item.range.inSec}` : item.src}
            controls
            autoPlay
            loop={item.loop ?? false}
            muted={false}
            playsInline
            onLoadedMetadata={(e) => {
              // Autoplay with sound may be refused; retry muted so playback still starts.
              const v = e.currentTarget;
              v.play().catch(() => {
                v.muted = true;
                void v.play().catch(() => undefined);
              });
            }}
            onTimeUpdate={(e) => {
              const r = item.range;
              const v = e.currentTarget;
              // Loop inside the trim (the native loop covers untrimmed clips).
              if (r && !v.paused && (v.currentTime >= r.outSec || v.currentTime < r.inSec - 0.1)) v.currentTime = r.inSec;
            }}
          />
        )}
      </div>
    </div>
  );
}
