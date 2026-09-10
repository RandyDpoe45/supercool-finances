import { useEffect, useReducer, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { describeApiError } from '../../lib/apiError';
import {
  externalTransferFlowReducer,
  initialExternalTransferFlowState,
} from '../../lib/externalTransferFlow';
import { describeTransferError, transferErrorCode } from '../../lib/transferError';
import type { PendingTransferView } from '../../lib/transferFlow';
import { useGetAccountsQuery } from '../../services/api/accountsApi';
import type { PayeeDto } from '../../services/api/contracts/payees';
import type { PendingAuthorizationDto, TransferDto } from '../../services/api/contracts/transfers';
import { useGetPayeesQuery } from '../../services/api/payeesApi';
import {
  useCancelTransferMutation,
  useConfirmTransferMutation,
  useGetPendingAuthorizationQuery,
  useInitiateExternalTransferMutation,
} from '../../services/api/transfersApi';
import { PendingTransferSummary } from '../molecules/PendingTransferSummary';
import { ExternalTransferForm } from '../organisms/ExternalTransferForm';
import { TransferConfirmPanel } from '../organisms/TransferConfirmPanel';

/** Merge an initiate `TransferDto` with the enrolled payee's label into the confirm-step view (the
 * external DTO omits the destination, which is the enrolled payee the client already selected). */
function toPendingView(dto: TransferDto, payee: PayeeDto | undefined): PendingTransferView {
  return {
    transferId: dto.id,
    amount: dto.amount,
    currency: dto.currency,
    destinationAccountNumber: null,
    destinationMaskedName: null,
    payeeDisplayName: payee?.displayName ?? null,
    expiresAt: dto.expiresAt,
  };
}

/** Project a pending-feed entry into the confirm-step view (used when resuming an existing pending
 * transfer discovered on mount). */
function pendingDtoToView(authorization: PendingAuthorizationDto): PendingTransferView {
  return {
    transferId: authorization.transferId,
    amount: authorization.amount,
    currency: authorization.currency,
    destinationAccountNumber: authorization.destinationAccountNumber,
    destinationMaskedName: authorization.destinationMaskedName,
    payeeDisplayName: authorization.payeeDisplayName,
    expiresAt: authorization.expiresAt,
  };
}

/**
 * The external-transfer journey (spec 07 / spec 04 external outbound): pick a usable enrolled payee
 * + source + amount + captcha → initiate (PENDING — a HOLD is placed now, so `available` drops) →
 * OTP confirm (settles) or cancel (releases the hold). There is NO resolve/confirmation-token step;
 * the cooling-off delay is the anti-fraud gate. The page owns the pure external flow state machine
 * and threads a SINGLE idempotency key (fixed at flow start) through every initiate attempt so a
 * retry never double-submits. It reuses the shared OTP confirm/cancel panel + pending feed from the
 * internal flow. A pending transfer discovered on mount resumes at the confirm step. The one-time
 * code is obtained OUT OF BAND from the OTP app — this page never mints or reveals it.
 */
export function ExternalTransferPage() {
  const [searchParams] = useSearchParams();
  const initialPayeeId = searchParams.get('payeeId') ?? undefined;

  // The idempotency key is generated ONCE per mounted flow and re-used across every initiate attempt
  // (including a "Send anyway" duplicate re-submit). A reset mints a fresh one via the reducer.
  const [state, dispatch] = useReducer(externalTransferFlowReducer, undefined, () =>
    initialExternalTransferFlowState(crypto.randomUUID()),
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    isError: accountsError,
    error: accountsErr,
  } = useGetAccountsQuery();
  const {
    data: payees,
    isLoading: payeesLoading,
    isError: payeesError,
    error: payeesErr,
  } = useGetPayeesQuery();
  const { data: pending, refetch: refetchPending } = useGetPendingAuthorizationQuery();

  const [initiateExternal, initiateStatus] = useInitiateExternalTransferMutation();
  const [confirmTransfer, confirmStatus] = useConfirmTransferMutation();
  const [cancelTransfer, cancelStatus] = useCancelTransferMutation();

  // Resume an existing pending transfer AT MOST ONCE, right after the initial pending-feed load —
  // afterwards the flow is driven only by the user's own actions.
  const autoResumeDone = useRef(false);
  useEffect(() => {
    if (autoResumeDone.current || pending === undefined) {
      return;
    }
    autoResumeDone.current = true;
    if (state.step === 'compose' && pending.authorization) {
      dispatch({ type: 'resumePending', transfer: pendingDtoToView(pending.authorization) });
    }
  }, [pending, state.step]);

  function renderStep() {
    switch (state.step) {
      case 'compose': {
        const composeState = state;
        const onInitiate = async ({
          payeeId,
          sourceAccountId,
          amount,
          currency,
          confirmDuplicate,
        }: {
          payeeId: string;
          sourceAccountId: string;
          amount: string;
          currency: string;
          confirmDuplicate: boolean;
        }) => {
          try {
            const dto = await initiateExternal({
              idempotencyKey: composeState.idempotencyKey,
              sourceAccountId,
              payeeId,
              amount,
              currency,
              confirmDuplicate: confirmDuplicate || undefined,
            }).unwrap();
            const payee = (payees ?? []).find((candidate) => candidate.id === payeeId);
            dispatch({ type: 'transferInitiated', transfer: toPendingView(dto, payee) });
          } catch (error) {
            const code = transferErrorCode(error);
            if (code === 'SUSPECTED_DUPLICATE') {
              dispatch({ type: 'duplicateSuspected' });
            } else if (code === 'PENDING_TRANSFER_CONFLICT') {
              const resumed = await refetchPending()
                .unwrap()
                .catch(() => undefined);
              if (resumed?.authorization) {
                dispatch({
                  type: 'resumePending',
                  transfer: pendingDtoToView(resumed.authorization),
                });
              }
            }
            // Other errors (cooling-off, insufficient funds, …) surface via initiateStatus.error.
          }
        };

        if (accountsLoading || payeesLoading) {
          return <p>Loading your accounts and payees…</p>;
        }
        if (accountsError) {
          return (
            <p role="alert">Failed to load your accounts ({describeApiError(accountsErr)}).</p>
          );
        }
        if (payeesError) {
          return <p role="alert">Failed to load your payees ({describeApiError(payeesErr)}).</p>;
        }
        return (
          <ExternalTransferForm
            payees={payees ?? []}
            accounts={accounts ?? []}
            initialPayeeId={initialPayeeId}
            onInitiate={onInitiate}
            isInitiating={initiateStatus.isLoading}
            serverError={
              initiateStatus.isError ? describeTransferError(initiateStatus.error) : undefined
            }
            suspectedDuplicate={composeState.suspectedDuplicate}
          />
        );
      }

      case 'awaitingOtp': {
        const confirmError = confirmStatus.isError
          ? describeTransferError(confirmStatus.error)
          : cancelStatus.isError
            ? describeTransferError(cancelStatus.error)
            : undefined;
        const transfer = state.transfer;
        return (
          <TransferConfirmPanel
            transfer={transfer}
            onConfirm={async (code) => {
              try {
                await confirmTransfer({ transferId: transfer.transferId, code }).unwrap();
                dispatch({ type: 'transferPosted' });
              } catch {
                // Surfaced via confirmStatus.error.
              }
            }}
            onCancel={async () => {
              try {
                await cancelTransfer({ transferId: transfer.transferId }).unwrap();
                dispatch({ type: 'transferCancelled' });
              } catch {
                // Surfaced via cancelStatus.error.
              }
            }}
            isConfirming={confirmStatus.isLoading}
            isCancelling={cancelStatus.isLoading}
            serverError={confirmError}
          />
        );
      }

      case 'posted':
        return (
          <div className="transfer-result">
            <p role="status">Transfer sent.</p>
            <PendingTransferSummary transfer={state.transfer} />
            <div className="form-actions">
              <button
                type="button"
                onClick={() => dispatch({ type: 'reset', idempotencyKey: crypto.randomUUID() })}
              >
                Send another
              </button>
              <Link to="/payees">Back to payees</Link>
            </div>
          </div>
        );

      case 'cancelled':
        return (
          <div className="transfer-result">
            <p role="status">Transfer cancelled. The held amount has been released.</p>
            <div className="form-actions">
              <button
                type="button"
                onClick={() => dispatch({ type: 'reset', idempotencyKey: crypto.randomUUID() })}
              >
                Start a new transfer
              </button>
              <Link to="/payees">Back to payees</Link>
            </div>
          </div>
        );
    }
  }

  return (
    <section className="transfer-page">
      <p>
        <Link to="/payees">← Back to payees</Link>
      </p>
      <h1>Pay an external payee</h1>
      {renderStep()}
    </section>
  );
}
