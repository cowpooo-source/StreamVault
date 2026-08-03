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
}

# 3. E2E
Invoke-Checked "E2E Browser Tests" {
    Set-Location "$PSScriptRoot\..\streamvault"
    npx playwright install --with-deps chromium; if ($LASTEXITCODE) { exit $LASTEXITCODE }
    npm run e2e; if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

Write-Host "`n=== All checks passed ===" -ForegroundColor Green
