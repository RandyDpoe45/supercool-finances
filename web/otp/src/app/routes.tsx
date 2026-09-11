import { Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from '../components/pages/HomePage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. A single home screen carries the pending-authorization feed and
 * the code-reveal action; unknown paths redirect home. */
export function AppRoutes() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
