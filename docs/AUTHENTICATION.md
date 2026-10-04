# Application-managed authentication

The user selected application-managed identity on 2026-10-04. This replaces the original Cloudflare Access plan and development admin bearer token.

## Implemented

- `admin_users` holds the app user ID, unique normalized email, active flag, role and bcrypt password hash. Only `superadmin` is implemented, authorized across businesses. Bootstrap creates the first account; public signup is unavailable.
- Passwords require 12+ characters and at most 72 UTF-8 bytes, preventing bcrypt truncation. Bcrypt uses random salts and cost 12. Hashes never appear in responses.
- Login creates a random 256-bit opaque session. The database stores its SHA-256 digest, user binding and 12-hour expiry. Each request checks expiry and current account activation. Login replaces the caller's prior session; logout revokes it.
- Production cookies use host-only `__Host-papo_session`, HttpOnly, Secure, SameSite=Lax and Path=/. Insecure cookies are permitted only in explicit local mode on loopback. JavaScript/localStorage never receive session tokens.
- Auth/admin mutations require JSON and an Origin exactly matching the request origin. UI/API share an origin, without credentialed CORS. Returned data is rendered as text rather than HTML.
- Atomic database counters limit login to 10 attempts per normalized email and 100 per trusted client IP in 15 minutes. Missing users receive a generic failure and bcrypt verification. Password changes have a separate per-user verification limit. Limiter keys hash email/IP; expired entries and sessions are cleaned during auth operations.
- Password change atomically updates the hash and revokes every session. Session insertion re-checks active state and the verified hash to avoid reset races.
- Admin provisioning retains its transaction, audit and idempotency guarantees. Booth bearer credentials cannot authorize admin routes.

## Bootstrap and recovery

Local development generates a private ignored `.local/api/admin.json` first-start fixture. The server prints its path, never its password. Account password changes do not rewrite that fixture file. Persistent local database/photos live under `.local/api`; smoke tests use disposable directories.

For an authorized real application database, run `npm run bootstrap -w @photobooth/api` with `NEON_DIRECT_DATABASE_URL`, matching `APP_DATABASE_NAME`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `TENANT_NAME` and `SITE_NAME` supplied securely through the environment.

A trusted database operator can recover an account with `npm run admin:reset -w @photobooth/api`, supplying the matching database variables, email and replacement password. It updates only an existing active account and revokes all sessions transactionally, without printing the password. Automated email recovery is not implemented.

## Portability

The auth core uses Web Request/Response, bcrypt and ordinary PostgreSQL tables/queries. `Db` accepts an injected SQL adapter. The local Node adapter uses PGlite. The Worker adapter uses Neon and passes Cloudflare's trusted client IP; another server can inject PostgreSQL and pass a socket/proxy-verified IP to `handle`. Never trust a forwarded IP without a trusted proxy contract.

Changing platforms preserves user IDs, password hashes, roles and business data. Sessions can persist with the same database and HTTPS hostname; changing hostname requires signing in again. There is no provider JWT issuer/audience dependency. Photo storage remains a separate bucket adapter.

## Before public release

Add MFA, invitations, tenant-restricted staff roles, secure automated recovery, session/audit management and distributed abuse monitoring. Benchmark bcrypt within actual CPU limits and expected login traffic, configure deployment secrets/HTTPS/backups, and validate real database/storage adapters. Local checks and Worker dry-run builds do not establish production readiness.
