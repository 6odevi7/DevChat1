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
      const target = new Request(new URL("/DevChat.html", url), request);
      const response = env.ASSETS ? await env.ASSETS.fetch(target) : null;
      if (response && response.status !== 404) return response;
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

  const KV = env.DEVCHAT_KV || env.devchat || env.DEVCHAT || env.KV;

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
      return json(publicState(await loadState()));
    }
    case "signup": {
      const user = body.user;
      if (!user || !user.username || !user.email) return json({ error: "missing fields" }, 400);
      if (!isValidEmail(user.email)) return json({ error: "invalid email" }, 400);
      user.handle = user.handle || user.username;
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
    case "pmSend": {
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      const message = sanitizeMessage(body.message, state);
      const toUserId = String(body.message && body.message.toUserId || "").trim();
      if (!message || !message.userId || !toUserId || message.userId === toUserId) return json({ error: "missing pm fields" }, 400);
      message.toUserId = toUserId;
      message.threadId = pmThreadId(message.userId, toUserId);
      state.privateMessages = Array.isArray(state.privateMessages) ? state.privateMessages : [];
      state.privateMessages.push(message);
      state.privateMessages = state.privateMessages.slice(-1000);
      await saveState(state);
      return json({ message });
    }
    case "pmThread": {
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      const userId = String(body.userId || "").trim();
      const peerId = String(body.peerId || "").trim();
      if (!userId || !peerId) return json({ error: "missing pm thread" }, 400);
      const threadId = pmThreadId(userId, peerId);
      const messages = (Array.isArray(state.privateMessages) ? state.privateMessages : [])
        .filter((message) => message.threadId === threadId)
        .map((message) => sanitizeMessage(message, state))
        .filter(Boolean)
        .slice(-100);
      return json({ threadId, messages });
    }
    case "clearMessages": {
      if (!isAdminRequest(url, env)) return json({ error: "unauthorized" }, 401);
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      state.messages = [];
      await saveState(state);
      return json({ ok: true, cleared: "messages" });
    }
    case "repairMessages": {
      if (!isAdminRequest(url, env)) return json({ error: "unauthorized" }, 401);
      const state = await loadState();
      state.users = state.users.map(normalizeUser);
      state.messages = Array.isArray(state.messages)
        ? state.messages.map((message) => sanitizeMessage(message, state)).filter(Boolean)
        : [];
      await saveState(state);
      return json({ ok: true, messages: state.messages.length });
    }
    case "setHandle": {
      if (!isAdminRequest(url, env)) return json({ error: "unauthorized" }, 401);
      const email = String(url.searchParams.get("email") || body.email || "").trim().toLowerCase();
      const handle = String(url.searchParams.get("handle") || body.handle || "").trim();
      if (!isValidEmail(email) || !handle || handle.includes("@")) return json({ error: "invalid handle update" }, 400);
      const state = await loadState();
      const user = state.users.find((item) => String(item.email || "").trim().toLowerCase() === email);
      if (!user) return json({ error: "not found" }, 404);
      user.handle = handle;
      user.username = handle;
      state.users = state.users.map(normalizeUser);
      state.messages = Array.isArray(state.messages)
        ? state.messages.map((message) => sanitizeMessage(message, state)).filter(Boolean)
        : [];
      await saveState(state);
      return json({ ok: true, user: publicUser(user) });
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
  return { users: [], posts: [], messages: [], privateMessages: [], seeded: false };
}

function publicState(state) {
  return {
    seeded: !!state.seeded,
    users: Array.isArray(state.users) ? state.users.map(publicUser).filter(Boolean) : [],
    posts: Array.isArray(state.posts) ? state.posts : [],
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
  if (!clean.handle && clean.username && !String(clean.username).includes("@")) clean.handle = clean.username;
  clean.username = safeUserName(clean);
  clean.handle = clean.username;
  clean.profileUrl = `?profile=${encodeURIComponent(clean.username)}`;
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
  const raw = String(user && (user.handle || user.username) || "").trim();
  if (raw && !raw.includes("@") && raw !== "DevChat") return raw;
  const fallback = String(user && (user.realName || user.phoneId) || "DevChat").trim();
  return fallback && !fallback.includes("@") ? fallback : "DevChat";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function pmThreadId(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function isAdminRequest(url, env) {
  const configured = env.DEVCHAT_ADMIN_TOKEN;
  if (!configured) return true;
  return url.searchParams.get("token") === configured;
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
