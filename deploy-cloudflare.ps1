$ErrorActionPreference = "Stop"

Write-Host "Checking DevChat JavaScript..."
npm run check

Write-Host ""
Write-Host "Deploying DevChat to Cloudflare Workers with Static Assets..."
Write-Host "If this is your first time, Wrangler will ask you to log in."
npx wrangler deploy

Write-Host ""
Write-Host "After deploy, bind KV in Cloudflare:"
Write-Host "Workers & Pages > devchat > Settings > Bindings > Add > KV namespace"
Write-Host "Variable name: DEVCHAT_KV"
Write-Host ""
Write-Host "Then redeploy and test:"
Write-Host "https://YOUR-SITE.workers.dev/api?action=health"
