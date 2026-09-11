import { Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from '../components/pages/HomePage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. O1 has a single home screen (the pending indicator); the real
 * pending-feed + code-reveal routes arrive in O2. */
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
