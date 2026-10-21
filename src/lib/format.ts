export function secs(n: number): string {
  return `${n.toFixed(n < 10 ? 2 : 1)}s`;
}

/** m:ss.s for longer totals. */
export function clock(n: number): string {
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** True when a keyboard event comes from a place where the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "submit", "reset"].includes(type);
  }
  return false;
}
