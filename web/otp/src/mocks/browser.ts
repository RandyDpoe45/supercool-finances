import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Browser Service Worker used by `npm run dev` to intercept `/balance/api` calls. */
export const worker = setupWorker(...handlers);
