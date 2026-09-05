// Service worker: message router, Data API expansion, player-tab management.

const PLAYER_URL = chrome.runtime.getURL("player.html");

// --- Fix YouTube embed referrer (errors 153/152) --------------------------
// Chrome strips the Referer on embeds loaded from chrome-extension:// pages,
// so YouTube rejects playback. Set a Referer via declarativeNetRequest for the
// embed sub-frame requests our player tab makes.
// Scoped to the /embed path only: this is what our player loads. YTM never
// loads /embed/ frames, so the rule can't affect normal YTM browsing (which is
// what was dropping its nav icons when the rule matched YTM's own sub-frames).
const DNR_RULE = {
  id: 1,
  condition: {
    initiatorDomains: [chrome.runtime.id],
    urlFilter: "||www.youtube.com/embed",
    resourceTypes: ["sub_frame"]
  },
  action: {
    type: "modifyHeaders",
    requestHeaders: [{ header: "referer", value: "https://example.com/", operation: "set" }]
  }
};

function installDnrRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [DNR_RULE.id],
    addRules: [DNR_RULE]
  });
}
chrome.runtime.onInstalled.addListener(installDnrRules);
chrome.runtime.onStartup.addListener(installDnrRules);

// The three destinations an album can go to. "replace" wipes the queue and plays
// now; "appendTracks" concatenates onto the live track list; "queueAlbum" parks
// the album whole in albumQueue, to become the queue when the current one ends.
const MODES = {
  PLAY_INPUT: "replace",
  PLAY_PLAYLIST: "replace",
  ADD_INPUT: "appendTracks",
  ADD_PLAYLIST: "appendTracks",
  QUEUE_ALBUM_INPUT: "queueAlbum",
  QUEUE_ALBUM: "queueAlbum"
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const ctx = await resolveContext(sender);
      const mode = MODES[msg.type];
      if (msg.type.endsWith("_INPUT")) {
        const playlistId = extractPlaylistId(msg.input);
        if (!playlistId) {
          sendResponse({ ok: false, error: "Couldn't find a playlist/album ID in that input." });
          return;
        }
        await play(playlistId, ctx, sendResponse, mode);
      } else if (mode) {
        await play(msg.playlistId, ctx, sendResponse, mode);
      } else if (msg.type === "CONTROL") {
        if (msg.action === "clear") {
          await chrome.storage.local.remove(["currentQueue", "nowPlaying", "playerState"]);
        }
        for (const t of await getPlayerTabs()) {
          try { await chrome.tabs.sendMessage(t.id, msg); } catch (_) {}
        }
        sendResponse({ ok: true });
      } else if (msg.type === "FOCUS_PLAYER") {
        await ensurePlayerTab(ctx);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

async function play(playlistId, ctx, sendResponse, mode = "replace") {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  let tracks = null;
  let title = null;
  let usedFallback = false;
  if (apiKey) {
    try {
      tracks = await expandPlaylist(playlistId, apiKey);
      if (!tracks.length) throw new Error("No playable tracks found in this playlist.");
      // Best-effort: the album name isn't in the playlistItems response, so it
      // costs a second request. A failure here must never fail the whole
      // operation — the UI falls back to "<n> tracks · <channel>".
      title = await fetchPlaylistTitle(playlistId, apiKey);
    } catch (e) {
      // Invalid/expired key, exhausted quota, network failure, empty result —
      // don't fail the request; fall back to the keyless path (the IFrame player
      // loads the playlist directly, without a visible track list).
      console.warn("Data API expansion failed; falling back to keyless playback:", e);
      tracks = null;
      usedFallback = true;
    }
  }

  // Without an expanded track list there's nothing to merge or park, so both
  // add-modes degrade to a plain replace (keyless playback can't do either).
  if (tracks && mode !== "replace") {
    const current = await currentTrackQueue();

    if (mode === "appendTracks") {
      // Prefer the live player when one exists: it owns the queue and writes it
      // back itself, so going through storage here could race its persistQueue().
      // A tab that's still loading has no listener yet, so this can throw —
      // fall through to the storage merge below rather than failing the click.
      const match = await matchingPlayerTab(ctx);
      let delivered = false;
      if (match) {
        try {
          await chrome.tabs.sendMessage(match.id, { type: "APPEND_TRACKS", tracks });
          delivered = true;
        } catch (e) {
          console.warn("Player tab didn't take APPEND_TRACKS; merging via storage:", e);
        }
      }
      if (delivered) {
        await ensurePlayerTab(ctx);
        sendResponse({ ok: true, count: tracks.length, title, appended: true, usedFallback });
        return;
      }
      // No live player took it, but a real track queue is sitting in storage:
      // merge into it there and let the player pick it up when it opens.
      if (current) {
        await mergeIntoStoredQueue(current, tracks);
        await ensurePlayerTab(ctx);
        sendResponse({ ok: true, count: tracks.length, title, appended: true, usedFallback });
        return;
      }
      // Nothing to append to — fall through to a replace.
    }

    if (mode === "queueAlbum" && current) {
      // Something is playing that can actually exhaust, so park this album
      // behind it. (With no such queue we fall through and just play it now.)
      const { albumQueue } = await chrome.storage.local.get("albumQueue");
      const queue = Array.isArray(albumQueue) ? albumQueue : [];
      queue.push({ playlistId, title, tracks, ts: Date.now() });
      await chrome.storage.local.set({ albumQueue: queue });
      // Make sure a player exists to eventually drain it — without one the album
      // would sit queued behind a queue that never plays.
      await ensurePlayerTab(ctx);
      sendResponse({
        ok: true, count: tracks.length, title, queuedAlbum: true, position: queue.length
      });
      return;
    }
  }

  // Replacing the queue with a new album: drop any stale resume state so a
  // freshly created player tab starts at track 1 instead of resuming the
  // previous album's position. (A plain tab reload keeps currentQueue, so its
  // nowPlaying survives and reload-resume still works.)
  // No key: fall back to letting the IFrame player load the playlist directly.
  const queue = { playlistId, title, tracks, ts: Date.now() };
  await chrome.storage.local.remove(["nowPlaying", "playerState"]);
  await chrome.storage.local.set({ currentQueue: queue });
  await ensurePlayerTab(ctx);
  sendResponse({ ok: true, count: tracks ? tracks.length : null, title, usedFallback });
}

// The stored queue, but only when it's a real track list. A keyless (direct
// playlist) queue reports no tracks: it never reaches an end-of-queue event, so
// nothing can be appended to it or parked behind it.
async function currentTrackQueue() {
  const { currentQueue } = await chrome.storage.local.get("currentQueue");
  if (currentQueue && Array.isArray(currentQueue.tracks) && currentQueue.tracks.length) {
    return currentQueue;
  }
  return null;
}

// Append to the stored queue when no live player took the message. The player
// tags its own writes with a writeId and ignores their echoes; ours needs no tag
// (a player in the other incognito context SHOULD reload the queue) but it must
// keep nowPlaying valid — appending leaves the playing index untouched, so the
// resume position still points at the right track.
async function mergeIntoStoredQueue(current, tracks) {
  await chrome.storage.local.set({
    currentQueue: {
      ...current,
      tracks: current.tracks.concat(tracks),
      ts: Date.now(),
      writeId: undefined
    }
  });
}

async function matchingPlayerTab(ctx) {
  const incognito = !!ctx.incognito;
  const players = await getPlayerTabs();
  return players.find((t) => !!t.incognito === incognito) || null;
}

// --- Request context (which window opened the request) --------------------
// Used so the player tab opens in the same window — e.g. the same Incognito
// window — that the user is browsing in.
async function resolveContext(sender) {
  if (sender && sender.tab) {
    return { windowId: sender.tab.windowId, incognito: !!sender.tab.incognito };
  }
  // Popup messages have no sender.tab. The popup belongs to the focused window,
  // so use that window's active tab — it reports incognito reliably (unlike
  // windows.getLastFocused from the service worker).
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) return { windowId: tab.windowId, incognito: !!tab.incognito };
  } catch (_) {}
  return { windowId: undefined, incognito: false };
}

// --- Player tab lifecycle -------------------------------------------------

async function getPlayerTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.url && t.url.startsWith(PLAYER_URL));
}

async function ensurePlayerTab(ctx = {}) {
  const incognito = !!ctx.incognito;
  const players = await getPlayerTabs();
  // Single instance: reuse the player only if it's in the matching incognito
  // context. A player in the wrong context (e.g. a normal-window one when we
  // need Incognito) is closed so playback always lands in the right window.
  const match = players.find((t) => !!t.incognito === incognito);
  const strays = players.filter((t) => !match || t.id !== match.id).map((t) => t.id);
  if (strays.length) { try { await chrome.tabs.remove(strays); } catch (_) {} }

  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    try { await chrome.windows.update(match.windowId, { focused: true }); } catch (_) {}
    return match.id;
  }
  const props = { url: PLAYER_URL };
  if (ctx.windowId != null) props.windowId = ctx.windowId;
  const tab = await chrome.tabs.create(props);
  return tab.id;
}

// --- YouTube Data API v3 --------------------------------------------------

async function expandPlaylist(playlistId, apiKey) {
  const tracks = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.message || `${res.status} ${res.statusText}`;
      throw new Error(`Data API error: ${reason}`);
    }
    const data = await res.json();
    for (const it of data.items || []) {
      const videoId = it.contentDetails?.videoId;
      const privacy = it.status?.privacyStatus;
      const title = it.snippet?.title || "";
      // Skip unavailable items (deleted/private show up with placeholder titles).
      if (!videoId) continue;
      if (privacy === "private") continue;
      if (title === "Deleted video" || title === "Private video") continue;
      tracks.push({
        videoId,
        playlistId,
        title,
        channel: it.snippet?.videoOwnerChannelTitle || it.snippet?.channelTitle || "",
        thumb: it.snippet?.thumbnails?.default?.url || ""
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return tracks;
}

// The album name lives on the playlist resource, not on its items, so it needs
// its own request (1 more quota unit per album). Returns null rather than
// throwing: a missing title only costs a nicer label.
async function fetchPlaylistTitle(playlistId, apiKey) {
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", playlistId);
    url.searchParams.set("key", apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    return data?.items?.[0]?.snippet?.title || null;
  } catch (e) {
    console.warn("Couldn't fetch the playlist title:", e);
    return null;
  }
}

// --- Input parsing --------------------------------------------------------

function extractPlaylistId(input) {
  if (!input) return null;
  input = String(input).trim();
  // Bare playlist ID (no slashes/spaces).
  if (/^(OLAK5uy_|PL|VL|RD|LL|FL|UU|MPRE)/.test(input) && !/[\/\s]/.test(input)) {
    return input.replace(/^VL/, "");
  }
  // URL containing ?list=...
  try {
    const u = new URL(input);
    const list = u.searchParams.get("list");
    if (list) return list.replace(/^VL/, "");
  } catch (_) {}
  return null;
}
