// Privileged player page. Owns the queue + UI and drives an embedded YouTube
// player iframe via YouTube's postMessage protocol (no remote scripts, so it
// works under MV3 CSP without a sandbox).

const YT_ORIGIN = "https://www.youtube.com";
let iframe = document.getElementById("yt");

// YT player states
const UNSTARTED = -1, ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5;

let ready = false;
let listenTimer = null;
let tracks = [];             // [{videoId, title, channel, thumb, dead?}]
let index = 0;
let usingNative = false;     // no API key => embed plays the playlist itself
let lastState = null;        // dedupe state events (onStateChange + infoDelivery)
let currentTime = 0;         // last-known playback position (secs), from infoDelivery
let currentPlaylistId = "";  // id of the first album loaded (for storage/display)
let dragFrom = null;         // index being dragged during a reorder
const ownWriteIds = new Set(); // ids of our own currentQueue writes (to ignore their echoes)

// --- Talking to the embed -------------------------------------------------

function ytCommand(func, args) {
  if (!iframe.contentWindow) return;
  iframe.contentWindow.postMessage(
    JSON.stringify({ event: "command", func, args: args || [] }),
    "*"
  );
}

function startListening() {
  let tries = 0;
  if (listenTimer) clearInterval(listenTimer);
  listenTimer = setInterval(() => {
    if (ready || tries++ > 60) { clearInterval(listenTimer); return; }
    if (iframe.contentWindow) iframe.contentWindow.postMessage('{"event":"listening"}', "*");
  }, 250);
}

function onIframeLoad() { ready = false; lastState = null; startListening(); }
iframe.addEventListener("load", onIframeLoad);

// Load a URL by REPLACING the iframe element rather than assigning to its src.
// Mutating an existing iframe's src pushes an entry onto the tab's session
// history (enabling the Back button); a freshly inserted iframe's first
// navigation is a replacement and adds no history entry. Per-track advances
// still use the loadVideoById command (no navigation), so they're unaffected.
function setEmbed(url) {
  const fresh = document.createElement("iframe");
  fresh.id = "yt";
  fresh.setAttribute("allow", iframe.getAttribute("allow") || "autoplay; encrypted-media; fullscreen");
  fresh.setAttribute("referrerpolicy", iframe.getAttribute("referrerpolicy") || "strict-origin-when-cross-origin");
  fresh.addEventListener("load", onIframeLoad);
  iframe.replaceWith(fresh);
  iframe = fresh;
  ready = false;
  lastState = null;
  currentTime = 0;
  fresh.src = url;
}

function embedSrc({ videoId, list }) {
  const common = `enablejsapi=1&autoplay=1&playsinline=1&rel=0`;
  if (list) {
    return `${YT_ORIGIN}/embed/videoseries?list=${encodeURIComponent(list)}&${common}`;
  }
  return `${YT_ORIGIN}/embed/${videoId}?${common}`;
}

// --- Incoming events from the embed ---------------------------------------

window.addEventListener("message", (e) => {
  if (e.origin !== "https://www.youtube.com" && e.origin !== "https://www.youtube-nocookie.com") return;
  let m;
  try { m = JSON.parse(e.data); } catch (_) { return; }
  if (!m || !m.event) return;

  switch (m.event) {
    case "onReady":
      ready = true;
      break;
    case "onStateChange":
      handleState(m.info);
      break;
    case "onError":
      handleError(m.info);
      break;
    case "infoDelivery":
      ready = true;
      if (m.info) {
        if (typeof m.info.currentTime === "number") currentTime = m.info.currentTime;
        if (typeof m.info.playerState === "number") handleState(m.info.playerState);
      }
      break;
  }
});

// --- Queue loading --------------------------------------------------------

function startQueue(queue, startIndex = 0) {
  currentPlaylistId = queue.playlistId || "";
  updateOpenYtm();
  if (queue.tracks && queue.tracks.length) {
    usingNative = false;
    tracks = queue.tracks.map((t) => ({ ...t, dead: false }));
    index = Math.min(Math.max(0, startIndex), tracks.length - 1);
    document.getElementById("headerSub").textContent =
      `${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded.`;
    document.getElementById("info").textContent =
      queue.playlistId ? `Playlist ${queue.playlistId}` : `${tracks.length} tracks`;
    renderList();
    highlight();
    updateNowPlaying();
    setEmbed(embedSrc({ videoId: tracks[index].videoId }));
  } else if (queue.playlistId) {
    usingNative = true;
    tracks = [];
    document.getElementById("headerSub").textContent = "Playing playlist directly.";
    document.getElementById("info").textContent =
      "No Data API key set — playing the playlist directly, so the track list isn't shown. Add a key in Options for the full queue.";
    renderList();
    setEmbed(embedSrc({ list: queue.playlistId }));
  }
}

function playIndex(i) {
  if (i < 0 || i >= tracks.length) return;
  index = i;
  highlight();
  updateNowPlaying();
  lastState = null;
  currentTime = 0;
  if (ready) ytCommand("loadVideoById", [tracks[i].videoId]);
  else setEmbed(embedSrc({ videoId: tracks[i].videoId }));
}

// --- Player state ---------------------------------------------------------

function handleState(s) {
  if (s === lastState) return;
  lastState = s;
  if (s === ENDED && !usingNative) {
    if (index < tracks.length - 1) playIndex(index + 1);
  }
  document.getElementById("playpause").textContent = s === PLAYING ? "⏸" : "▶";
  chrome.storage.local.set({ playerState: s });
}

function handleError(code) {
  // 2 bad param, 5 HTML5 error, 100 removed, 101/150 embedding disabled.
  if (!usingNative && tracks[index]) {
    tracks[index].dead = true;
    renderList();
    if (index < tracks.length - 1) playIndex(index + 1);
  }
}

// --- UI -------------------------------------------------------------------

function renderList() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  tracks.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "track" + (i === index ? " active" : "") + (t.dead ? " dead" : "");
    el.draggable = true;
    el.innerHTML =
      `<div class="grip" title="Drag to reorder">⠿</div>` +
      `<div class="num">${i + 1}</div>` +
      `<div class="meta"><div class="t"></div><div class="c"></div></div>` +
      `<button class="rm" title="Remove from queue">✕</button>`;
    el.querySelector(".t").textContent = t.title || t.videoId;
    el.querySelector(".c").textContent = t.channel || "";
    el.addEventListener("click", () => playIndex(i));
    el.querySelector(".rm").addEventListener("click", (e) => { e.stopPropagation(); removeTrack(i); });
    el.addEventListener("dragstart", (e) => {
      dragFrom = i;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    el.addEventListener("drop", (e) => { e.preventDefault(); moveTrack(dragFrom, i); dragFrom = null; });
    list.appendChild(el);
  });
}

// --- Queue editing --------------------------------------------------------

function removeTrack(i) {
  if (usingNative || i < 0 || i >= tracks.length) return;
  const wasCurrent = i === index;
  // Re-find the current track by object identity, not videoId — the same song
  // can appear twice in the queue, and matching by id would snap to the first copy.
  const current = tracks[index];
  tracks.splice(i, 1);
  if (!tracks.length) { clearQueue(); return; }
  if (wasCurrent) {
    index = Math.min(i, tracks.length - 1);
    renderList();
    highlight();
    updateNowPlaying();
    lastState = null;
    if (ready) ytCommand("loadVideoById", [tracks[index].videoId]);
    else setEmbed(embedSrc({ videoId: tracks[index].videoId }));
  } else {
    index = tracks.indexOf(current);
    if (index < 0) index = 0;
    renderList();
    highlight();
    updateNowPlaying();
  }
  document.getElementById("headerSub").textContent =
    `${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded.`;
  persistQueue();
}

function moveTrack(from, to) {
  if (usingNative || from == null || from === to) return;
  if (from < 0 || to < 0 || from >= tracks.length || to >= tracks.length) return;
  const current = tracks[index];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved);
  index = tracks.indexOf(current);
  if (index < 0) index = 0;
  renderList();
  highlight();
  updateNowPlaying();
  persistQueue();
}

function appendTracks(newTracks) {
  if (!newTracks || !newTracks.length) return;
  // Nothing real to merge into (native/direct playlist or empty queue):
  // start a fresh track-mode queue instead.
  if (usingNative || !tracks.length) {
    startQueue({ playlistId: "", tracks: newTracks });
    persistQueue();
    return;
  }
  tracks = tracks.concat(newTracks.map((t) => ({ ...t, dead: false })));
  renderList();
  highlight();
  updateNowPlaying();
  document.getElementById("headerSub").textContent =
    `${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded.`;
  document.getElementById("info").textContent = `${tracks.length} tracks`;
  persistQueue();
}

// Persist the live queue without re-triggering startQueue in this tab. Each
// write carries a unique writeId; the onChanged listener skips changes whose
// writeId is one of ours. (A boolean flag isn't enough: rapid edits queue
// several change events, and one flag can only absorb the first.)
function persistQueue() {
  const writeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ownWriteIds.add(writeId);
  chrome.storage.local.set({
    currentQueue: {
      playlistId: currentPlaylistId,
      tracks: tracks.map((t) => ({ videoId: t.videoId, title: t.title, channel: t.channel, thumb: t.thumb })),
      ts: Date.now(),
      writeId
    }
  });
}

function highlight() {
  const items = document.querySelectorAll(".track");
  items.forEach((el, i) => el.classList.toggle("active", i === index));
  const active = items[index];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function updateNowPlaying() {
  const t = tracks[index];
  document.getElementById("nowTitle").textContent = t ? (t.title || t.videoId) : "Nothing playing";
  document.getElementById("nowChannel").textContent = t ? (t.channel || "") : "";
  chrome.storage.local.set({
    nowPlaying: t ? { title: t.title, channel: t.channel, index, total: tracks.length } : null
  });
}

// --- Local controls -------------------------------------------------------

document.getElementById("playpause").addEventListener("click", () => {
  const playing = document.getElementById("playpause").textContent === "⏸";
  ytCommand(playing ? "pauseVideo" : "playVideo");
});
document.getElementById("next").addEventListener("click", () => doNext());
document.getElementById("prev").addEventListener("click", () => doPrev());

// Keyboard shortcuts while the player page is focused. (When focus is inside the
// YouTube iframe, keystrokes go to YouTube instead — a cross-origin boundary we
// can't reach.) Skip when typing or on a button so we don't fight text input or
// double-fire a focused control's own click.
//   Space          play/pause
//   Left / Right    previous / next track
//   Shift+Left/Right seek 5s back / forward
const SEEK_STEP = 5; // seconds
document.addEventListener("keydown", (e) => {
  const t = e.target;
  const tag = (t && t.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "button" || (t && t.isContentEditable)) return;

  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    const playing = document.getElementById("playpause").textContent === "⏸";
    ytCommand(playing ? "pauseVideo" : "playVideo");
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (e.shiftKey) ytCommand("seekTo", [Math.max(0, currentTime - SEEK_STEP), true]);
    else doPrev();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (e.shiftKey) ytCommand("seekTo", [currentTime + SEEK_STEP, true]);
    else doNext();
  }
});

function doNext() { usingNative ? ytCommand("nextVideo") : playIndex(index + 1); }

// Previous is position-based, like most music apps: if we're more than a few
// seconds into the track, restart it; only when already near the start does it
// step back to the previous track.
const PREV_RESTART_THRESHOLD = 5; // seconds
function doPrev() {
  // On the first track there's nothing to step back to, so always just restart
  // it, regardless of how far in we are.
  if (!usingNative && index === 0) { ytCommand("seekTo", [0, true]); return; }
  if (currentTime > PREV_RESTART_THRESHOLD) { ytCommand("seekTo", [0, true]); return; }
  usingNative ? ytCommand("previousVideo") : playIndex(index - 1);
}

function clearQueue() {
  ytCommand("stopVideo");
  setEmbed("about:blank");
  tracks = [];
  index = 0;
  usingNative = false;
  ready = false;
  lastState = null;
  currentPlaylistId = "";
  updateOpenYtm();
  renderList();
  document.getElementById("headerSub").textContent =
    'Open the popup or click "Audio-only" on a YouTube Music album to start.';
  document.getElementById("info").textContent = "No album loaded yet.";
  document.getElementById("nowTitle").textContent = "Nothing playing";
  document.getElementById("nowChannel").textContent = "";
  document.getElementById("playpause").textContent = "▶";
  chrome.storage.local.remove(["currentQueue", "nowPlaying", "playerState"]);
}

document.getElementById("clear").addEventListener("click", clearQueue);

// Open the original album/playlist on YouTube Music in a new tab. Disabled when
// no playlist id is known (e.g. a queue built from appended loose tracks).
function updateOpenYtm() {
  document.getElementById("openYtm").disabled = !currentPlaylistId;
}
document.getElementById("openYtm").addEventListener("click", () => {
  if (!currentPlaylistId) return;
  window.open(
    `https://music.youtube.com/playlist?list=${encodeURIComponent(currentPlaylistId)}`,
    "_blank"
  );
});

// --- Remote controls (from popup, via background) -------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "APPEND_TRACKS") { appendTracks(msg.tracks); return; }
  if (msg.type !== "CONTROL") return;
  switch (msg.action) {
    case "play": ytCommand("playVideo"); break;
    case "pause": ytCommand("pauseVideo"); break;
    case "next": doNext(); break;
    case "prev": doPrev(); break;
    case "clear": clearQueue(); break;
  }
});

// --- Queue source: storage -----------------------------------------------

chrome.storage.local.get(["currentQueue", "nowPlaying"]).then(({ currentQueue, nowPlaying }) => {
  if (currentQueue) {
    // Resume at the last-played track after a player-tab reload.
    const idx = nowPlaying && typeof nowPlaying.index === "number" ? nowPlaying.index : 0;
    startQueue(currentQueue, idx);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.currentQueue && changes.currentQueue.newValue) {
    // Ignore echoes of the writes we made ourselves for in-place queue edits.
    const writeId = changes.currentQueue.newValue.writeId;
    if (writeId && ownWriteIds.has(writeId)) { ownWriteIds.delete(writeId); return; }
    startQueue(changes.currentQueue.newValue);
  }
});
