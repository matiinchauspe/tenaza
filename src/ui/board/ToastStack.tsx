import type { ToastViewModel } from "./useInboxActions";

export interface ToastStackProps {
  toasts: readonly ToastViewModel[];
}

/**
 * Ticket 10 (spec "Requests vs agents"): "resolving a request gives
 * visible feedback: a short toast... never a silent vanish." Pure
 * presentational, bottom-right, stacked — `useInboxActions` owns the
 * list and each toast's own lifetime; this component only renders
 * whatever it's handed right now. No exit animation beyond CSS
 * (`tokens.css`'s own `@media (prefers-reduced-motion: reduce)` already
 * disables it globally) — the prototype's own fade-out is cosmetic, not
 * load-bearing for the toast's actual lifetime (`useInboxActions`'
 * `TOAST_LIFETIME_MS`, which removes it from the list outright).
 */
export function ToastStack({ toasts }: ToastStackProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.message}
        </div>
      ))}
    </div>
  );
}
