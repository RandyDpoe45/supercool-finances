import { useEffect, useRef, useState } from 'react';

const COPIED_FEEDBACK_MS = 1500;

/**
 * Quiet utility button that copies `value` to the clipboard, showing a transient
 * "Copied" confirmation. `label` is the STABLE accessible name (e.g. "Copy account
 * number") — it stays fixed while the visible text toggles, so the button's accessible
 * name never changes mid-interaction. The clipboard write is guarded so the control is
 * safe (and stubbable) where the Clipboard API is unavailable.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Clipboard unavailable/denied (e.g. document not focused) — leave the affordance unchanged.
    }
  }

  return (
    <button type="button" className="util-btn" aria-label={label} onClick={() => void copy()}>
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
