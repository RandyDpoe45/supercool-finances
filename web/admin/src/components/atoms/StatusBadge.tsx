/**
 * Small badge for an account's lifecycle status (e.g. `active` / `frozen`). The admin surface may
 * see statuses beyond the customer-visible set, so `status` is an open string; the CSS keys off the
 * `badge--<status>` class (an unknown status still renders, just without a bespoke color).
 */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge--${status}`} data-status={status}>
      {status}
    </span>
  );
}
