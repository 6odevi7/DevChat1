$ErrorActionPreference = "Stop"

Write-Host "Checking DevChat JavaScript..."
npm run check

Write-Host ""
Write-Host "Deploying DevChat to Cloudflare Workers with Static Assets..."
Write-Host "In non-interactive shells, set CLOUDFLARE_API_TOKEN first."
npx wrangler deploy

Write-Host ""
Write-Host "Testing backend health..."
$health = Invoke-WebRequest -Uri "https://devchat.jintsu67.workers.dev/api?action=health" -UseBasicParsing
Write-Host $health.Content

Write-Host ""
Write-Host "Clearing broken/stale DevChat users..."
try {
  $reset = Invoke-WebRequest -Uri "https://devchat.jintsu67.workers.dev/api?action=clearUsers" -UseBasicParsing
  Write-Host $reset.Content
} catch {
  Write-Host "clearUsers is not available on the live Worker yet; deleting the KV state key directly..."
  npx wrangler kv key delete "devchat-state" --namespace-id "b8f46354-23cb-4ab2-8574-f47306053c64" --force
  $state = Invoke-WebRequest -Uri "https://devchat.jintsu67.workers.dev/api?action=state" -UseBasicParsing
  Write-Host $state.Content
}

Write-Host ""
Write-Host "Done. Open DevChat in a private window or hard refresh, then sign up again."
