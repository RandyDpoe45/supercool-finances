import { AuthProvider } from 'react-oidc-context';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './app/routes';
import { AuthGate } from './auth/AuthGate';
import { userManager } from './auth/userManager';
import { store } from './store/store';

// After the redirect back from Keycloak, strip the `code`/`state` query params from
// the URL so a reload does not attempt to re-process a spent authorization code.
function onSigninCallback(): void {
  window.history.replaceState({}, document.title, window.location.pathname);
}

export function App() {
  return (
    <AuthProvider userManager={userManager} onSigninCallback={onSigninCallback}>
      <Provider store={store}>
        <BrowserRouter>
          <AuthGate>
            <AppRoutes />
          </AuthGate>
        </BrowserRouter>
      </Provider>
    </AuthProvider>
  );
}
