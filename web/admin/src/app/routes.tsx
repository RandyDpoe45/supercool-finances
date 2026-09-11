import { Navigate, Route, Routes } from 'react-router-dom';
import { AccountsPage } from '../components/pages/AccountsPage';
import { AnalyticsPage } from '../components/pages/AnalyticsPage';
import { AuditPage } from '../components/pages/AuditPage';
import { HomePage } from '../components/pages/HomePage';
import { LimitsPage } from '../components/pages/LimitsPage';
import { ReversalsPage } from '../components/pages/ReversalsPage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. Home carries the whoami identity landing; `/accounts` is account
 * management (freeze/unfreeze), `/limits` is the limits editor, `/reversals` is the maker-checker
 * reversals screen, `/audit` is the read-only audit view; `/analytics` is the analytics dashboard
 * (two report sections over the analytics server); unknown paths redirect home. */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/limits" element={<LimitsPage />} />
        <Route path="/reversals" element={<ReversalsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
