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

Append (`ADD_PLAYLIST` / `ADD_INPUT`) only truly appends when **both** an expanded track list
exists **and** a player tab already exists in the matching incognito context. Otherwise
`play()` falls through to a full replace. Both UIs read `appended` / `usedFallback` off the
response and say "Replaced" rather than claiming "Added" over a wiped queue — don't reintroduce
a fixed success label.

## Architecture

- [background.js](background.js) — service worker: message router, Data API expansion, player-tab
  lifecycle. Holds the load-bearing DNR referrer rule and incognito-context matching (see comments
  there before touching them).
- [player.html](player.html) / [player.js](player.js) — the persistent player tab: hosts the
  IFrame player, owns the queue + UI, keyboard shortcuts.
- [content.js](content.js) — injected on `music.youtube.com`: floating "Audio-only" / "Add to
  queue" buttons that send the current `?list=` id to the background.
- [popup.html](popup.html) / [popup.js](popup.js) — paste a URL/id, transport controls.
- [options.html](options.html) / [options.js](options.js) — store the Data API key.

Cross-component state lives in `chrome.storage.local`: `currentQueue`, `nowPlaying`,
`playerState` (a YouTube player-state int; `PLAYING === 1`), `apiKey`.

## Dev / test workflow

- Load-unpacked at `chrome://extensions` with Developer Mode on.
- **After reloading the extension, also reload any open music.youtube.com tab** — the previous
  content script orphans ("Extension context invalidated") and its buttons stop working.
- `manifest.json` uses `"incognito": "split"`, so a normal-window player and an incognito player
  are separate instances; background.js matches player tabs by incognito context. Note that
  `chrome.storage.local` is **shared** across both, despite split mode — the Data API key set in
  a normal window is already visible in incognito, and `currentQueue` / `nowPlaying` are written
  to the same keys by both.
