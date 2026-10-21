import { useCallback, useState } from "react";

export interface Toast {
  id: number;
  message: string;
}

let nextId = 1;

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string) => {
      const id = nextId++;
      setItems((t) => [...t.filter((x) => x.message !== message), { id, message }].slice(-4));
      setTimeout(() => dismiss(id), 9000);
    },
    [dismiss],
  );
  return { items, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss message" onClick={() => onDismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
