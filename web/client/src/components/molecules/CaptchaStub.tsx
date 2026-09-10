import { useEffect, useId, useState } from 'react';
import { isCaptchaSolved, makeCaptchaChallenge, type CaptchaChallenge } from '../../lib/captcha';

/**
 * Client-only demo captcha gating a sensitive form (spec 07). Renders a trivial arithmetic
 * challenge; as the user types, it reports whether the challenge is solved via `onSolvedChange`,
 * so the parent can enable/disable the initiate action. No network, no external service — a
 * prototype gate, not a real bot defense. A "new challenge" control re-rolls it.
 */
export function CaptchaStub({ onSolvedChange }: { onSolvedChange: (solved: boolean) => void }) {
  const inputId = useId();
  const [challenge, setChallenge] = useState<CaptchaChallenge>(() => makeCaptchaChallenge());
  const [answer, setAnswer] = useState('');

  const solved = isCaptchaSolved(challenge, answer);

  // Report solved-state to the parent whenever it changes (including a reset on a new challenge).
  useEffect(() => {
    onSolvedChange(solved);
  }, [solved, onSolvedChange]);

  function newChallenge() {
    setChallenge(makeCaptchaChallenge());
    setAnswer('');
  }

  return (
    <div className="captcha">
      <label htmlFor={inputId}>
        Confirm you are human: what is {challenge.a} + {challenge.b}?
      </label>
      <div className="captcha__row">
        <input
          id={inputId}
          inputMode="numeric"
          autoComplete="off"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          aria-invalid={answer !== '' && !solved}
        />
        <button type="button" onClick={newChallenge}>
          New challenge
        </button>
        {solved && <span className="captcha__ok">✓</span>}
      </div>
    </div>
  );
}
