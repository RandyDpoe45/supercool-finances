/**
 * Inline validation / server-error message for a form field. Renders nothing when there is no
 * message, so callers can pass a possibly-empty value unconditionally. `role="alert"` surfaces it
 * to assistive tech the moment it appears.
 */
export function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return (
    <p className="field-error" role="alert">
      {message}
    </p>
  );
}
