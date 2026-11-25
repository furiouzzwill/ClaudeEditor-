# Claude Editor

A non-linear video editor (think a lightweight DaVinci Resolve) with Claude built in as an editing assistant. Source files of any size work, including 500 MB, 5 GB or 50 GB, because **the video itself is never sent to Claude**.

![layout: media pool, viewer, Claude panel, multi-track timeline](docs/screenshot.png)

## How it handles huge files

```
Your 20 GB file ──► FFmpeg (on your machine)
                     ├─ proxy.mp4        540p copy for smooth scrubbing
                     ├─ thumbnails        filmstrip for the timeline
                     ├─ waveform          audio peaks
                     ├─ scene cuts        where shots change
                     ├─ silences          pauses in the audio
                     ├─ keyframes         ~1 small JPEG per 8 s (up to 150/file)
                     └─ transcript        optional, with Whisper
                                   │
                                   ▼  (a few hundred KB)
                                Claude ──► edit plan (JSON list of operations)
                                                 │  you review & click Apply
                                                 ▼
Export ◄── FFmpeg renders the timeline from the ORIGINAL full-quality files
```

- **Import by path**: nothing is copied, so a huge file imports instantly. Uploading also works and streams to disk.
- **Editing and playback** use the proxy, so scrubbing stays smooth however big the original is.
- **Export** cuts each clip straight from the original with a fast seek, normalizes it, then joins the segments losslessly. Memory stays flat with hundreds of cuts.

### Tested sizes (4-core Linux machine)

| Source | Import | Prep (proxy and analysis) | Sent to Claude |
|---|---|---|---|
| 2 min, 1080p, 569 MB | 0.09 s | 33 s | ~1 KB text + 24 frames (~320 KB) |
| 20 min, 1080p, 1.2 GB | 0.09 s | 4 min 52 s | ~2 KB text + 140 frames (~1.9 MB) |

Exports come out at exactly the timeline length; a 20-minute timeline with 60 cuts finished at 1121.900 s. A timeline with titles and extra audio tracks only re-encodes each clip once. Picture-in-picture overlays (V2) add one extra full-length pass. Machines with more cores are proportionally faster.

The design targets videos up to an hour or so. Longer ones work, but import takes longer and Claude's visual samples get sparser.

## Features

**Editor**
- Media pool with thumbnails, progress, and drag-and-drop
- Viewer with transport controls and timecode, playing every track in sync
- Multi-track timeline: titles (T1), two video tracks (V1, V2 as overlay), two audio tracks (A1, A2)
- Filmstrips and waveforms on clips
- Move, trim, blade/split, delete and ripple delete, with snapping, markers, and zoom
- Undo/redo and autosave
- Inspector: clip timing, source in/out, volume, fit or fill framing, title text and style, project format and frame rate (16:9, 9:16, 4:5, 1:1, 4K…)
- Export: H.264/AAC MP4 at draft, standard or high quality, with progress and cancel

**Claude assistant**
- Ask in plain English: "remove the silences", "make a 60-second highlight", "vertical 9:16 version", "add chapter markers", "add a title for the first 3 seconds", "what's in this footage?"
- Claude gets the timeline, scene cuts, silences, transcript (if available) and keyframe images. It replies with a plan built from 13 typed operations:
  - `ripple_delete_ranges`, `lift_range`, `split`
  - `insert_media`, `move_clip`, `trim_clip`, `delete_clip`
  - `add_text`, `add_marker`
  - `set_clip_volume`, `set_clip_fit`, `set_format`, `clear_timeline`
- Every plan is dry-run first. If an operation fails, Claude gets one chance to correct it. You see the plan with its before/after duration and click **Apply**. Undo works as usual.

## Requirements

- **Node.js 20+**
- **FFmpeg** with ffprobe on your PATH (`brew install ffmpeg`, `winget install ffmpeg`, `apt install ffmpeg`)
- An **Anthropic API key** for the assistant (console.anthropic.com). The editor works without one.
- Optional: **Whisper**, for transcripts, which let Claude edit by what's said: `pip install -U openai-whisper`

## Run it

```bash
npm install
npm start
# open http://localhost:5317
```

Add your API key under ⚙ Settings, or set `ANTHROPIC_API_KEY` before starting.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / K / L | Play-pause / pause / play |
| ← → (Shift for 1 s) | Step one frame |
| Home / End | Go to start / end |
| S or Ctrl/Cmd+B | Split at playhead |
| B / V | Blade tool / selection tool |
| Delete / Shift+Delete | Delete / ripple delete |
| M | Add marker (Alt+click a marker to remove it) |
| N | Toggle snapping |
| + / − / Shift+Z | Zoom in / out / fit |
| Ctrl/Cmd+Z, Shift+Z | Undo, redo |
| Ctrl/Cmd+I / E / S | Import / export / save |
| Ctrl/Cmd+wheel | Zoom the timeline |

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `5317` | |
| `CLAUDE_EDITOR_DATA` | `./data` | Projects, proxies, exports, settings |
| `ANTHROPIC_API_KEY` | | Or set it in Settings |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | |
| `PROXY_HEIGHT` | `540` | Proxy resolution |
| `MAX_JOBS` | `2` | Concurrent background jobs |
| `WHISPER_CMD`, `WHISPER_MODEL` | `whisper`, `base` | |
| `CLAUDE_EDITOR_FONT` | auto | `.ttf` used for titles in exports |

The server only listens on `127.0.0.1`, since it can read files on your machine.

## Project layout

```
shared/timeline.js   Timeline model and every edit operation (pure functions,
                     used by both the UI and the server)
server/index.js      HTTP API (Express)
server/media.js      Import pipeline: probe, proxy, thumbnails, waveform,
                     scene/silence detection, keyframes, Whisper
server/render.js     Export engine
server/ai.js         Claude integration: context building, structured edit plans
server/jobs.js       Background job queue
public/              The editor UI (plain ES modules, no build step)
test/                Unit tests for the timeline engine (npm test)
```

## Roadmap ideas

- Package as a desktop app (Electron or Tauri) with a native file picker
- Transitions (crossfades, dips to black) and audio fades
- Speed changes, color correction and LUTs via FFmpeg filters
- Word-level transcript editing (delete words to cut video)
- More tracks, track mute/lock, linked A/V clips
- Hardware-accelerated encoding (NVENC, VideoToolbox, QSV)
