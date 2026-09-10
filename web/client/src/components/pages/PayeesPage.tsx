import { useState } from 'react';
import { Link } from 'react-router-dom';
import { describeApiError } from '../../lib/apiError';
import { describeTransferError } from '../../lib/transferError';
import type { PayeeDto } from '../../services/api/contracts/payees';
import { useGetPayeesQuery, useRegisterPayeeMutation } from '../../services/api/payeesApi';
import { Timestamp } from '../atoms/Timestamp';
import { PayeeEnrollmentForm } from '../organisms/PayeeEnrollmentForm';
import { PayeeList } from '../organisms/PayeeList';

/**
 * Payees page (`/payees`): enroll an external beneficiary (captcha-gated) and list the caller's
 * enrolled payees with their cooling-off status. A freshly enrolled payee is NOT immediately usable
 * — the page surfaces the cooling-off window (the instant it becomes usable, in Mexico City time),
 * which is the anti-fraud gate for external outbound. Usable payees expose a "Send money" link into
 * the external-transfer flow.
 */
export function PayeesPage() {
  const { data: payees, isLoading, isError, error } = useGetPayeesQuery();
  const [registerPayee, registerStatus] = useRegisterPayeeMutation();
  const [enrolled, setEnrolled] = useState<PayeeDto | null>(null);

  async function handleEnroll(args: { displayName: string; destinationRef: string }) {
    try {
      const payee = await registerPayee(args).unwrap();
      setEnrolled(payee);
    } catch {
      // Surfaced to the user via registerStatus.error below.
    }
  }

  return (
    <section className="transfer-page">
      <p>
        <Link to="/">← Back to accounts</Link>
      </p>
      <h1>Payees</h1>

      <h2>Enroll a new payee</h2>
      <PayeeEnrollmentForm
        onEnroll={handleEnroll}
        isEnrolling={registerStatus.isLoading}
        serverError={
          registerStatus.isError ? describeTransferError(registerStatus.error) : undefined
        }
      />

      {enrolled && (
        <div className="payee-enrolled" role="status">
          <p>
            Payee <strong>{enrolled.displayName}</strong> enrolled.
          </p>
          {enrolled.usable ? (
            <p>It is ready to receive money now.</p>
          ) : (
            <p>
              For your security it is in a cooling-off period. It will be usable from{' '}
              <Timestamp iso={enrolled.coolingOffUntil} />.
            </p>
          )}
        </div>
      )}

      <h2>Your payees</h2>
      {isLoading && <p>Loading payees…</p>}
      {isError && <p role="alert">Failed to load payees ({describeApiError(error)}).</p>}
      {!isLoading && !isError && <PayeeList payees={payees ?? []} />}
    </section>
  );
}
