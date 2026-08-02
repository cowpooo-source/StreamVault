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
ERROR_456_THRESHOLD=3
ERROR_502_THRESHOLD=5
ALERT_WEBHOOK_FORMAT=discord
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
~~~

The watchdog writes alerts to the system journal and posts to Discord when configured. It does not restart the service automatically.

The Discord invite URL is not a webhook URL. Treat webhook URLs as secrets and keep them out of Git, logs, screenshots, and issue reports.
