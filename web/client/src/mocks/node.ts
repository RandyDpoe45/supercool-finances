import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** MSW node server for the test suite to import and drive (listen/reset/close). */
export const server = setupServer(...handlers);
