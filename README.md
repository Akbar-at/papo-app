# PAPO application

The application home for PAPO: the admin web app, booth/session API, shared contract and application database migrations. Source was copied from the application slice in `Akbar-at/papo-load-test` at `eebeb3789910bbd583642f7d4a725041c73827e7`. Synthetic load-test code, credentials, local state and generated results were excluded.

Admin identity is managed entirely by the application. Password login, sessions and authorization use application code and PostgreSQL. Cloudflare Access is not required; Worker/R2 remain deployment adapters.

## Delivery plan

The [six-month delivery plan](docs/SIX_MONTH_DELIVERY_PLAN.html) maps the initial features to monthly milestones, named ownership, dependencies and release gates. Open the standalone HTML in a browser or print it to PDF.

## Local development

Use Node 24 (Node 22+ supported). From this repository root:

```bash
npm ci --cache /tmp/papo-npm-cache
npm run dev
```

The local server serves the admin app on loopback port 8787 with persistent PGlite and filesystem photos. On first startup it creates a business, site, demo booth, frame, voucher and superadmin. Sign in with the generated email/password in **`.local/api/admin.json`**. This ignored private file is created with mode 0600; keep it out of logs, screenshots and Git. Set `PAPO_ADMIN_EMAIL` and `PAPO_ADMIN_PASSWORD` before first startup to supply your own local credentials. These variables do not reset an existing account.

The server also exposes `/docs`, `/openapi.yaml`, `/test/booth` and `/test/status`. The device test pages simulate capture and print confirmation, not physical hardware.

## Admin journey

1. Sign in and select the business.
2. Register a booth at a site and save its device credential securely.
3. Create a frame entry. Artwork upload remains a later milestone.
4. Publish assigned frames, price, timers, retakes and requested camera settings. Published versions and booth-acknowledged versions are shown separately.
5. Issue a single-use online voucher and save its code. List responses omit voucher codes and device credentials.
6. Change your password through Account, or sign out. Password changes revoke all sessions.

The implemented role is platform superadmin, intentionally authorized across businesses. Tenant-restricted staff, invitations, MFA, email recovery, artwork upload and Windows hardware adapters remain future milestones. Paid mode remains disabled pending payment gateway integration.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/web` | Responsive admin UI on the API origin |
| `apps/api` | Request handlers, Worker entry and local Node adapter |
| `apps/api/db/migrations` | Application PostgreSQL schema |
| `packages/contracts/openapi.yaml` | Auth, admin and device contract |
| `scripts/smoke-admin-ui.mjs` | Browser journey with disposable local state |
| `docs/AUTHENTICATION.md` | Identity and portability decisions |

## Checks

```bash
npm run typecheck
npm test
npm run smoke
npm run test:web
XDG_CONFIG_HOME=/tmp/papo-wrangler-config npm run build
```

The browser check uses local `/usr/bin/chromium` when available. Otherwise run `npx playwright install chromium`, or set `PAPO_BROWSER_EXECUTABLE`. It verifies the admin journey, real device voucher redemption, process restart, mobile layout, password change and sign-out. All checks are local. Worker builds use `--dry-run`; CI installs Chromium and runs these checks.

## Later database/deployment setup

Cloud resources remain paused. This scaffold is not deployed; its public Worker routes and Cron schedules are disabled. Local development does not use the shared Neon compute.

For a later authorized deployment, provision a dedicated application database/private bucket. Run `npm run migrate -w @photobooth/api` with `NEON_DIRECT_DATABASE_URL` and matching `APP_DATABASE_NAME`. Run `npm run bootstrap -w @photobooth/api` with `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `TENANT_NAME` and `SITE_NAME` supplied securely through the environment. Bootstrap creates the first account/business/site once and refuses to overwrite existing admins. Do not put passwords in command arguments or tracked files.

Migration 003 removes the imported external subject mapping and adds app password/session storage. Imported admins need a password set through `npm run admin:reset -w @photobooth/api`. Do not run these migrations against the paused original database automatically.

Serve UI/API on one HTTPS origin. Supply the API's `DATABASE_URL` and random 32+ character `TOKEN_SIGNING_KEY` securely, configure the private photo bucket and build the web assets. If deploying on Workers, use the Paid CPU allowance and benchmark bcrypt login cost before public release. See the authentication document for remaining release work.
