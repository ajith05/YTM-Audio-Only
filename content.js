// Injected on music.youtube.com. Adds a floating "Audio-only" button that
// sends the album/playlist currently open to the extension's player.

(function () {
  const BTN_ID = "ytm-audio-only-btn";
  const ADD_ID = "ytm-audio-only-add-btn";

  function currentPlaylistId() {
    // Album/playlist pages carry ?list=... in the URL.
    const list = new URLSearchParams(location.search).get("list");
    if (list) return list.replace(/^VL/, "");
    return null;
  }

  // Label the outcome of a PLAY_PLAYLIST request. Always a replace, so the
  // only question is whether we got a track list back.
  function playLabel(res) {
    return { text: res.count != null ? `Playing ${res.count}` : "Playing" };
  }

  // Label the outcome of an ADD_PLAYLIST request. background.play() only truly
  // appends when it expanded a track list (needs the Data API key) AND a player
  // tab already exists in this context; otherwise it REPLACES the queue. Say so
  // rather than claiming "Added" over a wiped queue. Mirrors popup.js.
  function addLabel(res) {
    if (res.usedFallback) {
      console.info("[YTM Audio-Only] No usable Data API key — replaced the queue instead of appending.");
      return { text: "Replaced", ms: 2600 };
    }
    if (res.appended) return { text: `Added ${res.count}` };
    if (res.count != null) {
      console.info("[YTM Audio-Only] No player tab to append to — replaced the queue.");
      return { text: `Replaced ${res.count}`, ms: 2600 };
    }
    return { text: "Replaced", ms: 2600 };
  }

  // Send a playlist to the player. `type` is PLAY_PLAYLIST (replace) or
  // ADD_PLAYLIST (append to the existing queue). `label` maps the background's
  // response to the flash text, so the button reports what actually happened.
  function sendPlaylist(btn, type, label) {
    const id = currentPlaylistId();
    if (!id) { flash(btn, "Open an album first"); return; }
    // The content script is orphaned after the extension reloads; sendMessage
    // then throws "Extension context invalidated" and the click looks dead.
    if (!chrome.runtime?.id) { flash(btn, "Reload this tab"); return; }
    try {
      chrome.runtime.sendMessage({ type, playlistId: id }, (res) => {
        if (chrome.runtime.lastError) {
          console.error("[YTM Audio-Only]", chrome.runtime.lastError.message);
          flash(btn, "Reload this tab");
          return;
        }
        if (res && res.ok) {
          const { text, ms } = label(res);
          flash(btn, text, ms);
        } else {
          console.error("[YTM Audio-Only]", res && res.error);
          flash(btn, (res && res.error) ? "Error" : "Failed");
        }
      });
    } catch (e) {
      console.error("[YTM Audio-Only]", e);
      flash(btn, "Reload this tab");
    }
  }

  function styleButton(btn, bottom, bg, color) {
    Object.assign(btn.style, {
      position: "fixed",
      right: "20px",
      bottom,
      zIndex: "99999",
      padding: "10px 16px",
      borderRadius: "999px",
      border: "0",
      background: bg,
      color,
      fontWeight: "600",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      cursor: "pointer",
      boxShadow: "0 4px 14px rgba(0,0,0,.45)"
    });
  }

  function ensureButton() {
    if (!document.getElementById(BTN_ID)) {
      const btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.textContent = "▶ Audio-only";
      styleButton(btn, "90px", "#fff", "#111");
      btn.addEventListener("click", () => sendPlaylist(btn, "PLAY_PLAYLIST", playLabel));
      document.body.appendChild(btn);
    }
    if (!document.getElementById(ADD_ID)) {
      const add = document.createElement("button");
      add.id = ADD_ID;
      add.textContent = "＋ Add to queue";
      styleButton(add, "140px", "#272727", "#eee");
      add.addEventListener("click", () => sendPlaylist(add, "ADD_PLAYLIST", addLabel));
      document.body.appendChild(add);
    }
  }

  // Show `text` on the button, then restore its label. Outcomes the user may
  // not expect (a queue replaced rather than appended) get a longer window.
  function flash(btn, text, ms = 1600) {
    const orig = btn.dataset.label || btn.textContent;
    btn.dataset.label = orig;
    btn.textContent = text;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => (btn.textContent = orig), ms);
  }

  function update() {
    const id = currentPlaylistId();
    if (id) {
      ensureButton();
    } else {
      const btn = document.getElementById(BTN_ID);
      const add = document.getElementById(ADD_ID);
      if (btn) btn.remove();
      if (add) add.remove();
    }
  }

  // YTM is an SPA; URL changes without full reloads. Poll for changes.
  let last = location.href;
  setInterval(() => {
    if (location.href !== last) { last = location.href; update(); }
  }, 1000);

  update();
})();
