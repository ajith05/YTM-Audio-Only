# YTM Audio-Only

A Manifest V3 Chrome extension that plays the audio-only ("art-track") versions of
YouTube Music albums through the official YouTube IFrame embed. Load-unpacked; no build step.

## Intent & compliance guardrails

These are deliberate design constraints, not missing features. Do not "fix" them.

- Plays art tracks **as-is** through the official IFrame embed. **No** stream ripping or
  audio/video separation — that's forbidden by YouTube's developer policy and is the whole
  reason the popular "audio-only" extensions are dead ends (they only hide the video).
- Does **not** block or hide ads. Non-premium playback through the embed shows ads; that is
  expected and must stay. Do not add ad-blocking.
- Does **not** modify or script the live YTM player. The extension only reads the current
  `?list=` id and drives its own separate embed.
- No telemetry/analytics. Keep the permission set minimal.

## Why this works (domain knowledge)

YouTube Music defaults to the *music-video* version of a song and won't let non-premium users
switch to audio-only. But album playlists (`OLAK5uy_…` ids) reference the **art tracks** — the
static-image "Provided to YouTube by…" uploads that *are* the genuine audio-only versions.
Playing those video ids as-is via the IFrame player is the entire trick.

A regular playlist of music videos (`PL…`, `RD…`, etc.) has no audio-only equivalent, so for
those we just play what's there. The album case (`OLAK5uy_`) is what this is built for.

## Two playback modes

- **Track-based** (needs a YouTube Data API v3 key, set on the options page): `expandPlaylist()`
  in [background.js](background.js) pages through `playlistItems.list` to build a visible,
  navigable track list.
- **Keyless fallback**: with no key — or if the key is invalid/quota-exhausted/errors — playback
  degrades to loading the `OLAK5uy_` playlist directly in the embed via `videoseries`, with no
  track list. `background.play()` sets `usedFallback` so the UI can say so.

Both the popup and the injected on-page buttons route through `background.play()`, so both
inherit the fallback.

## Three destinations

`background.play()` takes a `mode` (see the `MODES` table mapping message types to it):

- `replace` — wipe the queue, play now (`PLAY_PLAYLIST` / `PLAY_INPUT`).
- `appendTracks` — concatenate onto the live track list (`ADD_PLAYLIST` / `ADD_INPUT`).
- `queueAlbum` — park the album whole in `albumQueue`, to become the queue when the current
  one runs out (`QUEUE_ALBUM` / `QUEUE_ALBUM_INPUT`).

Both add-modes need an expanded track list, so **keyless playback degrades them to a replace**.
Rather than expose that, both entry points are **gated on `apiKey` being present**: content.js
marks their `BUTTONS` specs `needsKey: true` and skips them in `ensureButton()`, and popup.js
hides `#album` / `#add` in `applyKey()`. Both read `apiKey` on load *and* subscribe to
`chrome.storage.onChanged` — options is a separate page, so without the subscription a key saved
there wouldn't surface the buttons until the next navigation. content.js `update()` therefore
removes unwanted buttons before adding wanted ones, so clearing a key takes them away live.

Presence is all that can be gated on; validity is only knowable at request time. So a stored but
rejected key still reaches the degraded replace, and the `usedFallback` branches in the UIs stay
as the second line of defence — they read `appended` / `queuedAlbum` / `usedFallback` off the
response and say "Replaced" rather than claiming "Added" over a wiped queue. Don't delete those
branches as dead, and don't reintroduce a fixed success label.

Beyond that, each add-mode has one more fall-through, and both are *correct*, not gaps:
`appendTracks` with nothing playing and `queueAlbum` with nothing that can ever end (no queue,
or a keyless one) both just play the album — there is nothing to append to or wait behind.

Appending prefers messaging a live player tab, since the player owns the queue and persists it
itself; going through storage while it's running would race its `persistQueue()`. Only when no
tab takes the message does the background merge into `currentQueue` in storage. The player
recognises such a write via `isAppendOf()` and adopts the new tracks **in place** — calling
`startQueue()` would restart playback from the top of the queue.

The album queue is drained by the player, not the background: `advance()` (used by both the
ENDED handler and the Next button) calls `pullNextAlbum()` at the end of the queue. It re-reads
`albumQueue` from storage before shifting, because normal and incognito windows share storage
and could otherwise claim the same album. `autoAdvanceAlbums` gates this for *both* automatic
and manual advance — with it off, Next stops at the last track.

**Never replace the iframe when a track-mode embed is already playing.** `setEmbed()` destroys and
recreates the element, and the fresh frame has no media-engagement history — so Chrome blocks its
`autoplay=1` whenever the player tab is backgrounded, which stalled every album-queue advance until
the tab was focused. Both `startQueue()` and `playIndex()` therefore branch: `loadVideoById` on the
running embed when there is one, `setEmbed()` only from a cold start. `startQueue()` captures that
decision (`canReuse`) at function entry, *before* the assignments below it overwrite `usingNative` —
it turns on the OUTGOING player, not the incoming queue. Reuse is gated on `!usingNative` in both
directions: a keyless `videoseries` embed can't be switched to a single video by command, and vice
versa, so mode changes still navigate.

`moveAlbum()` mirrors `moveTrack()` for the Up-next panel, but re-reads `albumQueue` from storage
before splicing — the background appends there, so a stale local copy could drop an album queued
mid-drag. It touches only `albumQueue`, never the playing track list: the current album has
already left the queue, so a drag can't disturb it. Album drags use their own `albumDragFrom`
cursor, kept separate from the track list's `dragFrom`. The player's queue rows use `.track`, so
the auto-advance switch's knob is `.sw` — reusing `.track` there would inherit the row padding.
`#upnext[hidden]` restates `display: none` because the `#upnext` ID selector's `display: flex`
otherwise beats the UA's `[hidden]` rule and leaves an emptied panel on screen.

## Architecture

- [background.js](background.js) — service worker: message router, Data API expansion, player-tab
  lifecycle. Holds the load-bearing DNR referrer rule and incognito-context matching (see comments
  there before touching them).
- [player.html](player.html) / [player.js](player.js) — the persistent player tab: hosts the
  IFrame player, owns the queue + UI, keyboard shortcuts.
- [content.js](content.js) — injected on `music.youtube.com`: floating "Play now" / "Add album" /
  "Add tracks" buttons that send the current `?list=` id to the background. The two add buttons
  only render when an `apiKey` is stored.
- [popup.html](popup.html) / [popup.js](popup.js) — paste a URL/id, transport controls.
- [options.html](options.html) / [options.js](options.js) — store the Data API key.

Cross-component state lives in `chrome.storage.local`: `currentQueue`, `albumQueue` (a FIFO of
pending albums), `autoAdvanceAlbums`, `nowPlaying`, `playerState` (a YouTube player-state int;
`PLAYING === 1`), `apiKey`.

Tracks carry their own `playlistId`, so "↗ YTM" opens the album the *playing* track came from —
a queue can mix albums via appends or an album-queue advance, and the queue-wide id would be
wrong. Album names cost a second Data API call (`playlists.list`); `fetchPlaylistTitle()` returns
null on any failure and the UI falls back to `<n> tracks · <channel>`.

## Dev / test workflow

- Load-unpacked at `chrome://extensions` with Developer Mode on.
- **After reloading the extension, also reload any open music.youtube.com tab** — the previous
  content script orphans ("Extension context invalidated") and its buttons stop working.
- `manifest.json` uses `"incognito": "split"`, so a normal-window player and an incognito player
  are separate instances; background.js matches player tabs by incognito context. Note that
  `chrome.storage.local` is **shared** across both, despite split mode — the Data API key set in
  a normal window is already visible in incognito, and `currentQueue` / `nowPlaying` are written
  to the same keys by both.
