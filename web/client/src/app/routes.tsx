import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountStatementPage } from '../components/pages/AccountStatementPage';
import { AccountsPage } from '../components/pages/AccountsPage';
import { ExternalTransferPage } from '../components/pages/ExternalTransferPage';
import { PayeesPage } from '../components/pages/PayeesPage';
import { TransferPage } from '../components/pages/TransferPage';
import { AppShell } from '../components/templates/AppShell';

/**
 * Authenticated routes. `/` is the accounts overview; selecting an account opens its statement;
 * `/transfers/new` runs the internal-transfer journey; `/payees` enrolls + lists external payees;
 * `/transfers/external` runs the external-outbound journey (to an enrolled, cooled-off payee).
 */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<AccountsPage />} />
        <Route path="/accounts/:id/transactions" element={<AccountStatementPage />} />
        <Route path="/transfers/new" element={<TransferPage />} />
        <Route path="/payees" element={<PayeesPage />} />
        <Route path="/transfers/external" element={<ExternalTransferPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
