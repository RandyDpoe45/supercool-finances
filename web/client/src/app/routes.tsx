import { Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from '../components/pages/HomePage';
import { AppShell } from '../components/templates/AppShell';

/** Authenticated routes. F1 has a single home screen; feature routes arrive later. */
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
