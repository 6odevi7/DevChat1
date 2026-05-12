$ErrorActionPreference = "Stop"
$ExpectedBackendVersion = "devchat-email-login-fix-2026-05-12"
$WorkerApi = "https://devchat.jintsu67.workers.dev/api"
$ConfigPath = Join-Path $PSScriptRoot "wrangler.toml"
$WorkerPath = Join-Path $PSScriptRoot "_worker.js"

Write-Host "Checking DevChat JavaScript..."
npm run check
Write-Host "Using config: $ConfigPath"
Write-Host "Using worker: $WorkerPath"
Select-String -Path $WorkerPath -Pattern "BACKEND_VERSION|clearUsers" | ForEach-Object { Write-Host $_.Line }

Write-Host ""
Write-Host "Deploying DevChat to Cloudflare Workers with Static Assets..."
Write-Host "In non-interactive shells, set CLOUDFLARE_API_TOKEN first."
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
  throw "CLOUDFLARE_API_TOKEN is not set in this PowerShell window. Set it first, then rerun this script."
}

$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$deployOutput = & npx wrangler deploy --config $ConfigPath --keep-vars 2>&1
$deployExitCode = $LASTEXITCODE
$ErrorActionPreference = $PreviousErrorActionPreference
$deployOutput | ForEach-Object { Write-Host $_ }
if ($deployExitCode -ne 0) {
  throw @"
Wrangler deploy failed before the Worker was updated.

If the error says '/accounts' failed, the Cloudflare API token is missing access to your account.
Create a Cloudflare API token with these permissions:
- Account > Workers Scripts > Edit
- Account > Workers KV Storage > Edit
- Account > Account Settings > Read
- Zone > Workers Routes > Edit, if Cloudflare asks for zone access

Then run:
`$env:CLOUDFLARE_API_TOKEN="paste-token-here"
.\deploy-cloudflare.ps1
"@
}

Write-Host ""
Write-Host "Testing backend health..."
$health = Invoke-WebRequest -Uri "$WorkerApi?action=health&_=$(Get-Random)" -UseBasicParsing
Write-Host $health.Content
$healthJson = $health.Content | ConvertFrom-Json
if ($healthJson.version -ne $ExpectedBackendVersion) {
  throw "Cloudflare is still serving old Worker code at $WorkerApi. Expected backend version '$ExpectedBackendVersion' but got '$($healthJson.version)'. Read the deploy output above and confirm Wrangler deployed to https://devchat.jintsu67.workers.dev, not another Worker or Pages project."
}

Write-Host ""
Write-Host "Clearing broken/stale DevChat users..."
try {
  $reset = Invoke-WebRequest -Uri "$WorkerApi?action=clearUsers&_=$(Get-Random)" -UseBasicParsing
  Write-Host $reset.Content
} catch {
  Write-Host "clearUsers is not available on the live Worker yet; deleting the KV state key directly..."
  npx wrangler kv key delete "devchat-state" --namespace-id "b8f46354-23cb-4ab2-8574-f47306053c64" --force
  $state = Invoke-WebRequest -Uri "$WorkerApi?action=state&_=$(Get-Random)" -UseBasicParsing
  Write-Host $state.Content
}

$finalState = Invoke-WebRequest -Uri "$WorkerApi?action=state&_=$(Get-Random)" -UseBasicParsing
$finalJson = $finalState.Content | ConvertFrom-Json
if ($finalJson.users.Count -ne 0) {
  throw "DevChat users were not cleared. Current state: $($finalState.Content)"
}

Write-Host ""
Write-Host "Done. Open DevChat in a private window or hard refresh, then sign up again."
