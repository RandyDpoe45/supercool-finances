import { Link, useNavigate } from 'react-router-dom';
import { describeApiError } from '../../lib/apiError';
import { transferErrorCode } from '../../lib/transferError';
import { useCreateAccountMutation } from '../../services/api/accountsApi';
import { CreateAccountForm } from '../organisms/CreateAccountForm';

/** A short, human message for a create-account error. The account cap (`ACCOUNT_LIMIT_REACHED`,
 * HTTP 422) is mapped to a friendly line — keyed off the stable domain code, per the app's
 * convention of branching on the code rather than the raw status; everything else falls back to the
 * generic transport phrase. The raw error envelope is never rendered verbatim. */
function describeCreateAccountError(error: unknown): string {
  if (transferErrorCode(error) === 'ACCOUNT_LIMIT_REACHED') {
    return 'You have reached the maximum number of accounts and cannot open another.';
  }
  return `Could not create the account (${describeApiError(error)}).`;
}

/**
 * Create-account page (`/accounts/new`): name a new account and open it. The page owns the mutation;
 * on success it navigates back to the accounts overview (`/`), where the new account appears via the
 * accounts LIST cache invalidation. The new account is money-safe by construction on the server
 * (empty balances, MXN, active) — nothing money-related is entered here.
 */
export function CreateAccountPage() {
  const navigate = useNavigate();
  const [createAccount, status] = useCreateAccountMutation();

  async function handleCreate({ label }: { label: string }) {
    try {
      await createAccount({ label }).unwrap();
      navigate('/');
    } catch {
      // Surfaced to the user via status.error below.
    }
  }

  return (
    <section className="transfer-page">
      <p>
        <Link to="/">← Back to accounts</Link>
      </p>
      <h1>Open a new account</h1>
      <p>Give your new account a name. It starts empty (MXN) and appears in your accounts list.</p>

      <CreateAccountForm
        onCreate={handleCreate}
        isCreating={status.isLoading}
        serverError={status.isError ? describeCreateAccountError(status.error) : undefined}
      />
    </section>
  );
}
