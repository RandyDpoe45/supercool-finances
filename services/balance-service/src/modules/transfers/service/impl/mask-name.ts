/**
 * Privacy mask for a payee holder name. Applied by the SERVICE (never the controller) so the
 * raw name — PII — never leaves the service boundary: the confirmation-of-payee flow shows the
 * masked name so a payer can sanity-check who they are paying WITHOUT the balance service
 * disclosing the full name of an account they merely know the number of.
 *
 * Rule: split on whitespace (runs collapse), each token → its first 3 characters + exactly two
 * asterisks (fixed, uniform, non-length-revealing), joined by single spaces. `"Juan Perez"` →
 * `"Jua** Per**"`. An empty or whitespace-only name → `""`. A token shorter than 3 chars keeps
 * what it has plus the two asterisks (e.g. `"Al"` → `"Al**"`).
 *
 * Pure function — no I/O, deterministic.
 */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `${token.slice(0, 3)}**`)
    .join(' ');
}
