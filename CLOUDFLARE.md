# DevChat on Cloudflare Pages

DevChat can run on Cloudflare Pages without PHP. The static files are served by
Pages, and `functions/api.js` provides the `/api` backend with state stored in
Cloudflare KV.

## Deploy

1. Upload or connect this folder as a Cloudflare Pages project.
2. Leave the build command empty unless Cloudflare requires one.
3. Set the build output directory to `/` or the project root.
4. Create a Workers KV namespace for DevChat.
5. Open the Pages project, then go to `Settings > Bindings`.
6. Add a KV namespace binding with variable name `DEVCHAT_KV`.
7. Select the KV namespace you created.
8. Redeploy the Pages project so the binding is available to the Function.

After deploy, visit:

```text
https://your-site.pages.dev/api?action=health
```

The response should include:

```json
{
  "ok": true,
  "runtime": "cloudflare-pages-functions",
  "kvBound": true
}
```

If `kvBound` is false, the site deployed but the KV binding is missing or the
project needs to be redeployed after adding the binding.

## Local test with Wrangler

Install Wrangler and run this from the project folder:

```powershell
npx wrangler pages dev . --kv=DEVCHAT_KV
```

Wrangler serves the site locally, including Pages Functions, usually at:

```text
http://localhost:8788/DevChat.html
```

## Deploy Method

Do not use Cloudflare dashboard drag-and-drop for DevChat. Cloudflare's own
Pages docs say dashboard Direct Upload is not currently supported with
Functions, and DevChat needs a Function for `/api`.

Use one of these instead:

1. Wrangler CLI:

```powershell
npm install
.\deploy-cloudflare.ps1
```

2. Git integration:

Push this folder to GitHub, connect it to Cloudflare Pages, and leave build
command empty with output directory `/`.

This project includes `_worker.js`, which provides the `/api` backend in
Cloudflare Pages advanced mode.

## Cross-platform config

`DevChat.html` defines an optional `window.DEVCHAT_CONFIG` before loading
`app.js`.

Use `apiUrl` only when your backend is not beside `DevChat.html` and not at
Cloudflare `/api`:

```html
<script>
  window.DEVCHAT_CONFIG = {
    apiUrl: "https://example.com/devchat/api.php"
  };
</script>
```

Use `iceServers` if direct WebRTC calls fail on mobile or carrier networks. STUN
is built in, but reliable global calling often needs a TURN server:

```html
<script>
  window.DEVCHAT_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }
    ]
  };
</script>
```

## Notes

- The browser client tries `api.php` and `api` beside `DevChat.html`, then
  Cloudflare root `/api`.
- Cloudflare Pages will not run `api.php`; keep it only for Hostinger/PHP
  deployments.
- Camera and microphone require HTTPS, except on `localhost`.
