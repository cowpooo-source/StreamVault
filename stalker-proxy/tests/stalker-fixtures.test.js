import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixtureDirectory = path.join(__dirname, 'fixtures', 'stalker');
const expectedFixtures = [
  'handshake-standard.json', 'handshake-random.json', 'profile-legacy.json',
  'profile-device-bound.json', 'channels-standard.json', 'channels-internal-id.json',
  'create-link-cmd.json', 'create-link-url.json', 'create-link-id-token.json',
  'create-link-live-token.json', 'create-link-localhost.json', 'create-link-ffrt.json',
  'vod-movie-standard.json', 'vod-numeric-catalog.json', 'series-array.json',
  'series-episode-records.json', 'redirect-hls.json',
];

describe('sanitized Stalker fixtures', () => {
  it('contains every documented response family without production hosts', () => {
    for (const name of expectedFixtures) {
      const text = fs.readFileSync(path.join(fixtureDirectory, name), 'utf8');
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).not.toMatch(/portalheaven|1234\.uno|mi20\.cc|mdmfista|00:1A:79:73:99:7D/i);
    }
  });
});
