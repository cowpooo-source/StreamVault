import { useState } from 'react';

export function ServerSelector({ onSelect }) {
  return (
    <div className="server-selector">
      <h2>Choose your server</h2>
      <div className="server-types">
        <button onClick={() => onSelect('jellyfin')}>
          <span className="server-icon">🪼</span>
          <span>Jellyfin</span>
        </button>
        <button onClick={() => onSelect('plex')}>
          <span className="server-icon">🧩</span>
          <span>Plex</span>
        </button>
      </div>
    </div>
  );
}