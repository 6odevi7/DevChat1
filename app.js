(function () {
  const STORE_KEY = "devchat.static.v1";
  const SESSION_KEY = "devchat.session.v1";
  const SCALEDRONE_CHANNEL = "2xmbUiTsqTzukyf7";
  const LOBBY_HASH = "Lobby";
  const LOBBY_DRONE_ROOM = "observable-devchat-lobby";
  const IS_HTTP = location.protocol === "http:" || location.protocol === "https:";
  const DEVCHAT_CONFIG = window.DEVCHAT_CONFIG || {};
  const REQUIRE_BACKEND = DEVCHAT_CONFIG.requireBackend !== false;
  // Try the backend beside this page first, then Cloudflare Pages /api.
  const API_CANDIDATES = buildApiCandidates();
  let API_URL = API_CANDIDATES[0] || "";

  async function detectApi() {
    if (!API_CANDIDATES.length) {
      lastApiError = "No backend route is configured. DevChat requires /api or api.php.";
      return false;
    }
    const failures = [];
    for (const candidate of API_CANDIDATES) {
      try {
        const res = await fetch(candidate + "?action=health&_=" + Date.now(), { cache: "no-store" });
        const text = await res.text();
        if (!res.ok) {
          failures.push(`${candidate} HTTP ${res.status}`);
          continue;
        }
        try {
          const data = JSON.parse(text);
          const ready = data && (data.ok || data.dataDir || (data.runtime && data.kvBound));
          if (ready) {
            API_URL = candidate;
            lastApiError = "";
            return true;
          }
          failures.push(`${candidate} ${data && data.hint || "backend not ready"}`);
        } catch (_) {
          failures.push(`${candidate} ${nonJsonApiHint(text, res.status)}`);
        }
      } catch (error) {
        failures.push(`${candidate} ${error && error.message || error}`);
      }
    }
    lastApiError = failures.join("; ");
    API_URL = "";
    return false;
  }

  function buildApiCandidates() {
    const params = new URLSearchParams(location.search);
    const override = params.get("api") || DEVCHAT_CONFIG.apiUrl || safeLocalGet("devchat.api.url") || "";
    const urls = [];
    if (override) urls.push(override);
    if (isCloudflareHost()) {
      urls.push(new URL("/api", location.origin).href, "api", "api.php");
    } else {
      urls.push("api.php", "api");
    }
    if (IS_HTTP) {
      urls.push(new URL("/api", location.origin).href);
      urls.push(new URL("/api.php", location.origin).href);
    }
    return Array.from(new Set(urls));
  }

  function pageUrl(query = "", hash = "") {
    if (!IS_HTTP) return `DevChat.html${query}${hash}`;
    return `${location.origin}${location.pathname}${query}${hash}`;
  }

  function isCloudflareHost() {
    return /\.pages\.dev$/i.test(location.hostname) || DEVCHAT_CONFIG.backend === "cloudflare";
  }

  const state = loadLocalState();
  let currentUser = readSession();
  let privateRoomHash = null;        // only set when a private room is active
  let drone = null;
  let lobbySub = null;
  let privateSub = null;
  let privateSubRoom = "";
  let phoneSub = null;          // personal channel based on my phoneId
  let realtimeRetryTimer = null;
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let roomMemberCount = 0;
  let pendingRoomMessages = [];
  let pendingRemoteCandidates = [];
  let makingOffer = false;
  let audioMuted = false;
  let videoMuted = false;
  let apiAvailable = false;
  let callRole = null;          // "caller" or "callee" once a call is active
  let pendingInvite = null;     // {roomHash, fromUser} while modal is open

  const $ = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    // Always start in the global #Lobby unless a private room invite link is
    // opened. Private rooms use DevChat.html#room-<id>.
    const hash = (location.hash || "").replace("#", "");
    if (hash.startsWith("room-")) {
      privateRoomHash = hash.slice(5);
    } else if (hash !== LOBBY_HASH) {
      history.replaceState(null, "", lobbyUrl());
    }
    await detectApi();
    await syncFromServer();
    // Re-resolve the logged-in user against the freshly synced state so that a
    // session created on another device still loads correctly here.
    const sessionId = readSessionId();
    if (sessionId) {
      currentUser = state.users.find((u) => u.id === sessionId) || currentUser;
    }
    if (!apiAvailable) {
      $("lobbyStatus").textContent = "Backend offline: " + (lastApiError || "unknown");
      console.warn("[devchat] backend offline:", lastApiError);
    }
    bindUi();
    renderAll();
    initRealtime();
    appendSystem("Latest chats and posts load for guests. Sign up or login to send messages.");
    window.addEventListener("hashchange", onHashChange);

    // Public profile route: DevChat.html?profile=<username>
    const profileParam = new URLSearchParams(location.search).get("profile");
    if (profileParam) showProfilePage(profileParam);
  }

  function showProfilePage(handle) {
    const lower = String(handle).toLowerCase();
    const user = state.users.find((u) =>
      u.username && u.username.toLowerCase() === lower
    ) || state.users.find((u) =>
      u.id === handle || (u.phoneId && u.phoneId.replace("#", "") === handle.replace("#", ""))
    );
    $("landing").classList.add("is-hidden");
    $("workspace").classList.add("is-hidden");
    $("profilePage").classList.remove("is-hidden");

    if (!user) {
      $("profilePageTitle").textContent = `Profile: ${handle}`;
      $("profileSummary").innerHTML = `<div class="profile-empty">No DevChat profile found for <b>${escapeHtml(handle)}</b>. The user may not have signed up yet, or this profile lives on another DevChat instance.</div>`;
      $("profilePosts").innerHTML = "";
      return;
    }

    const displayName = user.realName || "DevChat member";
    $("profilePageTitle").textContent = `${displayName} · DevChat`;
    document.title = `${displayName} · DevChat`;

    const socials = Array.isArray(user.socials) && user.socials.length
      ? user.socials.map((s) => `<a href="${escapeHtml(s)}" target="_blank" rel="noopener">${escapeHtml(s)}</a>`).join("<br>")
      : `<span class="profile-empty" style="padding:0;">No links yet</span>`;

    const joined = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—";

    // Public profile: real name + phone ID + links + posts.
    // Username and email are intentionally hidden (they double as login credentials).
    $("profileSummary").innerHTML = `
      <h3 class="profile-name">${escapeHtml(displayName)}</h3>
      <p class="profile-handle">${escapeHtml(user.phoneId || "")}</p>
      <div class="stat"><span>Phone ID</span><span>${escapeHtml(user.phoneId || "—")}</span></div>
      <div class="stat"><span>Joined</span><span>${escapeHtml(joined)}</span></div>
      <div class="stat"><span>Links</span><span>${socials}</span></div>
    `;

    const posts = state.posts.filter((p) => p.authorId === user.id);
    $("profilePosts").innerHTML = posts.length ? posts.map((post) => `
      <article class="post">
        <h4>${escapeHtml(post.title)}</h4>
        <p>${escapeHtml(post.description)}</p>
        <div class="meta"><span>${escapeHtml(post.type)}</span><span>${escapeHtml(post.price)}</span></div>
        <div class="meta"><span>${escapeHtml(user.phoneId || "DevChat")}</span><span>${timeAgo(post.createdAt)}</span></div>
      </article>
    `).join("") : `<div class="profile-empty">No posts yet from ${escapeHtml(displayName)}.</div>`;
  }

  function onHashChange() {
    const hash = (location.hash || "").replace("#", "");
    if (hash.startsWith("room-")) {
      privateRoomHash = hash.slice(5);
      subscribePrivateRoom();
    } else {
      privateRoomHash = null;
      teardownPrivateRoom();
      if (hash !== LOBBY_HASH) history.replaceState(null, "", lobbyUrl());
    }
    $("roomUrl").textContent = privateRoomHash ? location.href : lobbyUrl();
    renderCallControls();
    renderMessages();
    renderWidget("room");
  }

  function bindUi() {
    $("enterDevChat").addEventListener("click", enterWorkspace);
    document.querySelectorAll("[data-open-auth]").forEach((button) => {
      button.addEventListener("click", () => openAuth(button.dataset.openAuth));
    });
    document.querySelectorAll("[data-auth-tab]").forEach((button) => {
      button.addEventListener("click", () => switchAuth(button.dataset.authTab));
    });
    $("signupButton").addEventListener("click", signup);
    $("loginButton").addEventListener("click", login);
    $("resetButton").addEventListener("click", resetPassword);
    $("newPostButton").addEventListener("click", () => guardAuthed(() => $("postForm").classList.toggle("is-hidden")));
    $("publishPost").addEventListener("click", publishPost);
    $("sendMessage").addEventListener("click", sendChatMessage);
    $("messageInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") sendChatMessage();
    });
    $("fileUpload").addEventListener("change", handleFileUpload);
    $("copyRoom").addEventListener("click", copyRoom);
    $("callPhone").addEventListener("click", callPhoneId);
    $("startCall").addEventListener("click", () => guardAuthed(toggleCall));
    $("muteAudio").addEventListener("click", toggleAudio);
    $("muteVideo").addEventListener("click", toggleVideo);
    $("remoteVideo").addEventListener("click", enableRemotePlayback);
    $("openWidget").addEventListener("click", openWidget);
    $("widgetLauncher").addEventListener("click", openWidget);
    $("minimizeWidget").addEventListener("click", () => $("chatWidget").classList.add("is-hidden"));
    $("closeWidget").addEventListener("click", () => $("chatWidget").classList.add("is-hidden"));
    document.querySelectorAll("[data-widget-tab]").forEach((button) => {
      button.addEventListener("click", () => renderWidget(button.dataset.widgetTab));
    });
    $("callAccept").addEventListener("click", acceptIncomingCall);
    $("callDecline").addEventListener("click", declineIncomingCall);
  }

  function enterWorkspace() {
    // Entering DevChat always lands in #Lobby unless a private room invite link
    // is already active.
    if (!privateRoomHash) history.replaceState(null, "", lobbyUrl());
    $("landing").classList.add("is-hidden");
    $("workspace").classList.remove("is-hidden");
    renderAll();
  }

  function openAuth(tab) {
    switchAuth(tab);
    $("authNote").textContent = apiAvailable
      ? `Backend connected: ${apiHostLabel(API_URL)}`
      : `Backend offline: ${lastApiError || "checking..."}`;
    $("authModal").showModal();
  }

  function switchAuth(tab) {
    const titles = { signup: "Create Account", login: "Login", reset: "Reset Password" };
    $("authTitle").textContent = titles[tab];
    document.querySelectorAll("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === tab));
    ["signup", "login", "reset"].forEach((name) => $(name + "Pane").classList.toggle("is-hidden", name !== tab));
  }

  async function signup() {
    const username = $("signupUsername").value.trim();
    const realName = $("signupRealName").value.trim();
    const email = $("signupEmail").value.trim();
    const phone = $("signupPhone").value.trim();
    if (!username || !realName || !email || !phone) {
      $("authNote").textContent = "Every sign up field is required.";
      return;
    }
    if (!isValidEmail(email)) {
      $("authNote").textContent = "Enter a valid email address.";
      return;
    }
    $("authNote").textContent = "Creating account…";

    // Always sync from the server first so duplicate checks work across devices.
    await syncFromServer();
    const existing = state.users.find((user) => (user.username || "").toLowerCase() === username.toLowerCase());
    if (existing) {
      $("authNote").textContent = "That username or email already exists.";
      return;
    }
    const newUser = {
      id: cryptoId(),
      username,
      realName,
      email,
      phone,
      phoneId: "#" + String(Math.floor(1000000 + Math.random() * 9000000)),
      profileUrl: pageUrl(`?profile=${encodeURIComponent(username)}`),
      socials: [],
      createdAt: Date.now()
    };
    const saved = await api("signup", { user: newUser });
    if (!saved) {
      $("authNote").textContent = apiErrorMessage();
      return;
    }
    if (saved.error === "exists") {
      $("authNote").textContent = "That username or email already exists on the server.";
      return;
    }
    currentUser = saved.user || newUser;
    if (!state.users.find((u) => u.id === currentUser.id)) state.users.push(currentUser);
    state.currentUser = currentUser.id;
    saveLocalState();
    writeSession(currentUser);
    $("authModal").close();
    renderAll();
    subscribePhoneChannel();
    appendSystem(`Welcome ${currentUser.username}. Your DevChat phone ID is ${currentUser.phoneId}.`);
  }

  async function login() {
    const identity = $("loginUsername").value.trim().toLowerCase();
    if (!isValidEmail(identity)) {
      $("authNote").textContent = "Enter your account email.";
      return;
    }
    $("authNote").textContent = "Looking up account…";

    // Always check the server first — accounts on other devices live only there.
    const remote = await api("login", { identity });
    let user = null;
    if (remote && remote.user) {
      user = remote.user;
      if (!state.users.find((u) => u.id === user.id)) state.users.push(user);
      saveLocalState();
    } else if (remote && remote.error === "not found") {
      $("authNote").textContent = "No DevChat account matched that email.";
      return;
    } else if (!remote) {
      $("authNote").textContent = apiErrorMessage();
      return;
    }
    if (!user) {
      $("authNote").textContent = "No account matched that email.";
      return;
    }
    currentUser = user;
    state.currentUser = user.id;
    saveLocalState();
    writeSession(user);
    $("authModal").close();
    renderAll();
    subscribePhoneChannel();
    appendSystem(`${user.username} logged in.`);
  }

  function resetPassword() {
    const email = $("resetEmail").value.trim();
    $("authNote").textContent = email ? `Reset link generated for ${email}.` : "Enter an email to generate a reset link.";
  }

  function guardAuthed(action) {
    if (!currentUser) {
      openAuth("signup");
      return false;
    }
    action();
    return true;
  }

  function publishPost() {
    guardAuthed(async () => {
      const title = $("postTitle").value.trim();
      const description = $("postDescription").value.trim();
      if (!title || !description) return;
      const post = {
        id: cryptoId(),
        title,
        description,
        type: $("postType").value,
        price: $("postPrice").value.trim() || "Open",
        authorId: currentUser.id,
        createdAt: Date.now()
      };
      state.posts.unshift(post);
      saveLocalState();
      $("postTitle").value = "";
      $("postDescription").value = "";
      $("postPrice").value = "";
      $("postForm").classList.add("is-hidden");
      renderPosts();
      renderWidget("posts");
      await api("post", { post });
    });
  }

  function sendChatMessage() {
    guardAuthed(async () => {
      const input = $("messageInput");
      const text = input.value.trim();
      if (!text) return;
      const message = createChatMessage(text);
      input.value = "";
      if (isPrivateChatActive()) {
        addRoomMessage(message);
        sendRoom({ type: "room-chat", message: { ...message, mine: false } });
      } else {
        addMessage(message);
        publishDrone({ type: "lobby-chat", userId: currentUser.id, username: safeDisplayName(currentUser), text, id: message.id });
        await api("message", { message: { ...message, mine: false } });
      }
    });
  }

  function handleFileUpload(event) {
    guardAuthed(() => {
      const file = event.target.files[0];
      if (!file) return;
      const text = `Uploaded ${file.name} (${formatBytes(file.size)})`;
      const message = { ...createChatMessage(text), fileName: file.name };
      if (isPrivateChatActive()) {
        addRoomMessage(message);
        sendRoom({ type: "room-chat", message: { ...message, mine: false } });
      } else {
        addMessage(message);
      }
      event.target.value = "";
    });
  }

  function addMessage(message) {
    message = sanitizeChatMessage(message);
    state.messages.push(message);
    state.messages = state.messages.slice(-200);
    saveLocalState();
    renderMessages();
    renderWidget("chat");
  }

  function addRoomMessage(message) {
    if (!privateRoomHash) return;
    message = sanitizeChatMessage(message);
    if (!state.roomMessages) state.roomMessages = {};
    const roomMessages = state.roomMessages[privateRoomHash] || [];
    roomMessages.push(message);
    state.roomMessages[privateRoomHash] = roomMessages.slice(-100);
    saveLocalState();
    renderMessages();
    renderWidget("chat");
  }

  function appendSystem(text) {
    const node = document.createElement("div");
    node.className = "system";
    node.textContent = text;
    $("lobbyMessages").appendChild(node);
  }

  function initRealtime() {
    if (!window.ScaleDrone) {
      setTimeout(initRealtime, 250);
      return;
    }
    if (drone) return;
    try {
      drone = new ScaleDrone(SCALEDRONE_CHANNEL);
      drone.on("open", (error) => {
        if (error) {
          $("lobbyStatus").textContent = "Realtime reconnecting";
          scheduleRealtimeReconnect();
          return;
        }
        if (realtimeRetryTimer) {
          clearTimeout(realtimeRetryTimer);
          realtimeRetryTimer = null;
        }
        $("lobbyStatus").textContent = "#Lobby online";
        lobbySub = drone.subscribe(LOBBY_DRONE_ROOM);
        lobbySub.on("data", (message, client) => {
          if (!message || message.type !== "lobby-chat" || (client && client.id === drone.clientId)) return;
          if (message.id && state.messages.some((m) => m.id === message.id)) return;
          addMessage({ id: message.id || cryptoId(), userId: message.userId, username: safeDisplayName(message), text: message.text, createdAt: Date.now() });
        });
        subscribePhoneChannel();
        if (privateRoomHash) subscribePrivateRoom();
      });
      drone.on("close", scheduleRealtimeReconnect);
      drone.on("error", scheduleRealtimeReconnect);
    } catch (error) {
      $("lobbyStatus").textContent = "Realtime reconnecting";
      scheduleRealtimeReconnect();
    }
  }

  function scheduleRealtimeReconnect() {
    if (realtimeRetryTimer) return;
    realtimeRetryTimer = setTimeout(() => {
      realtimeRetryTimer = null;
      try { if (drone && drone.close) drone.close(); } catch (e) {}
      drone = null;
      lobbySub = null;
      phoneSub = null;
      privateSub = null;
      privateSubRoom = "";
      initRealtime();
    }, 2500);
  }

  function phoneRoomName(phoneId) {
    return "observable-devchat-phone-" + String(phoneId || "").replace(/[^0-9]/g, "");
  }

  function subscribePhoneChannel() {
    if (!drone || !currentUser || !currentUser.phoneId) return;
    if (phoneSub) { try { phoneSub.unsubscribe(); } catch (e) {} phoneSub = null; }
    phoneSub = drone.subscribe(phoneRoomName(currentUser.phoneId));
    phoneSub.on("data", (message, client) => {
      if (!message || (client && client.id === drone.clientId)) return;
      handlePhoneSignal(message);
    });
  }

  function handlePhoneSignal(message) {
    if (message.type === "call-invite") {
      pendingInvite = { roomHash: message.roomHash, fromUser: message.from };
      const who = message.from && (message.from.realName || message.from.phoneId) || "Someone";
      $("callModalTitle").textContent = "Incoming call";
      $("callModalBody").textContent = `${who} (${message.from && message.from.phoneId || ""}) is calling. Accept to join the private room.`;
      try { $("callModal").showModal(); } catch (e) {}
      appendSystem(`Incoming call from ${who} ${message.from && message.from.phoneId || ""}.`);
    } else if (message.type === "call-decline") {
      appendSystem(`Call declined by ${message.from && message.from.phoneId || "callee"}.`);
      exitPrivateRoom();
    } else if (message.type === "call-cancel") {
      try { $("callModal").close(); } catch (e) {}
      pendingInvite = null;
      appendSystem("Caller cancelled the call.");
    }
  }

  function subscribePrivateRoom() {
    if (!drone || !privateRoomHash) return;
    if (privateSub && privateSubRoom === privateRoomHash) return;
    teardownPrivateRoom(/*keepHash*/ true);
    privateSub = drone.subscribe("observable-" + privateRoomHash);
    privateSubRoom = privateRoomHash;
    privateSub.on("members", (members) => {
      roomMemberCount = members.length;
      maybeStartOffer();
    });
    privateSub.on("data", handleRoomData);
    renderMessages();
  }

  function teardownPrivateRoom(keepHash) {
    if (privateSub) {
      try { privateSub.unsubscribe(); } catch (e) {}
      privateSub = null;
    }
    privateSubRoom = "";
    if (pc) {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
    if (localStream) {
      try { localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      localStream = null;
    }
    const remote = $("remoteVideo");
    const local = $("localVideo");
    if (remote) remote.srcObject = null;
    if (local) local.srcObject = null;
    remoteStream = null;
    roomMemberCount = 0;
    pendingRoomMessages = [];
    pendingRemoteCandidates = [];
    makingOffer = false;
    audioMuted = false;
    videoMuted = false;
    const micButton = $("muteAudio");
    const camButton = $("muteVideo");
    if (micButton) micButton.textContent = "Mic";
    if (camButton) camButton.textContent = "Cam";
    if (!keepHash) callRole = null;
    renderMessages();
  }

  function publishDrone(message) {
    if (!drone) return;
    try {
      drone.publish({ room: LOBBY_DRONE_ROOM, message });
    } catch (error) {
      console.warn(error);
    }
  }

  function ensurePrivateRoom(forceHash) {
    if (forceHash) {
      privateRoomHash = forceHash;
      if ((location.hash || "").replace("#", "") !== "room-" + forceHash) {
        location.hash = "room-" + forceHash;
      }
      subscribePrivateRoom();
      return;
    }
    if (!privateRoomHash) {
      privateRoomHash = randomHex(8);
      location.hash = "room-" + privateRoomHash;
      subscribePrivateRoom();
    }
  }

  function startCall() {
    if (!callRole) callRole = "caller";
    ensurePrivateRoom();
    if (!privateSub) {
      appendSystem("Private room is still connecting. Try again in a moment.");
      return;
    }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    pc.onicecandidate = (event) => {
      if (event.candidate) sendRoom({ type: "candidate", candidate: event.candidate });
    };
    pc.ontrack = (event) => {
      const remote = $("remoteVideo");
      remote.muted = false;
      remote.volume = 1;
      if (!remoteStream) remoteStream = new MediaStream();
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else if (event.track) {
        remoteStream.addTrack(event.track);
      }
      remote.srcObject = remoteStream;
      remote.play().catch(() => {
        appendSystem("Remote video is ready. Tap the large video window to start playback and audio.");
      });
      const audioCount = remoteStream.getAudioTracks().length;
      const videoCount = remoteStream.getVideoTracks().length;
      appendSystem(`Remote media received: ${videoCount} video, ${audioCount} audio.`);
    };
    pc.onnegotiationneeded = () => maybeStartOffer();
    pc.onconnectionstatechange = () => {
      if (pc && pc.connectionState === "connected") appendSystem("Video call connected.");
      if (pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
        appendSystem("Video call ended.");
        exitPrivateRoom();
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc && pc.iceConnectionState === "connected") appendSystem("Video route connected.");
      if (pc && (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) {
        appendSystem("Video connection was interrupted.");
        exitPrivateRoom();
      }
    };
    getLocalMedia().then((stream) => {
      localStream = stream;
      const local = $("localVideo");
      local.srcObject = stream;
      local.play().catch(() => {});
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      appendSystem(`Camera room started (${callRole}): ${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio. Room: ${location.href}`);
      renderCallControls();
      sendRoom({ type: "media-ready", role: callRole });
      flushPendingRoomMessages();
      maybeStartOffer();
    }).catch((error) => appendSystem(mediaErrorMessage(error)));
  }

  function toggleCall() {
    if (pc || privateRoomHash) {
      exitPrivateRoom();
      appendSystem("Returned to Lobby.");
      return;
    }
    startCall();
  }

  async function getLocalMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw { name: "NotSupportedError" };
    }
    if (localStream && localStream.getTracks().some((track) => track.readyState === "live")) {
      return localStream;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: true
      });
    } catch (firstError) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        appendSystem("Microphone could not start, so the call is using camera only.");
        return stream;
      } catch (_) {
        throw firstError;
      }
    }
  }

  function mediaErrorMessage(error) {
    if (!window.isSecureContext) {
      return "Camera and mic require HTTPS. Use your Cloudflare Pages https:// URL or localhost.";
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return "This browser does not support camera and mic access here.";
    }
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Camera or mic permission is blocked. Click the browser lock/tune icon beside the address bar, allow Camera and Microphone, then refresh.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No camera or microphone was found. Connect one, then refresh and try again.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "Camera or mic is already in use by another app. Close other call/camera apps and try again.";
    }
    return "Camera or mic could not start" + (name ? ` (${name}).` : ".");
  }

  function acceptIncomingCall() {
    if (!pendingInvite) return;
    const invite = pendingInvite;
    pendingInvite = null;
    try { $("callModal").close(); } catch (e) {}
    callRole = "callee";
    ensurePrivateRoom(invite.roomHash);
    startCall();
  }

  function declineIncomingCall() {
    if (!pendingInvite) return;
    const invite = pendingInvite;
    pendingInvite = null;
    try { $("callModal").close(); } catch (e) {}
    if (invite.fromUser && invite.fromUser.phoneId && drone) {
      drone.publish({
        room: phoneRoomName(invite.fromUser.phoneId),
        message: { type: "call-decline", from: { phoneId: currentUser ? currentUser.phoneId : "" } }
      });
    }
  }

  async function handleRoomData(message, client) {
    if (!message || (client && drone && client.id === drone.clientId)) return;
    if (message.type === "room-chat") {
      if (message.message && !roomMessageExists(message.message.id)) addRoomMessage(message.message);
      return;
    }
    if (message.type === "media-ready") {
      if (message.role === "callee") roomMemberCount = Math.max(roomMemberCount, 2);
      maybeStartOffer();
      return;
    }
    if (!pc) {
      pendingRoomMessages.push(message);
      return;
    }
    if (message.sdp) {
      if (message.sdp.type === "offer" && !localMediaReady()) {
        pendingRoomMessages.push(message);
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await flushPendingRemoteCandidates();
        if (pc.remoteDescription.type === "offer") {
          const answer = await pc.createAnswer();
          await localDescCreated(answer);
        }
      } catch (error) {
        console.error(error);
        appendSystem("Call connection failed while exchanging video details. Try ending and calling again.");
      }
    } else if (message.candidate) {
      if (!pc.remoteDescription) {
        pendingRemoteCandidates.push(message.candidate);
        return;
      }
      pc.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(console.error);
    }
  }

  function localDescCreated(desc) {
    return pc.setLocalDescription(desc).then(() => sendRoom({ type: "sdp", sdp: pc.localDescription }));
  }

  async function maybeStartOffer() {
    if (!pc || callRole !== "caller" || roomMemberCount < 2 || pc.localDescription) return;
    if (!localMediaReady()) return;
    if (pc.signalingState !== "stable") return;
    if (makingOffer) return;
    makingOffer = true;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await localDescCreated(offer);
      appendSystem("Video offer sent to the private room.");
    } catch (error) {
      console.error(error);
      appendSystem("Could not start video negotiation. Try calling again.");
    } finally {
      makingOffer = false;
    }
  }

  function localMediaReady() {
    return !!localStream && localStream.getTracks().some((track) => track.readyState === "live");
  }

  function flushPendingRoomMessages() {
    if (!pc || !pendingRoomMessages.length) return;
    const queued = pendingRoomMessages;
    pendingRoomMessages = [];
    queued.forEach((message) => handleRoomData(message));
  }

  async function flushPendingRemoteCandidates() {
    if (!pc || !pc.remoteDescription || !pendingRemoteCandidates.length) return;
    const queued = pendingRemoteCandidates;
    pendingRemoteCandidates = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
    }
  }

  function sendRoom(message) {
    if (!drone || !privateRoomHash) return;
    drone.publish({ room: "observable-" + privateRoomHash, message });
  }

  function roomMessageExists(id) {
    if (!id || !privateRoomHash || !state.roomMessages) return false;
    return (state.roomMessages[privateRoomHash] || []).some((message) => message.id === id);
  }

  function exitPrivateRoom() {
    if (!privateRoomHash) return;
    privateRoomHash = null;
    teardownPrivateRoom();
    history.replaceState(null, "", lobbyUrl());
    $("roomUrl").textContent = lobbyUrl();
    renderCallControls();
    renderMessages();
    renderWidget("room");
  }

  function lobbyUrl() {
    return pageUrl(location.search, `#${LOBBY_HASH}`);
  }

  function renderCallControls() {
    const button = $("startCall");
    if (button) button.textContent = (pc || privateRoomHash) ? "End" : "Start";
  }

  function enableRemotePlayback() {
    const remote = $("remoteVideo");
    remote.muted = false;
    remote.volume = 1;
    remote.play().catch(() => appendSystem("Browser blocked remote playback. Tap the video again or check site sound permissions."));
  }

  function toggleAudio() {
    if (!localStream) return;
    audioMuted = !audioMuted;
    localStream.getAudioTracks().forEach((track) => track.enabled = !audioMuted);
    $("muteAudio").textContent = audioMuted ? "Muted" : "Mic";
  }

  function toggleVideo() {
    if (!localStream) return;
    videoMuted = !videoMuted;
    localStream.getVideoTracks().forEach((track) => track.enabled = !videoMuted);
    $("muteVideo").textContent = videoMuted ? "Hidden" : "Cam";
  }

  function callPhoneId() {
    guardAuthed(async () => {
      let phoneId = $("phoneTarget").value.trim();
      if (!phoneId) { appendSystem("Enter a phone ID like #1234567."); return; }
      if (!phoneId.startsWith("#")) phoneId = "#" + phoneId.replace(/[^0-9]/g, "");
      if (!drone) { appendSystem("Realtime is not connected yet, try again in a moment."); return; }

      // Refresh the user cache so we can address newly-registered phone IDs.
      await syncFromServer().catch(() => {});
      const callee = state.users.find((u) => u.phoneId === phoneId);
      const calleeLabel = callee ? (callee.realName || callee.phoneId) : phoneId;

      // Place the caller into a fresh private room and become the "caller" role.
      callRole = "caller";
      const roomHash = randomHex(8);
      ensurePrivateRoom(roomHash);

      // Send invite to callee's personal phone channel. Even if the callee isn't
      // signed up locally, anyone subscribed under that phoneId will receive it.
      drone.publish({
        room: phoneRoomName(phoneId),
        message: {
          type: "call-invite",
          roomHash,
          from: {
            phoneId: currentUser.phoneId,
            realName: currentUser.realName,
            username: currentUser.username
          }
        }
      });

      appendSystem(`Calling ${calleeLabel} at ${phoneId}. Waiting for them to accept…`);
      startCall();
    });
  }

  function copyRoom() {
    ensurePrivateRoom();
    copyText(location.href).then(
      () => appendSystem("Private room URL copied."),
      () => appendSystem(`Private room URL: ${location.href}`)
    );
  }

  function renderAll() {
    renderSession();
    renderPosts();
    renderMessages();
    renderProfile();
    $("roomUrl").textContent = privateRoomHash ? location.href : lobbyUrl();
    renderCallControls();
    renderWidget("chat");
  }

  function renderSession() {
    $("sessionName").textContent = currentUser ? currentUser.username : "Guest viewer";
    $("sessionPhone").textContent = currentUser ? currentUser.phoneId : "Sign up to message";
    $("messageInput").placeholder = currentUser
      ? (isPrivateChatActive() ? "Message the private room" : "Message the #Lobby")
      : "Sign up or login to send a message";
  }

  function renderPosts() {
    $("posts").innerHTML = state.posts.map((post) => {
      const author = state.users.find((user) => user.id === post.authorId);
      return `<article class="post">
        <h4>${escapeHtml(post.title)}</h4>
        <p>${escapeHtml(post.description)}</p>
        <div class="meta"><span>${post.type}</span><span>${escapeHtml(post.price)}</span></div>
        <div class="meta"><span>${author ? escapeHtml(author.username) : "DevChat"}</span><span>${timeAgo(post.createdAt)}</span></div>
      </article>`;
    }).join("");
  }

  function renderMessages() {
    const messages = activeMessages();
    const title = document.querySelector(".chat-panel .panel-head h3");
    const status = $("lobbyStatus");
    if (title) title.textContent = isPrivateChatActive() ? "Private Room Chat" : "Lobby Chat";
    if (status && apiAvailable) status.textContent = isPrivateChatActive() ? `Room ${privateRoomHash}` : "#Lobby online";
    $("lobbyMessages").innerHTML = messages.map((message) => renderMessage(message)).join("");
    $("lobbyMessages").querySelectorAll("[data-preview-url]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openLinkModal(link.dataset.previewUrl);
      });
    });
    $("lobbyMessages").scrollTop = $("lobbyMessages").scrollHeight;
    renderSession();
  }

  function activeMessages() {
    if (!isPrivateChatActive()) return state.messages;
    return state.roomMessages && state.roomMessages[privateRoomHash] || [];
  }

  function isPrivateChatActive() {
    return !!privateRoomHash;
  }

  function renderMessage(message) {
    message = sanitizeChatMessage(message);
    const isMine = currentUser && message.userId === currentUser.id;
    return `<article class="message ${isMine ? "mine" : ""}">
      <strong>${escapeHtml(safeDisplayName(message))}</strong>
      <p>${linkify(message.text || "")}</p>
      ${previewHtml(message.text || "")}
    </article>`;
  }

  function createChatMessage(text) {
    return {
      id: cryptoId(),
      userId: currentUser.id,
      username: safeDisplayName(currentUser),
      text,
      createdAt: Date.now(),
      mine: true
    };
  }

  function sanitizeChatMessage(message) {
    const clean = { ...(message || {}) };
    clean.username = safeDisplayName(clean);
    delete clean.email;
    return clean;
  }

  function safeDisplayName(source) {
    const byId = source && source.userId && state.users.find((user) => user.id === source.userId);
    const raw = String(source && (source.username || source.realName || source.phoneId) || byId && byId.username || "DevChat").trim();
    if (!raw || raw.includes("@")) return "DevChat";
    return raw;
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function renderProfile() {
    if (!currentUser) {
      $("profileCard").innerHTML = "Profiles are generated after signup with a public URL, phone ID, portfolio links, and work status.";
      return;
    }
    $("profileCard").innerHTML = `<strong>${escapeHtml(currentUser.realName)}</strong><br>
      <span>${escapeHtml(currentUser.username)} · ${currentUser.phoneId}</span><br>
      <a href="${currentUser.profileUrl}" target="_blank" rel="noopener">${currentUser.profileUrl}</a>`;
  }

  function openWidget() {
    $("chatWidget").classList.remove("is-hidden");
    renderWidget("chat");
  }

  function renderWidget(tab) {
    document.querySelectorAll("[data-widget-tab]").forEach((button) => button.classList.toggle("active", button.dataset.widgetTab === tab));
    if (tab === "posts") {
      $("widgetBody").innerHTML = state.posts.slice(0, 4).map((post) => `<article class="post"><h4>${escapeHtml(post.title)}</h4><p>${escapeHtml(post.description)}</p><div class="meta"><span>${post.type}</span><span>${escapeHtml(post.price)}</span></div></article>`).join("");
    } else if (tab === "room") {
      const label = privateRoomHash ? `Private room ${escapeHtml(privateRoomHash)}` : `#${LOBBY_HASH}`;
      $("widgetBody").innerHTML = `<p class="modal-note">${label} is ready.</p><button class="primary stretch" data-widget-start-call type="button">Start Call</button><p class="modal-note">${escapeHtml(privateRoomHash ? location.href : lobbyUrl())}</p>`;
      const button = $("widgetBody").querySelector("[data-widget-start-call]");
      button.textContent = (pc || privateRoomHash) ? "End Call" : "Start Call";
      button.addEventListener("click", () => guardAuthed(toggleCall));
    } else {
      $("widgetBody").innerHTML = activeMessages().slice(-8).map(renderMessage).join("");
    }
  }

  function openLinkModal(url) {
    $("linkTitle").textContent = hostLabel(url);
    $("linkFrame").src = url;
    $("linkOpen").href = url;
    $("linkOpen").textContent = url;
    $("linkModal").showModal();
  }

  function linkify(text) {
    return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" data-preview-url="$1">$1</a>');
  }

  function previewHtml(text) {
    const url = firstUrl(text);
    if (!url) return "";
    const media = mediaThumbnail(url);
    return `<a class="link-preview" href="${url}" data-preview-url="${url}">
      <img alt="" src="${media.image}">
      <span><b>${escapeHtml(media.title)}</b><small>${escapeHtml(hostLabel(url))}</small></span>
    </a>`;
  }

  function firstUrl(text) {
    const match = text.match(/https?:\/\/[^\s<]+/);
    return match ? match[0] : "";
  }

  function mediaThumbnail(url) {
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (parsed && parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      if (id) return { title: "YouTube media preview", image: `https://img.youtube.com/vi/${id}/hqdefault.jpg` };
    }
    if (parsed && parsed.hostname.includes("youtu.be")) {
      return { title: "YouTube media preview", image: `https://img.youtube.com/vi/${parsed.pathname.slice(1)}/hqdefault.jpg` };
    }
    return { title: "Portfolio or media link", image: svgDataThumb(hostLabel(url)) };
  }

  function svgDataThumb(label) {
    const safe = encodeURIComponent(label.slice(0, 18));
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='116' height='116'%3E%3Crect width='116' height='116' fill='%2307100d'/%3E%3Ctext x='58' y='58' fill='%2335ff8a' font-family='Arial' font-size='13' text-anchor='middle'%3E${safe}%3C/text%3E%3C/svg%3E`;
  }

  function seedDemoContent() {
    if (state.seeded) return;
    const dev = { id: cryptoId(), username: "frontend_zero", realName: "Frontend Zero", email: "frontend@example.dev", phone: "555-0101", phoneId: "#0421188", profileUrl: pageUrl("?profile=frontend_zero"), socials: [], createdAt: Date.now() };
    const employer = { id: cryptoId(), username: "hire_node", realName: "Hire Node", email: "hire@example.dev", phone: "555-0102", phoneId: "#7349012", profileUrl: pageUrl("?profile=hire_node"), socials: [], createdAt: Date.now() };
    state.users.push(dev, employer);
    state.posts.push(
      { id: cryptoId(), title: "React dashboard cleanup", description: "Employer seeking a developer for a SaaS dashboard refresh and bug pass.", type: "hiring", price: "$800 fixed", authorId: employer.id, createdAt: Date.now() - 330000 },
      { id: cryptoId(), title: "Available for portfolio builds", description: "Frontend developer open for small business sites, landing pages, and Cloudflare static deploys.", type: "jobseeking", price: "$35/hr", authorId: dev.id, createdAt: Date.now() - 680000 }
    );
    state.messages.push(
      { id: cryptoId(), userId: dev.id, username: dev.username, text: "Portfolio preview works with links like https://youtu.be/dQw4w9WgXcQ", createdAt: Date.now() - 160000 },
      { id: cryptoId(), userId: employer.id, username: employer.username, text: "Drop a post with a title, description, and rate so employers can scan fast.", createdAt: Date.now() - 80000 }
    );
    state.seeded = true;
    saveLocalState();
    api("seed", { state: { users: state.users, posts: state.posts, messages: state.messages, seeded: true } }).catch(() => {});
  }

  // ---------- persistence ----------

  let lastApiError = "";

  async function syncFromServer() {
    if (!API_URL) {
      apiAvailable = false;
      lastApiError = "No backend detected. DevChat requires /api or api.php.";
      return;
    }
    try {
      const res = await fetch(API_URL + "?action=state&_=" + Date.now(), { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) {
        lastApiError = describeApiFailure(res, text);
        apiAvailable = false;
        return;
      }
      let data;
      try { data = JSON.parse(text); }
      catch (parseErr) {
        // The backend returned HTML or another non-JSON response.
        lastApiError = `${API_URL} did not return JSON`;
        apiAvailable = false;
        return;
      }
      apiAvailable = true;
      lastApiError = "";
      if (Array.isArray(data.users)) state.users = mergeById(state.users, data.users);
      if (Array.isArray(data.posts)) state.posts = mergeById(state.posts, data.posts);
      if (Array.isArray(data.messages)) state.messages = mergeById(state.messages, data.messages).slice(-200);
      if (data.seeded) state.seeded = true;
      saveLocalState();
    } catch (e) {
      lastApiError = "Network error reaching " + API_URL + " (" + (e && e.message || e) + ")";
      apiAvailable = false;
    }
  }

  function mergeById(a, b) {
    const map = new Map();
    [...a, ...b].forEach((item) => { if (item && item.id) map.set(item.id, item); });
    return Array.from(map.values());
  }

  function b64UrlEncode(obj) {
    const json = JSON.stringify(obj || {});
    // btoa needs binary string; encode UTF-8 first.
    const utf8 = unescape(encodeURIComponent(json));
    return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function api(action, body) {
    if (!API_URL) {
      await detectApi();
      if (!API_URL) {
        apiAvailable = false;
        if (!lastApiError) lastApiError = "No backend detected. DevChat requires /api or api.php.";
        return null;
      }
    }
    // Send the payload base64-encoded so WAFs that block { } " in URLs let it
    // through. Falls back to POST automatically if GET is rejected.
    const payload = b64UrlEncode(body || {});
    const getUrl = API_URL + "?action=" + encodeURIComponent(action) + "&b64=" + payload + "&_=" + Date.now();
    try {
      let res, text;
      if (getUrl.length < 7800) {
        res = await fetch(getUrl, { cache: "no-store" });
        text = await res.text();
        if (res.status === 405 || res.status === 414 || res.status === 403) {
          res = await postFallback(action, body);
          text = res ? await res.text() : "";
        }
      } else {
        res = await postFallback(action, body);
        text = res ? await res.text() : "";
      }
      if (!res) return null;
      let data = null;
      try { data = JSON.parse(text); }
      catch (e) {
        lastApiError = `${API_URL} ${nonJsonApiHint(text, res.status)}`;
        console.warn("[devchat] api non-JSON response:", text.slice(0, 400));
        apiAvailable = false;
        const brokenUrl = API_URL;
        API_URL = "";
        await detectApi();
        if (API_URL && API_URL !== brokenUrl) return api(action, body);
        return null;
      }
      if (!res.ok) {
        lastApiError = (data && data.error) ? String(data.error) : ("HTTP " + res.status);
      } else {
        apiAvailable = true;
      }
      return data;
    } catch (e) {
      lastApiError = "Network error: " + (e && e.message || e);
      apiAvailable = false;
      const brokenUrl = API_URL;
      API_URL = "";
      await detectApi();
      if (API_URL && API_URL !== brokenUrl) return api(action, body);
      return null;
    }
  }

  async function postFallback(action, body) {
    try {
      return await fetch(API_URL + "?action=" + encodeURIComponent(action), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
    } catch (e) { return null; }
  }

  function describeApiFailure(res, text) {
    try {
      const data = JSON.parse(text || "{}");
      const message = [data.error, data.hint].filter(Boolean).join(": ");
      if (message) return `${API_URL} HTTP ${res.status}: ${message}`;
    } catch (_) {}
    if (text && !looksLikeJson(text)) return `${API_URL} ${nonJsonApiHint(text, res.status)}`;
    return `${API_URL} HTTP ${res.status}`;
  }

  function apiErrorMessage() {
    const testUrl = API_URL || API_CANDIDATES[0] || "api.php";
    return lastApiError ? `Server unreachable: ${lastApiError}. Test ${testUrl} in your browser.` :
      "Server unreachable. DevChat requires a live backend: /api on Cloudflare Pages or api.php on PHP hosting.";
  }

  function apiHostLabel(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.pathname + (parsed.search || "");
    } catch {
      return url || "none";
    }
  }

  function looksLikeJson(text) {
    return /^\s*[\[{]/.test(text || "");
  }

  function nonJsonApiHint(text, status) {
    const raw = String(text || "");
    const compact = raw.replace(/\s+/g, " ").slice(0, 140);
    if (/^\s*<\?php/i.test(raw) || /DevChat persistent backend/i.test(raw)) {
      return `PHP is not executing on this host (HTTP ${status}). The server is exposing api.php source instead of running it. Enable PHP/FastCGI for this folder, move to PHP hosting, or use Cloudflare Pages Functions with KV.`;
    }
    if (/nginx/i.test(raw) && /404|not found/i.test(raw)) {
      return `backend route not found on nginx (HTTP ${status}). Upload api.php beside DevChat.html or configure Cloudflare Pages /api.`;
    }
    return `non-JSON HTTP ${status}: ${compact || "(empty response)"}`;
  }

  function loadLocalState() {
    if (REQUIRE_BACKEND) return baseState();
    try {
      return Object.assign(baseState(), JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
    } catch {
      return baseState();
    }
  }

  function baseState() {
    return { users: [], posts: [], messages: [], roomMessages: {}, currentUser: "", seeded: false };
  }

  function saveLocalState() {
    if (REQUIRE_BACKEND) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function readSession() {
    const sid = readSessionId();
    if (!sid) return null;
    return state.users.find((u) => u.id === sid) || null;
  }

  function readSessionId() {
    try { return localStorage.getItem(SESSION_KEY) || ""; }
    catch { return ""; }
  }

  function writeSession(user) {
    try { localStorage.setItem(SESSION_KEY, user ? user.id : ""); } catch (e) {}
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function randomHex(size) {
    const bytes = new Uint8Array(Math.ceil(size / 2));
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, size);
    }
    return Math.floor(Math.random() * Math.pow(16, size)).toString(16).padStart(size, "0");
  }

  function cryptoId() {
    return (window.crypto && crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + randomHex(10);
  }

  function iceServers() {
    if (Array.isArray(DEVCHAT_CONFIG.iceServers) && DEVCHAT_CONFIG.iceServers.length) {
      return DEVCHAT_CONFIG.iceServers;
    }
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ];
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function safeLocalGet(key) {
    try { return localStorage.getItem(key) || ""; }
    catch { return ""; }
  }

  function hostLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "preview"; }
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function timeAgo(time) {
    const minutes = Math.max(1, Math.round((Date.now() - time) / 60000));
    return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
  }
})();
