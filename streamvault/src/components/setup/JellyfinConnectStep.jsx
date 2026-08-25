import React, { useState } from 'react';
import { JellyfinAdapter } from '../../adapters/jellyfin-adapter.js';

export function JellyfinConnectStep({ onConnected }) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const { accessToken, userId } = await JellyfinAdapter.authenticate(serverUrl, username, password);
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'jellyfin', baseUrl: serverUrl, accessToken, userId })
      });

      if (!res.ok) {
        let message = 'Failed to save server';
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
          else if (data?.message) message = data.message;
        } catch {
          // Response was not JSON, use generic message
        }
        throw new Error(message);
      }

      onConnected();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="jellyfin-connect">
      <input placeholder="https://jellyfin.example.com" value={serverUrl} onChange={e => setServerUrl(e.target.value)} />
      <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <button onClick={handleConnect} disabled={loading}>{loading ? 'Connecting...' : 'Connect'}</button>
    </div>
  );
}
