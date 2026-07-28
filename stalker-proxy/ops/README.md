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
ALERT_WEBHOOK_URL=https://example.invalid/webhook
```

The watchdog never restarts the service. It writes alerts to the system journal
under `streamvault-feature-monitor` and posts the same message when a webhook is
configured.
