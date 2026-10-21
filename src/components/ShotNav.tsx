import { useEffect, useMemo, useState } from "react";
import { mediaUrl } from "../lib/api";
import { useFilm } from "../lib/filmContext";
import { shotDomId, visibleShots } from "./ShotList";

/** Narrow thumbnail navigator; the shot nearest the top of the list is highlighted. */
export function ShotNav() {
  const { film, view } = useFilm();
  const shots = useMemo(() => visibleShots(view), [view]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const root = document.querySelector(".shot-list");
    if (!root || shots.length === 0) return;
    const visible = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.index);
          if (e.isIntersecting) visible.set(i, e.boundingClientRect.top);
          else visible.delete(i);
        }
        if (visible.size) setActive(Math.min(...visible.keys()));
      },
      { root, threshold: 0.35 },
    );
    shots.forEach((_, i) => {
      const el = document.getElementById(shotDomId(i));
      if (el) {
        el.dataset.index = String(i);
        io.observe(el);
      }
    });
    return () => io.disconnect();
  }, [shots]);

  if (shots.length === 0) return <nav className="shot-nav" aria-label="Shots" />;
  return (
    <nav className="shot-nav" aria-label="Jump to shot">
      <ol>
        {shots.map((s, i) => {
          const done = s.generations.filter((g) => g.status === "completed").length;
          const working = s.generations.some((g) => !["completed", "failed", "uncertain"].includes(g.status));
          return (
            <li key={s.filename}>
              <a
                href={`#${shotDomId(i)}`}
                className={i === active ? "is-active" : undefined}
                aria-current={i === active ? "true" : undefined}
                title={`${s.filename} · ${done} ready${working ? " · generating" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  setActive(i);
                  const el = document.getElementById(shotDomId(i));
                  el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
                  el?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
                }}
              >
                <img src={mediaUrl.source(film, s.filename)} alt={s.filename} loading="lazy" />
                <span className="nav-num tabular">{String(i + 1).padStart(2, "0")}</span>
                {working && <span className="nav-working" aria-label="generating" />}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
