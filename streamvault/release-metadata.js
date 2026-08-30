import { execFileSync } from 'node:child_process'

function flag(value) {
  return String(value ?? '').toLowerCase() === 'true'
}

export function resolveReleaseCommit({ env = process.env, gitCommit } = {}) {
  const configured = String(env.RELEASE_COMMIT || env.VITE_RELEASE_COMMIT || '').trim()
  if (configured) return configured

  if (gitCommit) return String(gitCommit).trim() || 'unknown'

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function createReleaseMetadata({ env = process.env, commit, builtAt = new Date().toISOString(), gitCommit } = {}) {
  return {
    commit: resolveReleaseCommit({ env, gitCommit: commit ?? gitCommit }),
    builtAt,
    lazyCatalogFrontend: flag(env.VITE_STALKER_LAZY_CATALOG_ENABLED),
    lazyCatalogBackend: flag(env.STALKER_LAZY_CATALOG_ENABLED),
  }
}
