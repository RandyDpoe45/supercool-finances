import { AuthProvider } from 'react-oidc-context';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './app/routes';
import { AuthGate } from './auth/AuthGate';
import { userManager } from './auth/userManager';
import { store } from './store/store';

// This app is served under the `/otp` base, so the router shares that basename (Vite
// exposes it as BASE_URL, e.g. `/otp/`); react-router wants it without a trailing slash.
const routerBasename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

// After the redirect back from Keycloak, strip the `code`/`state` query params from
// the URL so a reload does not attempt to re-process a spent authorization code. The
// pathname already carries the `/otp/` base, so replacing to it keeps us in-app.
function onSigninCallback(): void {
  window.history.replaceState({}, document.title, window.location.pathname);
}

export function App() {
  return (
    <AuthProvider userManager={userManager} onSigninCallback={onSigninCallback}>
      <Provider store={store}>
        <BrowserRouter basename={routerBasename}>
          <AuthGate>
            <AppRoutes />
          </AuthGate>
        </BrowserRouter>
      </Provider>
    </AuthProvider>
  );
}
