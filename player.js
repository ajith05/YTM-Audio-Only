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
let currentTitle = "";       // album name, when the Data API gave us one
let albumQueue = [];         // albums parked behind this one: [{playlistId,title,tracks}]
let autoAdvanceAlbums = true; // pull the next album when the current queue ends
let dragFrom = null;         // track index being dragged during a reorder
let albumDragFrom = null;    // album-queue index being dragged
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
  currentTitle = queue.title || "";
  if (queue.tracks && queue.tracks.length) {
    usingNative = false;
    tracks = queue.tracks.map((t) => ({ ...t, dead: false }));
    index = Math.min(Math.max(0, startIndex), tracks.length - 1);
    document.getElementById("headerSub").textContent =
      `${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded.`;
    document.getElementById("info").textContent = queueLabel();
    updateOpenYtm();
    renderList();
    highlight();
    updateNowPlaying();
    setEmbed(embedSrc({ videoId: tracks[index].videoId }));
  } else if (queue.playlistId) {
    usingNative = true;
    tracks = [];
    updateOpenYtm();
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
  if (s === ENDED && !usingNative) advance();
  document.getElementById("playpause").textContent = s === PLAYING ? "⏸" : "▶";
  chrome.storage.local.set({ playerState: s });
}

function handleError(code) {
  // 2 bad param, 5 HTML5 error, 100 removed, 101/150 embedding disabled.
  if (!usingNative && tracks[index]) {
    tracks[index].dead = true;
    renderList();
    advance();
  }
}

// --- UI -------------------------------------------------------------------

// How an album reads in the UI. The Data API gives us a real album name when the
// extra playlists.list call succeeds; otherwise fall back to what the track list
// itself tells us. "- Topic" is YouTube's suffix on art-track channels.
function albumLabel({ title, tracks: ts }) {
  const n = ts ? ts.length : 0;
  const count = `${n} track${n === 1 ? "" : "s"}`;
  if (title) return `${title} · ${count}`;
  const channel = (ts && ts[0] && ts[0].channel || "").replace(/\s*-\s*Topic$/, "");
  return channel ? `${count} · ${channel}` : count;
}

function queueLabel() {
  if (currentTitle) return `${currentTitle} · ${tracks.length} tracks`;
  if (tracks.length) return albumLabel({ title: "", tracks });
  return currentPlaylistId ? `Playlist ${currentPlaylistId}` : "No album loaded yet.";
}

function renderAlbumQueue() {
  const section = document.getElementById("upnext");
  const list = document.getElementById("upnextList");
  const count = document.getElementById("upnextCount");
  const n = albumQueue.length;
  section.hidden = !n;
  count.textContent = n ? `${n} album${n === 1 ? "" : "s"}` : "";
  list.innerHTML = "";
  if (!n) return;
  albumQueue.forEach((album, i) => {
    const el = document.createElement("div");
    el.className = "album";
    el.draggable = true;
    el.innerHTML =
      `<div class="grip" title="Drag to reorder">⠿</div>` +
      `<div class="num">${i + 1}</div>` +
      `<div class="meta"><div class="t"></div></div>` +
      `<button class="rm" title="Remove from the album queue">✕</button>`;
    el.querySelector(".t").textContent = albumLabel(album);
    el.querySelector(".rm").addEventListener("click", () => removeAlbum(i));
    el.addEventListener("dragstart", (e) => {
      albumDragFrom = i;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    el.addEventListener("drop", (e) => { e.preventDefault(); moveAlbum(albumDragFrom, i); albumDragFrom = null; });
    list.appendChild(el);
  });
}

// Reorder the pending albums by drag, mirroring moveTrack. Only what's WAITING
// moves — the album playing now has already left albumQueue, so a drag can't
// disturb it. Re-reads storage first: the background appends there, so a stale
// local copy could drop an album queued mid-drag.
async function moveAlbum(from, to) {
  if (from == null || from === to) return;
  const { albumQueue: stored } = await chrome.storage.local.get("albumQueue");
  const queue = Array.isArray(stored) ? stored.slice() : [];
  if (from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);
  albumQueue = queue;
  await chrome.storage.local.set({ albumQueue: queue });
  renderAlbumQueue();
}

async function removeAlbum(i) {
  const { albumQueue: stored } = await chrome.storage.local.get("albumQueue");
  const queue = Array.isArray(stored) ? stored.slice() : [];
  if (i < 0 || i >= queue.length) return;
  queue.splice(i, 1);
  albumQueue = queue;
  await chrome.storage.local.set({ albumQueue: queue });
  renderAlbumQueue();
}

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

// Is `next` the queue we're already playing, just longer? Same album, and every
// track we hold still in the same position.
function isAppendOf(next) {
  if (usingNative || !tracks.length || !next.tracks) return false;
  if ((next.playlistId || "") !== currentPlaylistId) return false;
  if (next.tracks.length <= tracks.length) return false;
  return tracks.every((t, i) => next.tracks[i] && next.tracks[i].videoId === t.videoId);
}

function adoptAppended(nextTracks) {
  const extra = nextTracks.slice(tracks.length);
  tracks = tracks.concat(extra.map((t) => ({ ...t, dead: false })));
  renderList();
  highlight();
  updateNowPlaying();
  document.getElementById("headerSub").textContent =
    `${tracks.length} track${tracks.length === 1 ? "" : "s"} loaded.`;
  document.getElementById("info").textContent = queueLabel();
}

function appendTracks(newTracks) {
  if (!newTracks || !newTracks.length) return;
  // Nothing real to merge into (native/direct playlist or empty queue):
  // start a fresh track-mode queue instead.
  if (usingNative || !tracks.length) {
    // Nothing to merge with, so these tracks ARE the queue — keep their own
    // album id rather than blanking it (which would grey out "Open in YTM").
    const first = newTracks[0] || {};
    startQueue({ playlistId: first.playlistId || "", title: "", tracks: newTracks });
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
  updateOpenYtm();
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
      title: currentTitle,
      tracks: tracks.map((t) => ({
        videoId: t.videoId, playlistId: t.playlistId, title: t.title, channel: t.channel, thumb: t.thumb
      })),
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
  updateOpenYtm();
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

function doNext() { usingNative ? ytCommand("nextVideo") : advance(); }

// Move past the current track. At the end of the queue this is where the album
// queue takes over — but only when auto-advance is on, so the toggle governs
// the Next button and the → key exactly as it governs a track ending.
function advance() {
  if (index < tracks.length - 1) { playIndex(index + 1); return; }
  if (!autoAdvanceAlbums) return;
  pullNextAlbum();
}

// Promote the head of the album queue to be the playing queue. Re-reads storage
// rather than trusting the local copy: normal and incognito windows share
// chrome.storage.local, so two player tabs could otherwise claim the same album.
let pullingAlbum = false;
async function pullNextAlbum() {
  // The storage read below is async, so two triggers close together (ENDED
  // landing while a mashed Next is still in flight) could both read the same
  // queue and consume two albums, playing only the second.
  if (pullingAlbum) return;
  pullingAlbum = true;
  try {
    await pullNextAlbumInner();
  } finally {
    pullingAlbum = false;
  }
}

async function pullNextAlbumInner() {
  const { albumQueue: stored } = await chrome.storage.local.get("albumQueue");
  const queue = Array.isArray(stored) ? stored.slice() : [];
  const next = queue.shift();
  if (!next) return;

  albumQueue = queue;
  const writeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ownWriteIds.add(writeId);
  const currentQueue = {
    playlistId: next.playlistId || "",
    title: next.title || "",
    tracks: next.tracks,
    ts: Date.now(),
    writeId
  };
  // startQueue defaults to index 0, and its updateNowPlaying() immediately
  // rewrites nowPlaying for the new album — so the finished album's resume
  // position is replaced, not inherited. Any player tab that reloads from here
  // reads a nowPlaying that already matches this queue.
  await chrome.storage.local.set({ albumQueue: queue, currentQueue });
  startQueue(currentQueue);
  renderAlbumQueue();
}

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
  currentTitle = "";
  albumQueue = [];
  updateOpenYtm();
  renderAlbumQueue();
  renderList();
  document.getElementById("headerSub").textContent =
    'Open the popup or click "Play now" on a YouTube Music album to start.';
  document.getElementById("info").textContent = "No album loaded yet.";
  document.getElementById("nowTitle").textContent = "Nothing playing";
  document.getElementById("nowChannel").textContent = "";
  document.getElementById("playpause").textContent = "▶";
  chrome.storage.local.remove(["currentQueue", "nowPlaying", "playerState", "albumQueue"]);
}

document.getElementById("clear").addEventListener("click", clearQueue);

// The album the PLAYING track came from. A queue can mix albums (appended
// tracks, or an album pulled off the album queue), so the queue-wide id is only
// a fallback — tracks expanded by newer versions carry their own.
function playingPlaylistId() {
  const t = tracks[index];
  return (t && t.playlistId) || currentPlaylistId || "";
}

// Open the original album/playlist on YouTube Music in a new tab. Disabled when
// no playlist id is known (e.g. an older stored queue of loose tracks).
function updateOpenYtm() {
  document.getElementById("openYtm").disabled = !playingPlaylistId();
}
document.getElementById("openYtm").addEventListener("click", () => {
  const id = playingPlaylistId();
  if (!id) return;
  window.open(`https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`, "_blank");
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

chrome.storage.local
  .get(["currentQueue", "nowPlaying", "albumQueue", "autoAdvanceAlbums"])
  .then(({ currentQueue, nowPlaying, albumQueue: stored, autoAdvanceAlbums: auto }) => {
    albumQueue = Array.isArray(stored) ? stored : [];
    autoAdvanceAlbums = auto !== false; // default on
    document.getElementById("autoAdvance").checked = autoAdvanceAlbums;
    renderAlbumQueue();
    if (currentQueue) {
      // Resume at the last-played track after a player-tab reload.
      const idx = nowPlaying && typeof nowPlaying.index === "number" ? nowPlaying.index : 0;
      startQueue(currentQueue, idx);
    }
  });

document.getElementById("autoAdvance").addEventListener("change", (e) => {
  autoAdvanceAlbums = e.target.checked;
  chrome.storage.local.set({ autoAdvanceAlbums });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // The background pushes newly queued albums straight to storage.
  if (changes.albumQueue) {
    albumQueue = Array.isArray(changes.albumQueue.newValue) ? changes.albumQueue.newValue : [];
    renderAlbumQueue();
  }
  if (changes.autoAdvanceAlbums) {
    autoAdvanceAlbums = changes.autoAdvanceAlbums.newValue !== false;
    document.getElementById("autoAdvance").checked = autoAdvanceAlbums;
  }
  if (changes.currentQueue && changes.currentQueue.newValue) {
    // Ignore echoes of the writes we made ourselves for in-place queue edits.
    const writeId = changes.currentQueue.newValue.writeId;
    if (writeId && ownWriteIds.has(writeId)) { ownWriteIds.delete(writeId); return; }
    // An append that reached storage rather than this tab (no player in the
    // sender's context, and storage is shared across incognito) only ADDS to the
    // end. Adopt the extra tracks in place — restarting via startQueue would
    // reload the embed and jump the listener back to the top of the song.
    const next = changes.currentQueue.newValue;
    if (isAppendOf(next)) { adoptAppended(next.tracks); return; }
    startQueue(next);
  }
});
