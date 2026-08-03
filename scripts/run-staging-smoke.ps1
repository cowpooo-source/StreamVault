# Run the staging deployment smoke suite.
#
# Usage:
#   .\scripts\run-staging-smoke.ps1
#
# Environment variables:
#   E2E_BASE_URL   - HTTPS app URL (default: https://media.portalheaven.stream)
#   E2E_CONTENT_URL - HTTP content URL (default: http://40.233.113.76)

$ErrorActionPreference = "Stop"

$env:E2E_BASE_URL = if ($env:E2E_BASE_URL) { $env:E2E_BASE_URL } else { "https://media.portalheaven.stream" }
$env:E2E_CONTENT_URL = if ($env:E2E_CONTENT_URL) { $env:E2E_CONTENT_URL } else { "http://40.233.113.76" }

Write-Host "Running staging smoke suite..."
Write-Host "  E2E_BASE_URL=$env:E2E_BASE_URL"
Write-Host "  E2E_CONTENT_URL=$env:E2E_CONTENT_URL"

Push-Location "$PSScriptRoot\..\streamvault"
try {
    npx playwright test --config playwright.staging.config.js
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Playwright staging smoke suite failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    Write-Host "Staging smoke suite passed."
} finally {
    Pop-Location
}
