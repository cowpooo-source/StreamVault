import { describe, it, expect, vi } from 'vitest';
import { createStalkerCatalogApi, StalkerCatalogError } from '../src/stalker-catalog-api.js';

const page = { kind: 'vod', category: '1', items: [], page: 1, pageSize: 100, hasMore: false, nextPage: null, total: 0, totalKnown: true, complete: true };

describe('stalker catalog API', () => {
  it('builds authenticated catalog requests and validates pages', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } }));
    const api = createStalkerCatalogApi({ fetcher, enabled: true });
    await expect(api.fetchCatalogPage({ kind: 'vod', category: '1', contentToken: 'token' })).resolves.toEqual(page);
    expect(fetcher.mock.calls[0][0]).toContain('/stalker/catalog/v1/items?');
    expect(fetcher.mock.calls[0][0]).toContain('contentToken=token');
    expect(fetcher.mock.calls[0][0]).not.toContain('refresh=1');
  });

  it('returns structured provider errors without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'busy', code: 'provider_metadata_busy', retryAfterSeconds: 5 }), { status: 429 }));
    const api = createStalkerCatalogApi({ fetcher, enabled: true });
    await expect(api.fetchCategories({ kind: 'live', contentToken: 'token' })).rejects.toMatchObject({ code: 'provider_metadata_busy', status: 429, retryAfterSeconds: 5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed responses and disabled feature use', async () => {
    const malformed = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const api = createStalkerCatalogApi({ fetcher: malformed, enabled: true });
    await expect(api.fetchCatalogPage({ kind: 'vod', category: '1', contentToken: 'token' })).rejects.toBeInstanceOf(StalkerCatalogError);
    const disabled = createStalkerCatalogApi({ fetcher: vi.fn(), enabled: false });
    await expect(disabled.fetchCategories({ kind: 'live', contentToken: 'token' })).rejects.toMatchObject({ code: 'feature_disabled', status: 404 });
  });

  it('aborts the underlying fetch when abortScope is called', async () => {
    let receivedSignal;
    const fetcher = vi.fn((_url, options) => {
      receivedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const api = createStalkerCatalogApi({ fetcher, enabled: true });
    const pending = api.fetchCategories({ kind: 'live', contentToken: 'token' });
    await new Promise(resolve => setTimeout(resolve, 0));

    api.abortScope();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
