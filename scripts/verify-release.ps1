# Verify release readiness — runs the full test suite locally.
#
# Usage:
#   .\scripts\verify-release.ps1
#
# This script runs:
#   1. Backend tests
#   2. Frontend lint, unit tests, build
#   3. E2E browser tests

$ErrorActionPreference = "Stop"
$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
$DirtyFiles = (& git -C $RepoDir status --porcelain --untracked-files=all | Out-String).Trim()
if (-not [string]::IsNullOrWhiteSpace($DirtyFiles)) {
    throw "Release verification requires a clean Git worktree. Commit or remove these changes before building:`n$DirtyFiles"
}
$ReleaseCommit = (& git -C $RepoDir rev-parse HEAD).Trim()
if ([string]::IsNullOrWhiteSpace($ReleaseCommit)) { throw "Could not determine the release commit." }

# Keep the build self-describing. CI/deployment may override these values, but
# an ordinary local verification should exercise the lazy release path.
$env:RELEASE_COMMIT = $ReleaseCommit
$env:VITE_RELEASE_COMMIT = $ReleaseCommit
if ([string]::IsNullOrWhiteSpace($env:VITE_SECURE_APP_BASE_URL)) { $env:VITE_SECURE_APP_BASE_URL = "https://media.portalheaven.stream/app" }
if ([string]::IsNullOrWhiteSpace($env:VITE_STALKER_LAZY_CATALOG_ENABLED)) { $env:VITE_STALKER_LAZY_CATALOG_ENABLED = "true" }
if ([string]::IsNullOrWhiteSpace($env:STALKER_LAZY_CATALOG_ENABLED)) { $env:STALKER_LAZY_CATALOG_ENABLED = "true" }

function Invoke-Checked {
    param([string]$Description, [scriptblock]$Command)
    Write-Host "`n--- $Description ---" -ForegroundColor Yellow
    Push-Location $PWD
    try {
        & $Command
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            Write-Host "$Description : FAILED (exit code $LASTEXITCODE)" -ForegroundColor Red
            exit $LASTEXITCODE
        }
        Write-Host "$Description : PASSED" -ForegroundColor Green
    } catch {
        Write-Host "$Description : FAILED ($_)" -ForegroundColor Red
        exit 1
    } finally {
        Pop-Location
    }
}

Write-Host "=== Release Verification ===" -ForegroundColor Cyan

# 1. Backend tests
Invoke-Checked "Backend Tests" {
    Set-Location "$PSScriptRoot\..\stalker-proxy"
    npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm test; if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

# 2. Frontend
Invoke-Checked "Frontend Tests" {
    Set-Location "$PSScriptRoot\..\streamvault"
    npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm run lint; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm test; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm run build; if ($LASTEXITCODE) { exit $LASTEXITCODE }

    $metadataPath = Join-Path (Get-Location) "dist\release.json"
    if (-not (Test-Path -LiteralPath $metadataPath)) { throw "Frontend release metadata was not emitted." }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.commit -ne $ReleaseCommit) { throw "Frontend release commit $($metadata.commit) does not match $ReleaseCommit." }
    if (-not $metadata.lazyCatalogFrontend -or -not $metadata.lazyCatalogBackend) { throw "Lazy catalog release flags are not enabled in release metadata." }
    foreach ($page in @("dist\index.html", "dist\app.html")) {
        if (-not (Select-String -LiteralPath $page -Pattern 'name="sv-release"' -Quiet)) { throw "Missing sv-release metadata in $page." }
    }
}

# 3. E2E
Invoke-Checked "E2E Browser Tests" {
    Set-Location "$PSScriptRoot\..\streamvault"
    npx playwright install --with-deps chromium; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm run e2e; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm run e2e:lazy; if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

Write-Host "`n=== All checks passed ===" -ForegroundColor Green
