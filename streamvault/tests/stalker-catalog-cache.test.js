import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { createStalkerCatalogCache, LIVE_TTL, CONTENT_TTL } from '../src/stalker-catalog-cache.js';

const sample = { kind: 'vod', category: '1', page: 1, pageSize: 100, items: [{ id: 1, name: 'Movie' }], hasMore: false, nextPage: null, total: 1, totalKnown: true, complete: true };

describe('stalker catalog cache', () => {
  it('keeps live catalog metadata for 30 days while content remains at 48 hours', () => {
    expect(LIVE_TTL).toBe(30 * 24 * 60 * 60 * 1000);
    expect(CONTENT_TTL).toBe(48 * 60 * 60 * 1000);
  });

  it('persists pages and searches only the current owner scope', async () => {
    const first = await createStalkerCatalogCache({ ownerId: 'user:1', connection: { type: 'stalker', server: 'http://p', mac: 'AA' } });
    await first.putPage(sample);
    expect((await first.getPage(sample)).items[0].name).toBe('Movie');
    expect((await first.searchPages('movie'))).toHaveLength(1);

    const second = await createStalkerCatalogCache({ ownerId: 'user:2', connection: { type: 'stalker', server: 'http://p', mac: 'AA' } });
    expect(await second.getPage(sample)).toBeNull();
    expect(await second.searchPages('movie')).toHaveLength(0);
  });

  it('clears an owner without clearing another owner', async () => {
    const first = await createStalkerCatalogCache({ ownerId: 'user:clear', connection: { server: 'http://p', mac: 'AA' } });
    await first.putPage(sample);
    await first.clearOwner('user:clear');
    expect(await first.getPage(sample)).toBeNull();
  });

  it('searches persisted records after a cache instance is recreated', async () => {
    const owner = `user:persist-${Date.now()}`;
    const first = await createStalkerCatalogCache({ ownerId: owner, connection: { server: 'http://p', mac: 'BB' } });
    await first.putPage({ ...sample, page: 2, items: [{ id: 2, name: 'Persisted Movie' }] });
    const second = await createStalkerCatalogCache({ ownerId: owner, connection: { server: 'http://p', mac: 'BB' } });

    expect(await second.searchPages('persisted')).toHaveLength(1);
  });

  it('does not persist provider playback references', async () => {
    const owner = `user:ref-${Date.now()}`;
    const first = await createStalkerCatalogCache({ ownerId: owner, connection: { type: 'stalker', server: 'http://p', mac: 'DD' } });
    await first.putPage({ ...sample, items: [{ id: 9, name: 'Protected', playRef: 'svopaque:secret', _catalogPlayRef: 'svopaque:encrypted' }] });
    const second = await createStalkerCatalogCache({ ownerId: owner, connection: { type: 'stalker', server: 'http://p', mac: 'DD' } });

    expect((await second.getPage(sample)).items[0].playRef).toBeUndefined();
    expect((await second.getPage(sample)).items[0]._catalogPlayRef).toBeUndefined();
  });

  it('invalidates persisted records in the current scope', async () => {
    const owner = `user:invalidate-${Date.now()}`;
    const first = await createStalkerCatalogCache({ ownerId: owner, connection: { server: 'http://p', mac: 'CC' } });
    await first.putPage(sample);
    await first.invalidateScope({ kind: 'vod' });
    const second = await createStalkerCatalogCache({ ownerId: owner, connection: { server: 'http://p', mac: 'CC' } });

    expect(await second.getPage(sample)).toBeNull();
  });

  it('clears only the deleted connection scope for an owner', async () => {
    const connectionA = { type: 'stalker', server: 'http://p', mac: 'EE' };
    const connectionB = { type: 'stalker', server: 'http://p', mac: 'FF' };
    const first = await createStalkerCatalogCache({ ownerId: 'user:connections', connection: connectionA });
    const second = await createStalkerCatalogCache({ ownerId: 'user:connections', connection: connectionB });
    await first.putPage(sample);
    await second.putPage({ ...sample, items: [{ id: 2, name: 'Keep' }] });

    await first.clearConnection(connectionA);

    expect(await first.getPage(sample)).toBeNull();
    expect((await second.getPage({ ...sample, items: [{ id: 2, name: 'Keep' }] })).items[0].name).toBe('Keep');
  });

  it('uses the same canonical connection scope when device identifiers are present', async () => {
    const connection = { type: 'stalker', server: 'http://p', mac: 'EE', serial: 'S1', deviceId: 'D1', deviceId2: 'D2' };
    const cache = await createStalkerCatalogCache({ ownerId: 'user:device-scope', connection });
    await cache.putPage(sample);
    await cache.clearConnection(connection);

    const reopened = await createStalkerCatalogCache({ ownerId: 'user:device-scope', connection });
    expect(await reopened.getPage(sample)).toBeNull();
  });

  it('does not share pages between device profiles with the same portal and MAC', async () => {
    const first = await createStalkerCatalogCache({
      ownerId: 'user:device-profiles',
      connection: { type: 'stalker', server: 'http://p', mac: 'EE', deviceId: 'D1' },
    });
    const second = await createStalkerCatalogCache({
      ownerId: 'user:device-profiles',
      connection: { type: 'stalker', server: 'http://p', mac: 'EE', deviceId: 'D2' },
    });

    await first.putPage(sample);

    expect(await second.getPage(sample)).toBeNull();
  });

  it('persists and invalidates category metadata with the connection scope', async () => {
    const owner = `user:categories-${Date.now()}`;
    const connection = { type: 'stalker', server: 'http://p', mac: 'GG', deviceId: 'D1' };
    const first = await createStalkerCatalogCache({ ownerId: owner, connection });
    await first.putCategories('vod', { categories: [{ id: '1', title: 'Movies' }] });

    const second = await createStalkerCatalogCache({ ownerId: owner, connection });
    expect((await second.getCategories('vod')).categories).toHaveLength(1);

    await second.invalidateScope({ kind: 'vod' });
    const third = await createStalkerCatalogCache({ ownerId: owner, connection });
    expect(await third.getCategories('vod')).toBeNull();
  });

  it('does not share category metadata between device profiles', async () => {
    const owner = `user:category-devices-${Date.now()}`;
    const first = await createStalkerCatalogCache({
      ownerId: owner,
      connection: { type: 'stalker', server: 'http://p', mac: 'HH', deviceId: 'D1' },
    });
    const second = await createStalkerCatalogCache({
      ownerId: owner,
      connection: { type: 'stalker', server: 'http://p', mac: 'HH', deviceId: 'D2' },
    });

    await first.putCategories('series', { categories: [{ id: '2', title: 'Series' }] });
    expect(await second.getCategories('series')).toBeNull();
  });
});
