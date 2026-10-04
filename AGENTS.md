# PAPO application working rules

- This repository owns application development. `../papo-load-test` owns the synthetic harness and historical design/capacity evidence.
- Admin identity is fully application-managed. Preserve password login, database-backed revocable sessions and application authorization. Do not introduce Cloudflare Access or an external identity requirement.
- The platform superadmin manages all businesses. Any later staff role must enforce tenant scope server-side; UI filtering is not authorization. Keep human identities separate from device credentials.
- Use existing checkouts. Do not create Git worktrees unless requested.
- Shared cloud infrastructure is paused until the user explicitly requests a restart. Local development is authorized. Do not run live probes/queries, seed cloud databases, activate routes or enable Cron as routine checks.
- Read README.md and docs/AUTHENTICATION.md before changes. Keep application migrations separate from synthetic load-test SQL.
- Never track or log passwords, session tokens, booth credentials, voucher codes, private photos or local credential files. Preserve existing user data and changes.
- Preserve atomic voucher redemption, immutable configuration versions, audit events and idempotent request IDs.
- Run relevant tests/typecheck. Auth/admin changes require the browser journey and backend checks. Local tests do not establish provider capacity, payment or hardware readiness.
