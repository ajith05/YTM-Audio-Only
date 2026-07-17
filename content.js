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

  // Send a playlist to the player. `type` is PLAY_PLAYLIST (replace) or
  // ADD_PLAYLIST (append to the existing queue).
  function sendPlaylist(btn, type, okWord) {
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
          flash(btn, res.count != null ? `${okWord} ${res.count}` : okWord);
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
      btn.addEventListener("click", () => sendPlaylist(btn, "PLAY_PLAYLIST", "Playing"));
      document.body.appendChild(btn);
    }
    if (!document.getElementById(ADD_ID)) {
      const add = document.createElement("button");
      add.id = ADD_ID;
      add.textContent = "＋ Add to queue";
      styleButton(add, "140px", "#272727", "#eee");
      add.addEventListener("click", () => sendPlaylist(add, "ADD_PLAYLIST", "Added"));
      document.body.appendChild(add);
    }
  }

  function flash(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = orig), 1600);
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
