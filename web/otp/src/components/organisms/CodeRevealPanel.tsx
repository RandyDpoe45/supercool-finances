import { useEffect, useState } from 'react';
import { parseApiError } from '../../lib/apiError';
import { useGenerateOtpMutation } from '../../services/api/otpApi';
import { Alert } from '../atoms/Alert';
import { Button } from '../atoms/Button';
import { RevealedCode } from '../molecules/RevealedCode';

interface RevealedState {
  code: string;
  deadlineMs: number;
}

/**
 * The code-reveal action. When enabled, a primary action mints (`POST /api/otp`) and shows
 * the returned code once with its ttl countdown and one-time warning. The plaintext code
 * lives only transiently — in local state and RTK Query's in-memory mutation cache — and is
 * dropped the moment its ttl elapses (the effect clears local state AND calls `reset()` to
 * drop the cached `{ code, ttlSeconds }`), never logged or persisted to durable storage.
 * When there is nothing valid to authorize, `disabledReason` explains why and the action is
 * withheld.
 *
 * Errors are mapped to user-facing copy: the singleton gate (`409 OTP_ALREADY_ACTIVE`)
 * explains a code is already active and shown-once; `401` prompts re-auth; anything else
 * surfaces the envelope message (or a generic fallback). The error path also calls `reset()`,
 * which clears the hook's local state; the rejected mutation entry itself may remain in the
 * in-memory store, but it holds only the error envelope (`code`/`message`/`requestId`) — never
 * a plaintext OTP code — and nothing is persisted to durable storage.
 */
export function CodeRevealPanel({ disabledReason }: { disabledReason: string | null }) {
  const [generateOtp, { isLoading, reset }] = useGenerateOtpMutation();
  const [revealed, setRevealed] = useState<RevealedState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Do not keep the plaintext code past its ttl — not in local state, and not in RTK Query's
  // mutation cache: `reset()` drops the `{ code, ttlSeconds }` the mutation entry still holds
  // after a successful mint. Clear both the moment the deadline hits.
  useEffect(() => {
    if (revealed === null) {
      return;
    }
    const drop = (): void => {
      setRevealed(null);
      reset();
    };
    const msLeft = revealed.deadlineMs - Date.now();
    if (msLeft <= 0) {
      drop();
      return;
    }
    const id = setTimeout(drop, msLeft);
    return () => clearTimeout(id);
  }, [revealed, reset]);

  async function onReveal(): Promise<void> {
    setErrorMessage(null);
    try {
      const result = await generateOtp().unwrap();
      setRevealed({ code: result.code, deadlineMs: Date.now() + result.ttlSeconds * 1000 });
    } catch (error) {
      setErrorMessage(messageForOtpError(error));
      reset();
    }
  }

  return (
    <section className="reveal" aria-label="code-reveal">
      {revealed !== null ? (
        <RevealedCode code={revealed.code} deadlineMs={revealed.deadlineMs} />
      ) : disabledReason !== null ? (
        <p className="reveal__disabled">{disabledReason}</p>
      ) : (
        <Button onClick={() => void onReveal()} disabled={isLoading} aria-label="reveal-code">
          {isLoading ? 'Revealing…' : 'Reveal one-time code'}
        </Button>
      )}
      {errorMessage !== null ? <Alert variant="error">{errorMessage}</Alert> : null}
    </section>
  );
}

function messageForOtpError(error: unknown): string {
  const parsed = parseApiError(error);
  if (parsed.code === 'OTP_ALREADY_ACTIVE' || parsed.status === 409) {
    return 'A one-time code is already active. It was shown once — wait for it to expire before requesting a new one.';
  }
  if (parsed.status === 401) {
    return 'Your session has expired. Please sign in again.';
  }
  return parsed.message ?? 'Could not generate a one-time code. Please try again.';
}
