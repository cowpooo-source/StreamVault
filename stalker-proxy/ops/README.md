# Non-production operations

These files target only `stalker-proxy-play` in `/home/opc/StreamVault-Feature`.

Install the scoped log rotation and watchdog timer:

```bash
sudo cp ops/logrotate-streamvault-feature.conf /etc/logrotate.d/streamvault-feature
sudo cp ops/streamvault-feature-monitor.service /etc/systemd/system/
sudo cp ops/streamvault-feature-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now streamvault-feature-monitor.timer
```

Optional settings belong in `ops/monitor.env`:

```bash
CPU_THRESHOLD=85
CPU_CONSECUTIVE=3
ALERT_COOLDOWN_SECONDS=900
ALERT_WEBHOOK_FORMAT=discord
ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
```

The watchdog never restarts the service. It writes alerts to the system journal
under `streamvault-feature-monitor` and posts the same message when a webhook is
configured.

For Discord, create the webhook in the target channel under **Edit Channel**,
**Integrations**, **Webhooks**, and **New Webhook**. The server invite URL is not
the webhook URL and must not be placed in ALERT_WEBHOOK_URL.
