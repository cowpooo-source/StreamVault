# Documentation index

## Active documentation

- Production release and migration runbook: production-release.md
- Manual release checklist: testing/manual-release-checklist.md
- Frontend and E2E guide: ../streamvault/README.md
- Backend and API guide: ../stalker-proxy/README.md
- Non-production monitoring: ../stalker-proxy/ops/README.md

## Documentation policy

The active runbook and component READMEs describe the current direct-play deployment. Dated documents under superpowers/plans/ and superpowers/specs/ are retained as design history. They may mention retired hosts, prototype branches, or earlier deployment paths and must not be used as production commands without review.

When deployment behavior changes, update the active runbook, environment examples, Nginx template, and manual checklist in the same change. Keep secrets, real provider credentials, live tokens, and webhook URLs out of all documentation.
