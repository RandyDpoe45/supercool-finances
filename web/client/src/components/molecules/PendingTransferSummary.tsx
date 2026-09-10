import type { PendingTransferView } from '../../lib/transferFlow';
import { Money } from '../atoms/Money';
import { Timestamp } from '../atoms/Timestamp';

/**
 * The details of a pending (or just-posted) transfer: how much, to whom (the masked name +
 * account number for an internal transfer, or the enrolled payee's label for an external one), and
 * — while pending — when the authorization window closes. Amount is rendered float-free by `Money`.
 */
export function PendingTransferSummary({ transfer }: { transfer: PendingTransferView }) {
  const destination =
    transfer.destinationMaskedName ?? transfer.payeeDisplayName ?? 'the destination account';
  return (
    <dl className="transfer-summary">
      <div>
        <dt>Amount</dt>
        <dd>
          <Money amount={transfer.amount} currency={transfer.currency} showCode />
        </dd>
      </div>
      <div>
        <dt>To</dt>
        <dd>
          {destination}
          {transfer.destinationAccountNumber ? ` (${transfer.destinationAccountNumber})` : ''}
        </dd>
      </div>
      {transfer.expiresAt && (
        <div>
          <dt>Confirm before</dt>
          <dd>
            <Timestamp iso={transfer.expiresAt} />
          </dd>
        </div>
      )}
    </dl>
  );
}
