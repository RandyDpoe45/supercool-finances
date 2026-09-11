import type { WhoamiDto } from '../../services/api/contracts/identity';

/**
 * Seed identity for the mocked `GET /balance/admin/whoami`. Mirrors the server contract:
 * a gateway-resolved `userId` plus the realm `roles` carried on the access token. This
 * lets the Step-1 auth-shell proof render an admin identity without a running gateway.
 */
export const fixtureWhoami: WhoamiDto = {
  userId: 'admin-user-1',
  roles: ['admin'],
};
