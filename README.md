# YTM Audio-Only

A Chrome extension that plays the **audio-only** versions of YouTube Music albums —
without a premium subscription.

YouTube Music defaults to the music-video version of a song and won't let non-premium users
switch to audio-only. But album playlists (`OLAK5uy_…`) reference the **art tracks** — the
static-image "Provided to YouTube by…" uploads that *are* the genuine audio-only versions of
each song. This extension plays those, as-is, through the official YouTube embedded player in
its own tab, so audio keeps going while you browse.

## Features

- Play any YouTube Music album or playlist as audio-only in a dedicated player tab.
- A floating **▶ Audio-only** / **＋ Add to queue** button on `music.youtube.com` album pages.
- Paste an album/playlist URL or id into the toolbar popup.
- Queue with prev / next, play-pause, and a visible track list.
- Keyboard shortcuts on the player tab:
  - **Space** — play / pause
  - **← / →** — previous / next track
  - **Shift + ← / →** — seek 5s back / forward
- Works with or without a YouTube Data API key (see below).

## Install (load-unpacked)

There's no build step.

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder.
4. The **YTM Audio-Only** icon appears in your toolbar.

## Usage

**From YouTube Music:** open an album or playlist. A floating **▶ Audio-only** button appears —
click it to start audio-only playback in the player tab, or **＋ Add to queue** to append it to
what's already playing.

**From the popup:** click the toolbar icon, paste an album/playlist URL or id, and hit
**Play audio-only** (or **Add to queue**).

## Data API key (optional)

The extension works out of the box in a **keyless** mode: it hands the album playlist straight
to the embedded player and lets it play through. There's no visible track list in this mode.

Adding a free **YouTube Data API v3** key unlocks the richer experience — a full, navigable
track list built from the playlist:

1. In the [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API
   v3**, then create an API key.
2. Open the extension's **Options** page (right-click the toolbar icon → Options, or the link in
   the popup) and paste the key.

If the key is missing, invalid, or its quota is exhausted, playback automatically falls back to
the keyless mode.

Note that **＋ Add to queue** can only append when a key is set *and* a player tab is already
open. Otherwise it replaces the current queue, and the button says "Replaced" to make that clear.

**Privacy:** your API key is stored locally in your browser (`chrome.storage.local`) and is only
ever sent to Google's YouTube Data API to look up playlist tracks. The extension has no server,
no telemetry, and no analytics.

## How it works & scope

- Playback runs through the **official YouTube IFrame embed**. There is no stream ripping or
  audio/video separation.
- Non-premium playback through the embed **shows ads** — the extension does not (and will not)
  block them.
- It does not modify the live YouTube Music player; it only reads the album/playlist id that's
  currently open and drives its own separate embed.
- Album pages (`OLAK5uy_…`) are the intended case. A regular playlist of music videos has no
  audio-only equivalent, so those play as-is.

## Notes

- After reloading the extension at `chrome://extensions`, **also reload any open
  music.youtube.com tab** — otherwise the on-page buttons stop responding.
- The player opens in its own normal tab so audio persists while you keep browsing.

## Disclaimer

This is an unofficial, independent project. It is not affiliated with, endorsed by, or
sponsored by YouTube, YouTube Music, or Google. "YouTube" and "YouTube Music" are trademarks
of Google LLC. All audio and content are played through YouTube's official embedded player and
remain subject to YouTube's Terms of Service.

## License

[MIT](LICENSE) © Ajith Kanumuri
