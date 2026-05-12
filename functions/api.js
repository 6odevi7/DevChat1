// DevChat backend for Cloudflare Pages.
// Same surface as api.php but runs as a Pages Function and stores state in KV.
// Bind a KV namespace named DEVCHAT_KV in the Pages project settings.

const KV_KEY = "devchat-state";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const action = url.searchParams.get("action") || "";

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Parse body from POST JSON, ?data=<json>, or ?b64=<base64 json>.
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

  const KV = env.DEVCHAT_KV || env.devchat || env.DEVCHAT || env.KV;

  // Health check / GET to /api with no action.
  if (action === "health" || (method === "GET" && !action)) {
    return json({
      ok: !!KV,
      runtime: "cloudflare-pages-functions",
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
      return json(publicState(await loadState()));
    }
    case "signup": {
      const user = body.user;
      if (!user || !user.username || !user.email) return json({ error: "missing fields" }, 400);
      if (!isValidEmail(user.email)) return json({ error: "invalid email" }, 400);
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      const exists = state.users.some((u) =>
        (u.username || "").toLowerCase() === user.username.toLowerCase() ||
        (u.email || "").toLowerCase() === user.email.toLowerCase()
      );
      if (exists) return json({ error: "exists" }, 409);
      state.users.push(normalizeUser(user));
      await saveState(state);
      return json({ user: publicUser(user) });
    }
    case "login": {
      const identity = String(body.identity || body.email || "").trim().toLowerCase();
      if (!identity) return json({ error: "missing email" }, 400);
      if (!isValidEmail(identity)) return json({ error: "email required" }, 400);
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      const found = state.users.find((u) =>
        (u.email || "").toLowerCase() === identity
      );
      if (!found) return json({ error: "not found" }, 404);
      return json({ user: publicUser(found) });
    }
    case "post": {
      const post = body.post;
      if (!post || !post.id) return json({ error: "missing post" }, 400);
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      state.posts.unshift(post);
      state.posts = state.posts.slice(0, 500);
      await saveState(state);
      return json({ post });
    }
    case "message": {
      const state = await loadState();
      const message = sanitizeMessage(body.message, state);
      if (!message || !message.id) return json({ error: "missing message" }, 400);
      state.messages.push(message);
      state.messages = state.messages.slice(-300);
      await saveState(state);
      return json({ message });
    }
    case "clearMessages": {
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      state.messages = [];
      await saveState(state);
      return json({ ok: true, cleared: "messages" });
    }
    case "repairMessages": {
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      state.messages = Array.isArray(state.messages)
        ? state.messages.map((message) => sanitizeMessage(message, state)).filter(Boolean)
        : [];
      await saveState(state);
      return json({ ok: true, messages: state.messages.length });
    }
    case "seed": {
      const seed = body.state;
      if (!seed) return json({ error: "missing state" }, 400);
      const state = await loadState();
      if (state.seeded) return json({ ok: false, state: publicState(state) });
      const merged = Object.assign(emptyState(), state, seed, { seeded: true });
      await saveState(merged);
      return json({ ok: true, state: publicState(merged) });
    }
    default:
      return json({ error: "unknown action" }, 400);
  }
}

function emptyState() {
  return { users: [], posts: [], messages: [], seeded: false };
}

function publicState(state) {
  return {
    ...state,
    users: Array.isArray(state.users) ? state.users.map(publicUser).filter(Boolean) : [],
    messages: Array.isArray(state.messages) ? state.messages.map((message) => sanitizeMessage(message, state)).filter(Boolean) : []
  };
}

function publicUser(user) {
  if (!user || typeof user !== "object") return null;
  const { email, phone, ...safe } = normalizeUser(user);
  return safe;
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") return user;
  const clean = { ...user };
  clean.username = safeUserName(clean);
  delete clean.email;
  return clean;
}

function sanitizeMessage(message, state = emptyState()) {
  if (!message || typeof message !== "object") return null;
  const clean = { ...message };
  clean.username = safeDisplayName(clean, state);
  delete clean.email;
  return clean;
}

function safeDisplayName(source, state = emptyState()) {
  const byId = source && source.userId && Array.isArray(state.users)
    ? state.users.find((user) => user.id === source.userId)
    : null;
  const raw = String(source && source.username && source.username !== "DevChat" ? source.username : byId && byId.username || source && (source.realName || source.phoneId) || "DevChat").trim();
  if (!raw || raw.includes("@")) return "DevChat";
  return raw;
}

function safeUserName(user) {
  const raw = String(user && user.username || "").trim();
  if (raw && !raw.includes("@") && raw !== "DevChat") return raw;
  const fallback = String(user && (user.realName || user.phoneId) || "DevChat").trim();
  return fallback && !fallback.includes("@") ? fallback : "DevChat";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
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
