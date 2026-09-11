import type { ReactNode } from 'react';

type AlertVariant = 'error' | 'warning' | 'info';

/** Inline status/alert atom. `error` gets `role="alert"` (assertive) so failures are
 * announced; the softer variants use `role="status"`. */
export function Alert({ variant, children }: { variant: AlertVariant; children: ReactNode }) {
  return (
    <div role={variant === 'error' ? 'alert' : 'status'} className={`alert alert--${variant}`}>
      {children}
    </div>
  );
}
