import { Navigate, Route, Routes } from 'react-router-dom';
import { AnalyticsPage } from '../components/pages/AnalyticsPage';
import { HomePage } from '../components/pages/HomePage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. Home carries the whoami identity landing; `/analytics` is the
 * placeholder dashboard; unknown paths redirect home. */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
