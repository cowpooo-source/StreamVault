# Production release runbook

This runbook covers the planned migration from the current hosted deployment to the direct-play release.

## Target topology

| Component | Branch or service | Database |
| --- | --- | --- |
| Marketing site | portalheaven.stream | None |
| New application | vps/http-static at media.portalheaven.stream | Independent copy of the current production database |
| Temporary legacy application | vps/self-hosted at legacy.portalheaven.stream | Original production database |
| Feature testing | StreamVault-Feature | Non-production database |

The media and legacy databases are separate after the one-time copy. They must never share a SQLite file or write to each other.

## Before merging

1. Confirm the current production database type and path.
2. Record the current production Git commit, PM2 process, port, Nginx configuration, and environment variable names.
3. Confirm that the feature branch has no untracked source required by an import. A tracked frontend import must not depend on an untracked file.
4. Compare feature/direct-play-no-proxy with vps/http-static and merge locally, not on the VPS.
5. Resolve conflicts while preserving direct-first playback, content-session authorization, Stalker security controls, account limits, and service-worker asset behavior.
6. Run backend tests, frontend tests, lint, build, mocked E2E tests, staging smoke tests, and protected provider canaries.
7. Confirm DEFAULT_ROLE=free and verify that client input cannot assign privileged roles.
8. Confirm advertisements are limited to guest/free accounts.
9. Confirm OAuth callbacks, Turnstile hostnames, APP_URL, VITE_SECURE_APP_BASE_URL, CORS, cookies, and HSTS settings for media.

## One-time database copy

1. Announce a short maintenance window and freeze writes to the current production service.
2. For SQLite, checkpoint or stop the service and create a consistent backup with SQLite backup tooling. Preserve the WAL state before copying.
3. For PostgreSQL, create a dump and restore it into a new database. Do not point media and legacy at the same database after the copy.
4. Restore the copy into the media deployment's own persistent data path.
5. Verify users, password hashes, email state, roles, disabled state, limits, OAuth identities, connections, favorites, history, and timestamps.
6. Do not copy active sessions or content-session tokens. Require a fresh login on media.
7. Run integrity checks and test a restore before exposing media publicly.
8. Leave the original database unchanged for legacy operation and rollback reference.

Because the databases become independent, later changes do not synchronize. New media users will not appear on legacy. Disable registration and account mutation on legacy or direct those actions to media.

## Deployment

1. Keep StreamVault-Feature as non-production.
2. Use a dedicated production checkout such as /home/opc/StreamVault-HttpStatic for the merged vps/http-static release.
3. Use a separate checkout, PM2 process, port, environment file, data path, and log path for legacy vps/self-hosted.
4. Provision DNS and valid HTTPS certificates for media.portalheaven.stream and legacy.portalheaven.stream.
5. Configure Nginx so media serves the current frontend and API routes, while provider media remains direct unless an explicit compatibility fallback is used.
6. Do not use the old self-signed play.portalheaven.stream HTTP downgrade configuration for production authentication.
7. Deploy side by side and run health checks before changing public links.

## Legacy notice

The legacy application must display a configurable notice on setup and content screens:

~~~text
Legacy access will be retired soon. Please continue using the new application at https://media.portalheaven.stream/app.
~~~

The notice should include a retirement date, link to media, support dismissal for the current session, and remain periodically visible until retirement. Suggested settings are LEGACY_NOTICE_ENABLED, LEGACY_RETIREMENT_DATE, and LEGACY_TARGET_URL.

## Cutover

1. Lower DNS TTL before the release window.
2. Deploy and test media using canary accounts.
3. Change marketing CTAs on portalheaven.stream to https://media.portalheaven.stream/app.
4. Add a temporary legacy link in media settings and setup.
5. Monitor authentication, content sessions, provider failures, direct playback, CPU, memory, and database errors.
6. Keep legacy online for the agreed transition period, normally 2 to 4 weeks.
7. Export any final legacy data needed before retirement.

## Rollback

Keep the previous media build, original legacy database, Nginx configuration, environment backup, and exact Git commit available. Roll back the application release first. Only restore a database backup after confirming that newer writes cannot be safely read by the previous release.
