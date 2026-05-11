# DevChat Dynamic Hosting

DevChat needs a running backend for shared accounts, login, posts, and messages.
If `api.php` opens as PHP source code in the browser, PHP is not executing on
that host. Login will not work until the backend is fixed.

## Fast Checks

Open these URLs on the live site:

```text
DevChat.html
api.php?action=health
api?action=health
```

A working PHP backend returns JSON like:

```json
{
  "ok": true,
  "php": "8.x",
  "writable": true
}
```

A working Cloudflare backend returns JSON like:

```json
{
  "ok": true,
  "runtime": "cloudflare-pages-functions",
  "kvBound": true
}
```

## If You See PHP Source Text

If the response begins with `<?php` or says `DevChat persistent backend`, the
server is exposing the backend file instead of running PHP.

Fix options:

1. Enable PHP/FastCGI for the folder that contains `api.php`.
2. Move the site to a PHP-capable hosting folder such as `public_html`.
3. Ask the host to map `.php` files to PHP 8.x.
4. Use Cloudflare Pages Functions instead of PHP, then bind KV as `DEVCHAT_KV`.

For security, do not leave `api.php` publicly exposed as source code on a live
site.

## If You See nginx 404

The backend route does not exist where the app is looking.

Fix options:

1. Upload `api.php` beside `DevChat.html`.
2. If using Cloudflare Pages, deploy with Wrangler or Git integration so
   `_worker.js` can serve `/api`, then bind KV.
3. If your backend lives somewhere else, set `apiUrl` in `DevChat.html`:

```html
<script>
  window.DEVCHAT_CONFIG = {
    apiUrl: "https://example.com/path/to/api.php"
  };
</script>
```

## If The App Says No Backend Detected

The front end loaded, but neither `/api` nor `api.php` is running.

Cloudflare Pages dashboard Direct Upload will not run DevChat's backend
Function. Use Wrangler CLI or Git integration instead.

For Wrangler/Git deploys, the project root must include:

```text
DevChat.html
app.js
_worker.js
_routes.json
_headers
package.json
wrangler.toml
```

Then create/bind KV:

```text
Settings > Bindings > Add > KV namespace
Variable name: DEVCHAT_KV
```

After redeploy, this URL must return JSON:

```text
https://your-site.com/api?action=health
```

If that URL returns 404, `_worker.js` was not deployed by Cloudflare Pages. If
it returns JSON with `"kvBound": false`, the Worker deployed but KV is not bound.

## Dynamic Data Storage

PHP hosting stores shared state in:

```text
data/state.json
```

Cloudflare Pages stores shared state in KV under:

```text
devchat-state
```
