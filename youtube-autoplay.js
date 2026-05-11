// DevChat YouTube auto-play injector
// Watches for YouTube iframes (including those rendered by VAST/VPAID creatives
// inside the ad-player) and forces them to autoplay muted as soon as they load.
(function () {
  "use strict";

  const YT_HOST = /(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/i;

  function isYouTubeFrame(frame) {
    if (!frame || frame.tagName !== "IFRAME") return false;
    const src = frame.src || frame.getAttribute("src") || "";
    return YT_HOST.test(src);
  }

  function rewriteSrc(frame) {
    try {
      const original = frame.src || frame.getAttribute("src") || "";
      if (!original) return;
      const url = new URL(original, location.href);
      const params = url.searchParams;
      let changed = false;
      const desired = {
        autoplay: "1",
        mute: "1",
        muted: "1",
        playsinline: "1",
        enablejsapi: "1",
        controls: params.get("controls") || "0",
        rel: "0",
        modestbranding: "1"
      };
      for (const key in desired) {
        if (params.get(key) !== desired[key]) {
          params.set(key, desired[key]);
          changed = true;
        }
      }
      if (changed) {
        url.search = params.toString();
        if (frame.src !== url.toString()) {
          frame.src = url.toString();
        }
      }
      // Allow autoplay without user gesture
      const allow = (frame.getAttribute("allow") || "").toLowerCase();
      const need = ["autoplay", "encrypted-media", "picture-in-picture"];
      const merged = allow.split(";").map((s) => s.trim()).filter(Boolean);
      need.forEach((n) => { if (!merged.includes(n)) merged.push(n); });
      frame.setAttribute("allow", merged.join("; "));
      frame.setAttribute("allowfullscreen", "");
    } catch (e) {}
  }

  function postPlay(frame) {
    try {
      frame.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: "mute", args: [] }),
        "*"
      );
      frame.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*"
      );
    } catch (e) {}
  }

  function activate(frame) {
    if (!isYouTubeFrame(frame)) return;
    if (frame.dataset.dcAutoplay === "1") return;
    frame.dataset.dcAutoplay = "1";
    rewriteSrc(frame);
    const fire = () => {
      postPlay(frame);
      setTimeout(() => postPlay(frame), 400);
      setTimeout(() => postPlay(frame), 1200);
    };
    if (frame.contentDocument && frame.contentDocument.readyState === "complete") {
      fire();
    }
    frame.addEventListener("load", fire);
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll("iframe").forEach(activate);
  }

  // Promote any plain <video> elements injected by VPAID creatives as well.
  function promoteVideos(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll("video").forEach((v) => {
      if (v.dataset.dcAutoplay === "1") return;
      v.dataset.dcAutoplay = "1";
      try {
        v.muted = true;
        v.setAttribute("muted", "");
        v.autoplay = true;
        v.setAttribute("autoplay", "");
        v.setAttribute("playsinline", "");
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (e) {}
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes && m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === "IFRAME") activate(node);
        else if (node.tagName === "VIDEO") promoteVideos(node.parentNode || document);
        else {
          scan(node);
          promoteVideos(node);
        }
      });
      if (m.type === "attributes" && m.target && m.target.tagName === "IFRAME") {
        activate(m.target);
      }
    }
  });

  function start() {
    scan(document);
    promoteVideos(document);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"]
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // Re-kick when the host page asks (e.g. ad rotation).
  window.addEventListener("message", (e) => {
    if (e.data === "dc-autoplay" || e.data === "clickVideo") {
      scan(document);
      promoteVideos(document);
    }
  });
})();
