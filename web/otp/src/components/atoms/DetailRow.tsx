import type { ReactNode } from 'react';

/** A single label/value line inside a `<dl>` details list. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <dt className="detail-row__label">{label}</dt>
      <dd className="detail-row__value">{children}</dd>
    </div>
  );
}
