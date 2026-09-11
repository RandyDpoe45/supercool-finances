import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountsPage } from '../components/pages/AccountsPage';
import { AnalyticsPage } from '../components/pages/AnalyticsPage';
import { HomePage } from '../components/pages/HomePage';
import { LimitsPage } from '../components/pages/LimitsPage';
import { ReversalsPage } from '../components/pages/ReversalsPage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. Home carries the whoami identity landing; `/accounts` is account
 * management (freeze/unfreeze), `/limits` is the limits editor, `/reversals` is the maker-checker
 * reversals screen; `/analytics` is the placeholder dashboard; unknown paths redirect home. */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/limits" element={<LimitsPage />} />
        <Route path="/reversals" element={<ReversalsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
