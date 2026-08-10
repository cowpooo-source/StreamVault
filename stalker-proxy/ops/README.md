# Non-production operations

These files are scoped to the feature environment and currently target stalker-proxy-play in /home/opc/StreamVault-Feature. They must not be copied unchanged to media production or the legacy service.

Install the feature-only log rotation and watchdog:

~~~bash
sudo cp ops/logrotate-streamvault-feature.conf /etc/logrotate.d/streamvault-feature
sudo cp ops/streamvault-feature-monitor.service /etc/systemd/system/
sudo cp ops/streamvault-feature-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamvault-feature-monitor.timer
~~~

Optional values belong in ops/monitor.env:

~~~bash
CPU_THRESHOLD=85
CPU_CONSECUTIVE=3
ALERT_COOLDOWN_SECONDS=900
ERROR_401_THRESHOLD=5
ERROR_403_THRESHOLD=5
ERROR_429_THRESHOLD=3
ERROR_456_THRESHOLD=3
ERROR_502_THRESHOLD=5
ERROR_504_THRESHOLD=5
CATALOG_REQUEST_THRESHOLD=30
CATALOG_ERROR_THRESHOLD=5
ALERT_WEBHOOK_FORMAT=discord
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
~~~

The watchdog writes alerts to the system journal and posts to Discord when configured. It alerts on repeated authorization failures (403), rate limits (429), provider 456/502/504 failures, catalog error bursts, sustained CPU, failed health checks, and kernel TCP out-of-memory messages. Alerts are deduplicated by `ALERT_COOLDOWN_SECONDS`. It does not restart the service automatically.

The application health response includes route-specific status counters. A catalog alert requires both a request-volume threshold and an error threshold, preventing a single bad catalog request from paging the operator.

For media production, install the separate `streamvault-httpstatic-monitor.service` and `.timer`. Store its environment file at `/etc/streamvault/httpstatic-monitor.env` so SELinux allows systemd to read it. It must contain `APP_NAME=stalker-proxy-httpstatic`, `HEALTH_URL=http://127.0.0.1:3301/health`, a unique `STATE_DIR`, and the Discord webhook. Store the non-production environment at `/etc/streamvault/feature-monitor.env`; keep that monitor pointed at `stalker-proxy-play` on port `3201`.

The Discord invite URL is not a webhook URL. Treat webhook URLs as secrets and keep them out of Git, logs, screenshots, and issue reports.
