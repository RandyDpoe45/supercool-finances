import { useEffect, useReducer, useRef } from 'react';
import { Link } from 'react-router-dom';
import { describeApiError } from '../../lib/apiError';
import { describeTransferError, transferErrorCode } from '../../lib/transferError';
import {
  initialTransferFlowState,
  transferFlowReducer,
  type PendingTransferView,
  type ResolvedPayee,
} from '../../lib/transferFlow';
import { useGetAccountsQuery } from '../../services/api/accountsApi';
import type { PendingAuthorizationDto, TransferDto } from '../../services/api/contracts/transfers';
import {
  useCancelTransferMutation,
  useConfirmTransferMutation,
  useGetPendingAuthorizationQuery,
  useInitiateTransferMutation,
  useResolveDestinationMutation,
} from '../../services/api/transfersApi';
import { PayeeConfirmation } from '../molecules/PayeeConfirmation';
import { PendingTransferSummary } from '../molecules/PendingTransferSummary';
import { ResolveDestinationForm } from '../organisms/ResolveDestinationForm';
import { TransferAmountForm } from '../organisms/TransferAmountForm';
import { TransferConfirmPanel } from '../organisms/TransferConfirmPanel';

/** Merge an initiate `TransferDto` with the resolved payee's display into the confirm-step view
 * (the DTO deliberately omits the destination, which the client already holds). */
function toPendingView(dto: TransferDto, payee: ResolvedPayee): PendingTransferView {
  return {
    transferId: dto.id,
    amount: dto.amount,
    currency: dto.currency,
    destinationAccountNumber: payee.accountNumber,
    destinationMaskedName: payee.maskedName,
    payeeDisplayName: null,
    expiresAt: dto.expiresAt,
  };
}

/** Project a pending-feed entry into the confirm-step view (used when resuming an existing
 * pending transfer discovered on mount). */
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
 * The internal-transfer journey (spec 07 / spec 04 Transfers): confirmation of payee → amount +
 * captcha → initiate (PENDING) → OTP confirm (POSTED) or cancel. The page is the orchestrator — it
 * owns the pure flow state machine ({@link transferFlowReducer}) and the RTK Query mutations, and
 * threads a SINGLE idempotency key (generated once the payee is confirmed) through every initiate
 * attempt so a retry never double-submits. A pending transfer discovered on mount resumes at the
 * confirm step (the caller has at most one). The one-time code is obtained OUT OF BAND from the OTP
 * app — this page never mints or reveals it.
 */
export function TransferPage() {
  const [state, dispatch] = useReducer(transferFlowReducer, initialTransferFlowState);

  const {
    data: accounts,
    isLoading: accountsLoading,
    isError: accountsError,
    error: accountsErr,
  } = useGetAccountsQuery();
  const { data: pending, refetch: refetchPending } = useGetPendingAuthorizationQuery();

  const [resolveDestination, resolveStatus] = useResolveDestinationMutation();
  const [initiateTransfer, initiateStatus] = useInitiateTransferMutation();
  const [confirmTransfer, confirmStatus] = useConfirmTransferMutation();
  const [cancelTransfer, cancelStatus] = useCancelTransferMutation();

  // Resume an existing pending transfer AT MOST ONCE, right after the initial pending-feed load —
  // afterwards the flow is driven only by the user's own actions (so a post-confirm refetch can't
  // bounce them back into a stale confirm step).
  const autoResumeDone = useRef(false);
  useEffect(() => {
    if (autoResumeDone.current || pending === undefined) {
      return;
    }
    autoResumeDone.current = true;
    if (state.step === 'resolve' && pending.authorization) {
      dispatch({ type: 'resumePending', transfer: pendingDtoToView(pending.authorization) });
    }
  }, [pending, state.step]);

  async function handleResolve(accountNumber: string) {
    try {
      const result = await resolveDestination({ accountNumber }).unwrap();
      dispatch({
        type: 'destinationResolved',
        payee: {
          accountNumber,
          maskedName: result.maskedName,
          currency: result.currency,
          confirmationToken: result.confirmationToken,
        },
      });
    } catch {
      // Surfaced to the user via resolveStatus.error below.
    }
  }

  function renderStep() {
    switch (state.step) {
      case 'resolve':
        return (
          <ResolveDestinationForm
            onResolve={handleResolve}
            isResolving={resolveStatus.isLoading}
            serverError={
              resolveStatus.isError ? describeTransferError(resolveStatus.error) : undefined
            }
          />
        );

      case 'confirmPayee':
        return (
          <PayeeConfirmation
            payee={state.payee}
            onConfirm={() =>
              dispatch({ type: 'payeeConfirmed', idempotencyKey: crypto.randomUUID() })
            }
            onReject={() => dispatch({ type: 'payeeRejected' })}
          />
        );

      case 'amount': {
        const amountState = state;
        const onInitiate = async ({
          sourceAccountId,
          amount,
          confirmDuplicate,
        }: {
          sourceAccountId: string;
          amount: string;
          confirmDuplicate: boolean;
        }) => {
          try {
            const dto = await initiateTransfer({
              idempotencyKey: amountState.idempotencyKey,
              sourceAccountId,
              destinationAccountNumber: amountState.payee.accountNumber,
              amount,
              currency: amountState.payee.currency,
              confirmationToken: amountState.payee.confirmationToken,
              confirmDuplicate: confirmDuplicate || undefined,
            }).unwrap();
            dispatch({
              type: 'transferInitiated',
              transfer: toPendingView(dto, amountState.payee),
            });
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
            // Other errors surface via initiateStatus.error below.
          }
        };

        if (accountsLoading) {
          return <p>Loading your accounts…</p>;
        }
        if (accountsError) {
          return (
            <p role="alert">Failed to load your accounts ({describeApiError(accountsErr)}).</p>
          );
        }
        return (
          <TransferAmountForm
            payee={amountState.payee}
            accounts={accounts ?? []}
            onInitiate={onInitiate}
            isInitiating={initiateStatus.isLoading}
            serverError={
              initiateStatus.isError ? describeTransferError(initiateStatus.error) : undefined
            }
            suspectedDuplicate={amountState.suspectedDuplicate}
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
              <button type="button" onClick={() => dispatch({ type: 'reset' })}>
                Send another
              </button>
              <Link to="/">Back to accounts</Link>
            </div>
          </div>
        );

      case 'cancelled':
        return (
          <div className="transfer-result">
            <p role="status">Transfer cancelled.</p>
            <div className="form-actions">
              <button type="button" onClick={() => dispatch({ type: 'reset' })}>
                Start a new transfer
              </button>
              <Link to="/">Back to accounts</Link>
            </div>
          </div>
        );
    }
  }

  // "Start over" is only offered before a transfer exists server-side (confirmPayee / amount):
  // there is nothing to clean up but a short-lived confirmation token. Once PENDING, the user must
  // Cancel (which properly releases it), not silently abandon it.
  const canStartOver = state.step === 'confirmPayee' || state.step === 'amount';

  return (
    <section className="transfer-page">
      <p>
        <Link to="/">← Back to accounts</Link>
      </p>
      <h1>Send money</h1>
      {renderStep()}
      {canStartOver && (
        <p>
          <button
            type="button"
            className="button--link"
            onClick={() => dispatch({ type: 'reset' })}
          >
            Start over
          </button>
        </p>
      )}
    </section>
  );
}
