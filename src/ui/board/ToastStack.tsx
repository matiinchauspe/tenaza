import type { ToastViewModel } from "./useInboxActions";

export interface ToastStackProps {
  toasts: readonly ToastViewModel[];
}

/**
 * Pure presentational: `useInboxActions` owns the list and each toast's own lifetime; this
 * component only renders whatever it's handed. Any CSS fade-out is cosmetic, not load-bearing
 * — the toast's actual removal is `useInboxActions`' `TOAST_LIFETIME_MS`.
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
