import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountStatementPage } from '../components/pages/AccountStatementPage';
import { AccountsPage } from '../components/pages/AccountsPage';
import { AppShell } from '../components/templates/AppShell';

/**
 * Authenticated routes. `/` is the accounts overview; selecting an account opens its
 * statement. Transfers / payees arrive in later steps.
 */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<AccountsPage />} />
        <Route path="/accounts/:id/transactions" element={<AccountStatementPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
