import type { AuditLogDto } from '../../services/api/contracts/audit';
import { Timestamp } from '../atoms/Timestamp';

/**
 * The admin audit log as a strictly READ-ONLY table (the log is append-only — this view never renders
 * an editable control for any audit field): when (Mexico City), the acting admin, the action (a small
 * `<code>` tag), the target (`targetType` / `targetId`, an em-dash when both are null), and the
 * `metadata` before/after blob. `metadata` is DELIBERATELY surfaced — it IS the audit content — and is
 * rendered as a collapsible `<details>` of key/value pairs (an em-dash, no disclosure, when null). Any
 * money inside `metadata` stays a minor-unit STRING (values are rendered verbatim, never parsed to a
 * float). Owns the empty state; the page owns the read query's loading/error and the filter/paging.
 */
export function AuditTable({ entries }: { entries: AuditLogDto[] }) {
  if (entries.length === 0) {
    return <p>No audit entries.</p>;
  }
  return (
    <table aria-label="audit log" className="data-table">
      <thead>
        <tr>
          <th scope="col">When (Mexico City)</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Target</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} data-audit-id={entry.id}>
            <td>
              <Timestamp iso={entry.createdAt} />
            </td>
            <td className="data-table__ref">{entry.actorId}</td>
            <td>
              <code className="audit-action">{entry.action}</code>
            </td>
            <td className="data-table__ref">
              {entry.targetType === null && entry.targetId === null ? (
                <span className="data-table__muted">—</span>
              ) : (
                <>
                  <span className="data-table__muted">{entry.targetType ?? '—'}</span>{' '}
                  {entry.targetId ?? '—'}
                </>
              )}
            </td>
            <td>
              <AuditMetadata metadata={entry.metadata} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Read-only disclosure of an entry's `metadata`. `null` (or an empty object) renders a muted em-dash
 * with no expandable control; otherwise a `<details>` expands to a `<dl>` of key → value pairs. */
function AuditMetadata({ metadata }: { metadata: Record<string, unknown> | null }) {
  const pairs = metadata === null ? [] : Object.entries(metadata);
  if (pairs.length === 0) {
    return <span className="data-table__muted">—</span>;
  }
  return (
    <details className="audit-meta">
      <summary>Details</summary>
      <dl className="audit-meta__list">
        {pairs.map(([key, value]) => (
          <div key={key} className="audit-meta__row">
            <dt>{key}</dt>
            <dd>{formatMetaValue(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Render a metadata value for display WITHOUT coercing money: strings (including minor-unit money
 * strings) and other primitives render verbatim; nested objects/arrays render as compact JSON. Never
 * uses `Number`/`parseFloat`, so an int64 minor-unit amount keeps full precision. */
function formatMetaValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
