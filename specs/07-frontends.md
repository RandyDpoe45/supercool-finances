# Spec 07 — Frontends (client / OTP / admin SPAs)

**Purpose.** Three React SPAs over the endpoint surface: the customer app, the OTP
out-of-band app, and the admin dashboard. Built once the API surface (04/05) and
transport (06) exist.

**Depends on.** [`04`](./04-balance-service.md), [`05`](./05-analytics-server.md),
[`06`](./06-transport.md).

## Shared conventions

- **React + TypeScript**, organized by **atomic design** (atoms → molecules →
  organisms → templates → pages).
- **State:** Redux Toolkit; **RTK Query** for server state / API caching (fits the
  Redux choice and removes hand-rolled fetch/caching).
- **Auth:** OIDC **Authorization Code + PKCE** against Keycloak (e.g.
  `react-oidc-context` / `oidc-client-ts`), one Keycloak client per app (spec 02).
  Access token attached to API calls; silent refresh.
- **Workspace:** a shared component library (pnpm/Turborepo) so atomic primitives
  and the auth/OIDC wiring aren't triplicated across the three apps.
- **Same-origin APIs:** each app calls its own nginx origin (`/api` or `/admin`),
  so no CORS gymnastics in the browser.

## The three apps

- **client-app** (public plane, `/api`) — accounts, balances, history; internal +
  external transfers; payee enrollment (with cooling-off shown); initiate transfer
  → **OTP confirm**; a **library captcha** on sensitive forms (demo stub).
- **otp-app** (public plane, `/api`, **separate login**) — the simulated
  out-of-band channel: lists pending authorizations and reveals/approves the code
  bound to each pending transfer.
- **admin-app** (internal plane, `/admin`) — analytics dashboard (from the
  analytics server), account management (freeze/limits), reversals with the
  **maker-checker** approval UI, audit view.

## Contracts / interfaces

- Consumes the endpoint surface of 04 (client/otp) and 05 (admin analytics).
- Auth via the per-app Keycloak clients (spec 02); redirect URIs match the nginx
  origins.

## Definition of Done

- [ ] Each app completes PKCE login and calls its API through nginx/Kong.
- [ ] client-app completes an external transfer including the OTP step (code read
      from the otp-app).
- [ ] admin-app shows analytics and performs a maker-checker reversal.
- [ ] Admin app is served only by `internal-nginx` (`:8081`).

## Open questions

- Admin dashboard screens/aggregates (couples back to spec 05's read model).
- Captcha library choice.

**Resolved:** client vs OTP layout on `public-nginx` = path-based (spec 08).
