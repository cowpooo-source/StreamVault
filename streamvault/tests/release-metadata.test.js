import { describe, expect, it } from 'vitest'
import { createReleaseMetadata, resolveReleaseCommit } from '../release-metadata.js'

describe('release metadata', () => {
  it('uses the configured commit and exposes both lazy flags', () => {
    expect(createReleaseMetadata({
      env: {
        RELEASE_COMMIT: 'abc1234',
        VITE_STALKER_LAZY_CATALOG_ENABLED: 'true',
        STALKER_LAZY_CATALOG_ENABLED: 'true',
      },
      builtAt: '2026-08-29T00:00:00.000Z',
    })).toEqual({
      commit: 'abc1234',
      builtAt: '2026-08-29T00:00:00.000Z',
      lazyCatalogFrontend: true,
      lazyCatalogBackend: true,
    })
  })

  it('falls back safely when no commit is configured', () => {
    expect(resolveReleaseCommit({ env: {}, gitCommit: 'fallback-commit' })).toBe('fallback-commit')
    expect(createReleaseMetadata({ env: {}, commit: 'unknown' }).lazyCatalogFrontend).toBe(false)
  })

  it('does not infer backend lazy mode from the frontend flag', () => {
    expect(createReleaseMetadata({
      env: { VITE_STALKER_LAZY_CATALOG_ENABLED: 'true' },
      commit: 'abc1234',
    })).toMatchObject({
      lazyCatalogFrontend: true,
      lazyCatalogBackend: false,
    })
  })
})
