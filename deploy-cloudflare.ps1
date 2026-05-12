param(
  [switch]$ResetDevChatState
)

$ErrorActionPreference = "Stop"
$ExpectedBackendVersion = "devchat-email-login-fix-2026-05-12"
$WorkerApi = "https://devchat.jintsu67.workers.dev/api"
$ConfigPath = Join-Path $PSScriptRoot "wrangler.toml"
$WorkerPath = Join-Path $PSScriptRoot "_worker.js"
$DeployLogPath = Join-Path $PSScriptRoot "wrangler-deploy-last.log"
$WranglerConfigHome = Join-Path $PSScriptRoot ".wrangler-config"
$WranglerCmd = Join-Path $PSScriptRoot "node_modules\.bin\wrangler.cmd"
$KvNamespaceId = "700ef8ab3c9a47d9ac3a99629995d899"

Write-Host "Checking DevChat JavaScript..."
npm run check
Write-Host "Using config: $ConfigPath"
Write-Host "Using worker: $WorkerPath"
Write-Host "Using Wrangler: $WranglerCmd"
Select-String -Path $WorkerPath -Pattern "BACKEND_VERSION|clearUsers" | ForEach-Object { Write-Host $_.Line }
if (!(Test-Path $WranglerCmd)) {
  throw "Local Wrangler was not found at $WranglerCmd. Run npm install first, then rerun this script."
}

Write-Host ""
Write-Host "Deploying DevChat to Cloudflare Workers with Static Assets..."
Write-Host "In non-interactive shells, set CLOUDFLARE_API_TOKEN first."
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
  throw "CLOUDFLARE_API_TOKEN is not set in this PowerShell window. Set it first, then rerun this script."
}
New-Item -ItemType Directory -Force -Path $WranglerConfigHome | Out-Null
$env:XDG_CONFIG_HOME = $WranglerConfigHome

$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$deployOutput = & $WranglerCmd deploy --config $ConfigPath --keep-vars 2>&1
$deployExitCode = $LASTEXITCODE
$ErrorActionPreference = $PreviousErrorActionPreference
$deployOutput | Out-File -FilePath $DeployLogPath -Encoding utf8
$deployOutput | ForEach-Object { Write-Host $_ }
if ($deployExitCode -ne 0) {
  Write-Host ""
  Write-Host "Wrangler exit code: $deployExitCode"
  Write-Host "Full Wrangler deploy output saved to: $DeployLogPath"
  Write-Host "Full Wrangler deploy output:"
  $deployOutput | ForEach-Object { Write-Host $_ }
  throw @"
Wrangler deploy failed before the Worker was updated.

Copy the "Full Wrangler deploy output" lines above and send them here.
"@
}

Write-Host ""
Write-Host "Testing backend health..."
$health = Invoke-WebRequest -Uri "${WorkerApi}?action=health&_=$(Get-Random)" -UseBasicParsing
Write-Host $health.Content
$healthJson = $health.Content | ConvertFrom-Json
if ($healthJson.version -ne $ExpectedBackendVersion) {
  throw "Cloudflare is still serving old Worker code at $WorkerApi. Expected backend version '$ExpectedBackendVersion' but got '$($healthJson.version)'. Read the deploy output above and confirm Wrangler deployed to https://devchat.jintsu67.workers.dev, not another Worker or Pages project."
}

if ($ResetDevChatState) {
  Write-Host ""
  Write-Host "Clearing broken/stale DevChat users..."
  try {
    $reset = Invoke-WebRequest -Uri "${WorkerApi}?action=clearUsers&_=$(Get-Random)" -UseBasicParsing
    Write-Host $reset.Content
  } catch {
    Write-Host "clearUsers is not available on the live Worker yet; deleting the KV state key directly..."
    & $WranglerCmd kv key delete "devchat-state" --namespace-id $KvNamespaceId --force
    $state = Invoke-WebRequest -Uri "${WorkerApi}?action=state&_=$(Get-Random)" -UseBasicParsing
    Write-Host $state.Content
  }

  $finalState = Invoke-WebRequest -Uri "${WorkerApi}?action=state&_=$(Get-Random)" -UseBasicParsing
  $finalJson = $finalState.Content | ConvertFrom-Json
  if ($finalJson.users.Count -ne 0) {
    throw "DevChat users were not cleared. Current state: $($finalState.Content)"
  }
}

Write-Host ""
Write-Host "Done. Open DevChat and hard refresh to load the upgraded files."
