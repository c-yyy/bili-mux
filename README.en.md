# Bili-Mux (哔哩喵)

<p align="center"><img src="icons/icon-source.jpg" width="128" alt="Bili-Mux Icon"></p>

**English** | [中文](./README.md)

A Manifest V3 Chrome extension that injects a download panel into Bilibili video pages, supporting cover download, DASH audio/video stream saving, in-browser ffmpeg.wasm MP4 muxing, FLV merge download, and multi-part batch download.

> **For personal learning and archival use only. Do not use for mass ripping or redistribution.**

## Quick Install

**Recommended: download the pre-packaged CRX** — [Bili-Mux-v1.1.0.crx](./Bili-Mux-v1.1.0.crx)

1. Download the `.crx` file above.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" (top right).
4. Drag the `.crx` file into the browser window to install.

> To pack the extension yourself, use the `Bili-Mux-v1.1.0.pem` key: `chrome --pack-extension=project_dir --pack-extension-key=Bili-Mux-v1.1.0.pem`.

## Features

| Feature | Description |
|---------|-------------|
| Cover download | Static direct URL, saved via `chrome.downloads` |
| DASH video stream | Video `.m4s` saved separately (up to 4K) |
| DASH audio stream | Audio `.m4s` saved separately |
| In-browser MP4 mux | Fetches audio/video streams, muxes via ffmpeg.wasm (Offscreen Document) into a single MP4 — no local ffmpeg needed |
| FLV merge download | Legacy HTTP-FLV segments binary-concatenated into a playable file; lower bitrate, smaller size |
| Multi-part batch | Select multiple parts (P), batch FLV merge download sequentially |
| Real-time resource usage | Panel shows extension memory and network download speed |

## Installation

1. Clone or download this project.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the project root directory.
5. Open any `bilibili.com/video/` page (must be logged in). A pink "Download" button appears at the end of the video toolbar.

**Requirements**: Chrome 116+ (in-browser muxing depends on the Offscreen Document API).

## Usage

1. Click the pink "Download" button in the Bilibili video toolbar to open the panel.
2. **Mux MP4**: Select quality → click "Mux MP4 (in-browser)" → auto-download when the progress bar completes.
3. **Separate download**: Click "Download video stream" / "Download audio stream" to get `.m4s` files, then merge with local ffmpeg:
   ```bash
   ffmpeg -i video.m4s -i audio.m4s -c copy output.mp4
   ```
4. **FLV merge**: Click "FLV merge download (low bitrate)" to get a playable `.flv` file directly.
5. **Multi-part batch**: Click "Part list" → check parts → "Batch download selected".

## Project Structure

```
bili-downloader/
├── manifest.json            # MV3 manifest: permissions, content_scripts, offscreen, CSP
├── content.js               # Content script injected into Bilibili pages (parsing + panel UI + download)
├── background.js            # Service Worker: chrome.downloads + Offscreen lifecycle management
├── offscreen.js             # Offscreen Document: runs ffmpeg.wasm to mux MP4
├── offscreen.html           # Offscreen page (loads ffmpeg.min.js + offscreen.js)
├── popup.html / .js / .css  # Extension popup: version, instructions, quick links
├── rules.json               # declarativeNetRequest rules: inject Referer header for CDN requests
├── lib/ffmpeg/              # @ffmpeg/ffmpeg 0.11 + @ffmpeg/core-st (single-threaded wasm)
├── icons/                   # Extension icons
└── tools/gen-icons.js       # Icon generation script
```

## Technical Details

### WBI Signing

Bilibili's `playurl` endpoint requires WBI signing. The extension embeds a `MIXIN_TAB` permutation table, fetches `img_url` / `sub_url` from the `nav` endpoint to derive the key, rearranges bits and truncates to 32 chars, then MD5-signs the sorted query string. The key is cached for 10 minutes.

### DASH vs FLV

- **DASH**: Video and audio are separate streams (`.m4s`), supporting original quality up to 4K. Muxing into MP4 requires ffmpeg.
- **FLV**: Legacy HTTP-FLV wraps audio and video in the same container. Multiple segments can be binary-concatenated into a playable file with lower bitrate.

### In-browser ffmpeg.wasm Muxing

Uses `@ffmpeg/ffmpeg` 0.11 + `@ffmpeg/core-st` (single-threaded core), running in an MV3 Offscreen Document:

- The single-threaded core does not depend on `SharedArrayBuffer`, so no COOP/COEP response headers are needed.
- Cross-process binary payloads (content → SW → offscreen) are base64-encoded, since `chrome.runtime.sendMessage` does not support ArrayBuffer serialization.
- After a successful mux, the instance is retained for reuse (`FFMPEG_END` has reset the running flag); it is only destroyed and recreated on failure.
- The progress callback extracts the numeric ratio from the `{ratio, time}` object and filters out NaN before forwarding.

### Referer Injection

Bilibili media CDNs (`bilivideo.com`, etc.) validate the Referer header. Downloads initiated via `chrome.downloads` have no origin page and don't carry a Referer, resulting in 403. Solutions:

- **Stream download** (MP4 mux / separate streams): `fetch` inside the content script (browser auto-attaches Referer) → save as Blob.
- **declarativeNetRequest** (`rules.json`): Injects `Referer: https://www.bilibili.com` for `media` / `xmlhttprequest` requests to `bilivideo` domains.

### Multi-tab Isolation

Each mux request carries a unique `requestId`. `background.js` maintains a `requestId → tabId` mapping and routes results back via `chrome.tabs.sendMessage` to the originating tab, preventing cross-tab interference or duplicate downloads.

## Permissions

| Permission | Purpose |
|------------|---------|
| `downloads` | Call `chrome.downloads.download` to save files |
| `scripting` | Inject content script |
| `declarativeNetRequestWithHostAccess` | Inject Referer rules |
| `offscreen` | Create Offscreen Document for ffmpeg.wasm |
| `host_permissions` (bilibili.com / bilivideo.com / hdslb.com) | Authenticated API fetch + media stream retrieval |

## Disclaimer

This tool only parses streams that the user's account is already authorized to play, for personal archival and learning purposes. Do not use it for mass ripping or redistribution. The user bears all copyright/account risks arising from such use.
