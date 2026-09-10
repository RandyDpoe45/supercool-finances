import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountStatementPage } from '../components/pages/AccountStatementPage';
import { AccountsPage } from '../components/pages/AccountsPage';
import { TransferPage } from '../components/pages/TransferPage';
import { AppShell } from '../components/templates/AppShell';

/**
 * Authenticated routes. `/` is the accounts overview; selecting an account opens its
 * statement; `/transfers/new` runs the internal-transfer journey. Payees arrive in a later step.
 */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<AccountsPage />} />
        <Route path="/accounts/:id/transactions" element={<AccountStatementPage />} />
        <Route path="/transfers/new" element={<TransferPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
