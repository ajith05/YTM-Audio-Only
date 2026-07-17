const $ = (id) => document.getElementById(id);

function setMsg(text, kind) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = kind || "";
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

$("play").addEventListener("click", async () => {
  const input = $("input").value.trim();
  if (!input) { setMsg("Paste an album/playlist URL or ID first.", "err"); return; }
  setMsg("Loading…");
  const res = await send({ type: "PLAY_INPUT", input });
  if (res && res.ok) {
    if (res.usedFallback) setMsg("API key failed — playing playlist directly.", "ok");
    else setMsg(res.count != null ? `Playing ${res.count} tracks.` : "Playing playlist.", "ok");
  } else {
    setMsg((res && res.error) || "Failed to start playback.", "err");
  }
});

$("add").addEventListener("click", async () => {
  const input = $("input").value.trim();
  if (!input) { setMsg("Paste an album/playlist URL or ID first.", "err"); return; }
  setMsg("Adding…");
  const res = await send({ type: "ADD_INPUT", input });
  if (res && res.ok) {
    if (res.usedFallback) setMsg("API key failed — playing playlist directly.", "ok");
    else if (res.appended) setMsg(`Added ${res.count} tracks to the queue.`, "ok");
    else if (res.count != null) setMsg(`Playing ${res.count} tracks.`, "ok");
    else setMsg("Playing playlist (add needs a Data API key).", "ok");
  } else {
    setMsg((res && res.error) || "Failed to add to queue.", "err");
  }
});

$("open").addEventListener("click", () => send({ type: "FOCUS_PLAYER" }));
$("clear").addEventListener("click", async () => {
  await send({ type: "CONTROL", action: "clear" });
  setMsg("Queue cleared.", "ok");
});
$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("prev").addEventListener("click", () => send({ type: "CONTROL", action: "prev" }));
$("next").addEventListener("click", () => send({ type: "CONTROL", action: "next" }));

// Single play/pause toggle. Its label reflects the player's real state (kept in
// storage by player.js); the action sent is the opposite of what's showing.
const PLAYING = 1;
let isPlaying = false;
$("ppause").addEventListener("click", () => {
  send({ type: "CONTROL", action: isPlaying ? "pause" : "play" });
  // Flip optimistically; the storage listener will correct us if it didn't take.
  setPlayPause(!isPlaying);
});
function setPlayPause(playing) {
  isPlaying = playing;
  $("ppause").textContent = playing ? "⏸" : "▶";
  $("ppause").title = playing ? "Pause" : "Play";
}
async function loadPlayState() {
  const { playerState } = await chrome.storage.local.get("playerState");
  setPlayPause(playerState === PLAYING);
}
loadPlayState();

// Allow Enter to trigger playback.
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("play").click(); });

// Show what's currently playing.
async function refreshNow() {
  const { nowPlaying } = await chrome.storage.local.get("nowPlaying");
  if (nowPlaying) {
    // Build with textContent — title/channel come from YouTube metadata and
    // must not be parsed as HTML.
    $("now").innerHTML = "<b></b><br><span></span>";
    $("now").querySelector("b").textContent = nowPlaying.title || "";
    $("now").querySelector("span").textContent =
      `${nowPlaying.channel || ""} · ${nowPlaying.index + 1}/${nowPlaying.total}`;
  } else {
    $("now").textContent = "";
  }
}
refreshNow();
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.nowPlaying) refreshNow();
  if (c.playerState) setPlayPause(c.playerState.newValue === PLAYING);
});
