/**
 * Spec 04 — Balance Service DOMAIN layer, Step 1: the AccountsService owner-scope guard.
 *
 * Security invariant (anti-IDOR, fail-closed): an empty/blank `ownerId` must NEVER reach a
 * repository. If it did, the `owner_id` predicate could be dropped and another user's rows
 * returned. The GatewayIdentityGuard makes an empty owner unreachable in production, but
 * this guard keeps the anti-IDOR predicate structurally impossible to lose under a future
 * refactor — so it deserves direct coverage.
 *
 * Pure unit test: `new AccountsService(mockAccountRepo, mockLedgerRepo)` with `jest.fn()`
 * repos (DI decorators are inert under plain instantiation), driven through the public
 * reads. No DB, no Nest container — runs in the DEFAULT `npm test`, never skipped. The
 * assertions are strictly observable behaviour: the call REJECTS (a 500-class internal
 * fault, not a 4xx) AND the repo was NOT touched (fails closed BEFORE any query) — plus a
 * positive control proving a real ownerId is the gate, not that everything throws.
 */
import 'reflect-metadata';
import { InternalServerErrorException } from '@nestjs/common';
import { getAccountsService } from '../support/harness';

const AccountsService = getAccountsService();

const SOME_UUID = '11111111-1111-1111-1111-111111111111';

function makeService() {
  const accounts = {
    findByOwner: jest.fn(),
    findByIdAndOwner: jest.fn(),
  };
  const ledger = {
    findByAccount: jest.fn(),
  };
  const service = new AccountsService(accounts, ledger);
  return { service, accounts, ledger };
}

describe('AccountsService owner-scope guard — fails closed before any query (anti-IDOR)', () => {
  describe('listOwnedAccounts', () => {
    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('rejects a %s ownerId without ever calling the account repo', async (_label, ownerId) => {
      const { service, accounts } = makeService();

      await expect(service.listOwnedAccounts(ownerId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      // The whole point: the guard trips BEFORE the query, so no unscoped read can leak.
      expect(accounts.findByOwner).not.toHaveBeenCalled();
    });

    it('positive control: a real ownerId passes the guard and queries the owner-scoped repo', async () => {
      const { service, accounts } = makeService();
      const rows = [{ id: 'a1' }];
      accounts.findByOwner.mockResolvedValue(rows);

      await expect(service.listOwnedAccounts('sub-alice')).resolves.toBe(rows);
      expect(accounts.findByOwner).toHaveBeenCalledTimes(1);
      expect(accounts.findByOwner).toHaveBeenCalledWith('sub-alice');
    });
  });

  describe('getAccountStatement', () => {
    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('rejects a %s ownerId without touching either repo', async (_label, ownerId) => {
      const { service, accounts, ledger } = makeService();

      await expect(service.getAccountStatement(SOME_UUID, ownerId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(accounts.findByIdAndOwner).not.toHaveBeenCalled();
      expect(ledger.findByAccount).not.toHaveBeenCalled();
    });

    it('positive control: a real ownerId passes the guard and runs the owner-scoped lookup', async () => {
      const { service, accounts, ledger } = makeService();
      const account = { id: 'acc-1' };
      accounts.findByIdAndOwner.mockResolvedValue(account);
      ledger.findByAccount.mockResolvedValue([]);

      const res = await service.getAccountStatement('acc-1', 'sub-alice');

      // Ownership is verified on the account itself (both id AND owner), then the ledger
      // is read for that account under a bounded limit.
      expect(accounts.findByIdAndOwner).toHaveBeenCalledWith('acc-1', 'sub-alice');
      expect(ledger.findByAccount).toHaveBeenCalledTimes(1);
      expect(ledger.findByAccount.mock.calls[0][0]).toBe('acc-1');
      expect(typeof ledger.findByAccount.mock.calls[0][1]).toBe('number'); // bounded page limit
      expect(res.account).toBe(account);
    });
  });
});
