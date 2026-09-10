import { useId, useState, type FormEvent } from 'react';
import { FieldError } from '../atoms/FieldError';
import { CaptchaStub } from '../molecules/CaptchaStub';

/** Mirrors the service's enrollment schema so obviously-malformed input is caught before a request;
 * the server re-validates regardless. `displayName` is trimmed then bounded 1..120; `destinationRef`
 * is a 6–20 digit numeric string (the external account number). */
const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 120;
const DESTINATION_REF = /^\d{6,20}$/;

/**
 * Enroll an external beneficiary — a sensitive, fraud-relevant form, so it is gated by the demo
 * captcha (spec 07). The payer supplies only a display label + the external account number; the
 * outbound rail is a server-side constant and is NEVER sent. On submit the trimmed values are handed
 * up; the page owns the request and shows the resulting cooling-off window. Enroll stays disabled
 * until BOTH fields are shape-valid AND the captcha is solved.
 */
export function PayeeEnrollmentForm({
  onEnroll,
  isEnrolling,
  serverError,
}: {
  onEnroll: (args: { displayName: string; destinationRef: string }) => void;
  isEnrolling: boolean;
  serverError?: string;
}) {
  const nameId = useId();
  const refId = useId();

  const [displayName, setDisplayName] = useState('');
  const [destinationRef, setDestinationRef] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [refTouched, setRefTouched] = useState(false);
  const [captchaSolved, setCaptchaSolved] = useState(false);

  const trimmedName = displayName.trim();
  const nameValid =
    trimmedName.length >= DISPLAY_NAME_MIN && trimmedName.length <= DISPLAY_NAME_MAX;
  const trimmedRef = destinationRef.trim();
  const refValid = DESTINATION_REF.test(trimmedRef);
  const canSubmit = nameValid && refValid && captchaSolved && !isEnrolling;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setNameTouched(true);
    setRefTouched(true);
    if (!canSubmit) {
      return;
    }
    onEnroll({ displayName: trimmedName, destinationRef: trimmedRef });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="transfer-form">
      <label htmlFor={nameId}>Payee name</label>
      <input
        id={nameId}
        autoComplete="off"
        placeholder="e.g. Landlord"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        onBlur={() => setNameTouched(true)}
        aria-invalid={nameTouched && !nameValid}
      />
      <FieldError
        message={nameTouched && !nameValid ? 'Enter a name (1–120 characters).' : undefined}
      />

      <label htmlFor={refId}>External account number</label>
      <input
        id={refId}
        inputMode="numeric"
        autoComplete="off"
        placeholder="6–20 digits"
        value={destinationRef}
        onChange={(event) => setDestinationRef(event.target.value)}
        onBlur={() => setRefTouched(true)}
        aria-invalid={refTouched && !refValid}
      />
      <FieldError
        message={refTouched && !refValid ? 'Enter a 6–20 digit account number.' : undefined}
      />

      <CaptchaStub onSolvedChange={setCaptchaSolved} />

      <FieldError message={serverError} />

      <div className="form-actions">
        <button type="submit" disabled={!canSubmit}>
          {isEnrolling ? 'Enrolling…' : 'Enroll payee'}
        </button>
      </div>
    </form>
  );
}
