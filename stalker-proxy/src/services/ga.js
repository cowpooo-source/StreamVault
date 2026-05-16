// GA4 Measurement Protocol Service
const fetch = require('node-fetch');
const https = require('https');

const MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID;
const API_SECRET = process.env.GA_API_SECRET;
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;

// Connection pooling for high-frequency events
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: 60000
});

// Ensure we don't send events if disabled or missing config
const isEnabled = () => {
  const active = !!(MEASUREMENT_ID && API_SECRET);
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  return active && !isTest;
};

async function sendGAEvent(eventName, params = {}) {
  if (!isEnabled()) return;

  const payload = {
    // client_id is required. We use a static backend ID to group server events
    // In the future, this could be the VPS hostname to distinguish multi-server setups
    client_id: 'streamvault_backend_service', 
    events: [{
      name: eventName,
      params: {
        ...params,
        server_env: process.env.NODE_ENV || 'development'
      }
    }]
  };

  try {
    const response = await fetch(GA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      agent: agent
    });
    
    if (!response.ok) {
      console.warn(`GA4 Error: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Failed to send GA4 event:', error.message);
  }
}

function trackServerHeartbeat(metrics) {
  // metrics: cpu_percent, ram_percent, disk_percent
  sendGAEvent('server_heartbeat', {
    cpu_percent: metrics.cpu_percent,
    ram_percent: metrics.ram_percent,
    disk_percent: metrics.disk_percent
  });
}

function trackBandwidth(tx_gb, rx_gb) {
  sendGAEvent('bandwidth_usage', {
    bandwidth_gb: tx_gb + rx_gb,
    tx_gb: tx_gb,
    rx_gb: rx_gb
  });
}

function trackPortalHealth(portal, latency, status) {
  sendGAEvent('portal_health', {
    portal_type: 'upstream_proxy',
    portal_domain: new URL(portal).hostname,
    latency_ms: latency,
    error_code: status >= 400 ? status : undefined,
    status: status >= 400 ? 'error' : 'success'
  });
}

module.exports = {
  sendGAEvent,
  trackServerHeartbeat,
  trackBandwidth,
  trackPortalHealth
};
