/// <reference types="vite/client" />

// Typed access to the app's build-time env (see .env.example). Merges with the
// base ImportMetaEnv that vite/client declares.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OIDC_AUTHORITY?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
  readonly VITE_ENABLE_API_MOCKS?: string;
  readonly VITE_DEV_OTP_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
