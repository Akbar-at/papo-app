# PAPO application API

This API implements application-managed admin authentication, audited booth/frame/configuration/voucher provisioning and the online voucher-to-gallery device flow. See the [repository README](../../README.md) and [authentication design](../../docs/AUTHENTICATION.md) for setup and scope.

From the repository root, `npm run dev` starts the UI and production request handlers with persistent local PGlite and filesystem photo storage. Admin credentials are generated once in ignored `.local/api/admin.json`; device fixtures are in `.local/api/credentials.json`. Neither file should be logged or tracked.

The API exposes `/v1/auth/login`, `/v1/auth/me`, `/v1/auth/logout`, `/v1/auth/password`, `/v1/admin/workspace` and the provisioning/device routes documented in `packages/contracts/openapi.yaml`. Human admins use the application's HttpOnly session cookie with same-origin mutation checks. Booths use separate bearer credentials.

`npm run smoke` runs the disposable voucher-to-gallery HTTP check. `npm test` runs PostgreSQL-backed tests; `npm run test:web` exercises the real admin browser journey. Local device test pages are available at `/test/booth` and `/test/status`; `/docs` serves the contract explorer.

Application migrations are in `db/migrations`. Never run synthetic load-test SQL against this database. Cloud operations require an explicit request to resume the paused environment. Public Worker routes and Cron schedules remain disabled in the scaffold.
