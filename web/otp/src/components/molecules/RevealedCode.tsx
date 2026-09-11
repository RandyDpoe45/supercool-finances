import { Alert } from '../atoms/Alert';
import { Countdown } from '../atoms/Countdown';

/**
 * Displays a freshly minted one-time code PROMINENTLY, with its live ttl countdown and the
 * one-time warning. The server never re-reveals the code, so the copy is explicit that it
 * is shown once. The parent owns the code's lifetime and drops it from memory at ttl end.
 */
export function RevealedCode({ code, deadlineMs }: { code: string; deadlineMs: number }) {
  return (
    <div className="revealed-code">
      <p className="revealed-code__label">Your one-time code</p>
      <p className="revealed-code__value" aria-label="one-time-code">
        {code}
      </p>
      <p className="revealed-code__ttl">
        Valid for <Countdown deadlineMs={deadlineMs} expiredLabel="expired — request a new code" />
      </p>
      <Alert variant="warning">
        Shown once — it cannot be retrieved again. Type it into the SuperCool app now to confirm
        your transfer. If it expires, request a new one.
      </Alert>
    </div>
  );
}
