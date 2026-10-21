/**
 * Small disclosure popover for secondary actions. The trigger is a normal
 * button (aria-expanded); the panel closes on Escape (focus returns to the
 * trigger), on an outside click, or when an action calls close().
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function Popover({
  label,
  trigger,
  children,
  align = "start",
  className = "",
  triggerClassName = "btn btn-sm",
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`popover-wrap ${className}`} ref={wrap}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div id={id} className={`popover popover-${align}`} role="group" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
