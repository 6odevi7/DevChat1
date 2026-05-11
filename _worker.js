const KV_KEY = "devchat-state";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname === "/api/") {
      return handleApi(request, env);
    }
    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/DevChat.html#Lobby`, 302);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("DevChat backend is online. Static assets are not attached to this Worker.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};

async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const action = url.searchParams.get("action") || "";

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  let body = {};
  if (method === "POST") {
    try { body = await request.json(); } catch (_) {}
  }
  if (!body || typeof body !== "object" || !Object.keys(body).length) {
    const raw = url.searchParams.get("data");
    if (raw) { try { body = JSON.parse(raw); } catch (_) {} }
  }
  if (!body || typeof body !== "object" || !Object.keys(body).length) {
    let b64 = url.searchParams.get("b64");
    if (b64) {
      b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      try { body = JSON.parse(atob(b64)); } catch (_) {}
    }
  }
  if (!body || typeof body !== "object") body = {};

  const KV = env.DEVCHAT_KV;

  if (action === "health" || (method === "GET" && !action)) {
    return json({
      ok: !!KV,
      runtime: "cloudflare-pages-worker",
      kvBound: !!KV,
      hint: KV ? "Backend ready" : "Bind a KV namespace named DEVCHAT_KV in the Pages project settings."
    });
  }

  if (!KV) {
    return json({
      error: "KV not bound",
      hint: "Pages > Settings > Bindings > Add > KV namespace > variable name DEVCHAT_KV"
    }, 500);
  }

  const loadState = async () => {
    const raw = await KV.get(KV_KEY);
    if (!raw) return emptyState();
    try { return Object.assign(emptyState(), JSON.parse(raw)); }
    catch { return emptyState(); }
  };
  const saveState = (state) => KV.put(KV_KEY, JSON.stringify(state));

  switch (action) {
    case "state": {
      return json(await loadState());
    }
    case "signup": {
      const user = body.user;
      if (!user || !user.username || !user.email) return json({ error: "missing fields" }, 400);
      const state = await loadState();
      const exists = state.users.some((u) =>
        (u.username || "").toLowerCase() === user.username.toLowerCase() ||
        (u.email || "").toLowerCase() === user.email.toLowerCase()
      );
      if (exists) return json({ error: "exists" }, 409);
      state.users.push(user);
      await saveState(state);
      return json({ user });
    }
    case "login": {
      const identity = String(body.identity || "").trim().toLowerCase();
      if (!identity) return json({ error: "missing identity" }, 400);
      const state = await loadState();
      const found = state.users.find((u) =>
        (u.username || "").toLowerCase() === identity ||
        (u.email || "").toLowerCase() === identity
      );
      if (!found) return json({ error: "not found" }, 404);
      return json({ user: found });
    }
    case "post": {
      const post = body.post;
      if (!post || !post.id) return json({ error: "missing post" }, 400);
      const state = await loadState();
      state.posts.unshift(post);
      state.posts = state.posts.slice(0, 500);
      await saveState(state);
      return json({ post });
    }
    case "message": {
      const message = body.message;
      if (!message || !message.id) return json({ error: "missing message" }, 400);
      const state = await loadState();
      state.messages.push(message);
      state.messages = state.messages.slice(-300);
      await saveState(state);
      return json({ message });
    }
    case "seed": {
      const seed = body.state;
      if (!seed) return json({ error: "missing state" }, 400);
      const state = await loadState();
      if (state.seeded) return json({ ok: false, state });
      const merged = Object.assign(emptyState(), state, seed, { seeded: true });
      await saveState(merged);
      return json({ ok: true, state: merged });
    }
    default:
      return json({ error: "unknown action" }, 400);
  }
}

function emptyState() {
  return { users: [], posts: [], messages: [], seeded: false };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
    },
  });
}
