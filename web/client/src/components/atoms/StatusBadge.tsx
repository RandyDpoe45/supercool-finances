import type { AccountStatus } from '../../services/api/contracts/accounts';

/** Small badge for an account's lifecycle status (`active` / `frozen`). */
export function StatusBadge({ status }: { status: AccountStatus }) {
  return (
    <span className={`badge badge--${status}`} data-status={status}>
      {status}
    </span>
  );
}
