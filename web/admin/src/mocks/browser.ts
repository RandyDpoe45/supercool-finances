import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Browser Service Worker used by `npm run dev` to intercept `/balance/admin` calls. */
export const worker = setupWorker(...handlers);
