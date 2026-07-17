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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const ctx = await resolveContext(sender);
      if (msg.type === "PLAY_INPUT" || msg.type === "ADD_INPUT") {
        const playlistId = extractPlaylistId(msg.input);
        if (!playlistId) {
          sendResponse({ ok: false, error: "Couldn't find a playlist/album ID in that input." });
          return;
        }
        await play(playlistId, ctx, sendResponse, msg.type === "ADD_INPUT");
      } else if (msg.type === "PLAY_PLAYLIST" || msg.type === "ADD_PLAYLIST") {
        await play(msg.playlistId, ctx, sendResponse, msg.type === "ADD_PLAYLIST");
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

async function play(playlistId, ctx, sendResponse, append = false) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  let tracks = null;
  let usedFallback = false;
  if (apiKey) {
    try {
      tracks = await expandPlaylist(playlistId, apiKey);
      if (!tracks.length) throw new Error("No playable tracks found in this playlist.");
    } catch (e) {
      // Invalid/expired key, exhausted quota, network failure, empty result —
      // don't fail the request; fall back to the keyless path (the IFrame player
      // loads the playlist directly, without a visible track list).
      console.warn("Data API expansion failed; falling back to keyless playback:", e);
      tracks = null;
      usedFallback = true;
    }
  }

  // Append: if we have an expanded track list and a player already exists in
  // this context, push the tracks onto its live queue instead of replacing it.
  // (Direct-playlist mode — no API key — can't merge, so it falls through to a
  // normal replace.)
  if (append && tracks) {
    const incognito = !!ctx.incognito;
    const players = await getPlayerTabs();
    const match = players.find((t) => !!t.incognito === incognito);
    if (match) {
      await chrome.tabs.sendMessage(match.id, { type: "APPEND_TRACKS", tracks });
      await ensurePlayerTab(ctx);
      sendResponse({ ok: true, count: tracks.length, appended: true, usedFallback });
      return;
    }
  }

  // Replacing the queue with a new album: drop any stale resume state so a
  // freshly created player tab starts at track 1 instead of resuming the
  // previous album's position. (A plain tab reload keeps currentQueue, so its
  // nowPlaying survives and reload-resume still works.)
  // No key: fall back to letting the IFrame player load the playlist directly.
  const queue = { playlistId, tracks, ts: Date.now() };
  await chrome.storage.local.remove(["nowPlaying", "playerState"]);
  await chrome.storage.local.set({ currentQueue: queue });
  await ensurePlayerTab(ctx);
  sendResponse({ ok: true, count: tracks ? tracks.length : null, usedFallback });
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
        title,
        channel: it.snippet?.videoOwnerChannelTitle || it.snippet?.channelTitle || "",
        thumb: it.snippet?.thumbnails?.default?.url || ""
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return tracks;
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
