# Claude Editor

**A free, open-source video editor with an AI editing assistant.** Edit like you would in a traditional editor, or tell the assistant what you want ("cut the dead air", "make a 60-second vertical Short", "add a zoom and a sound effect on the best moment") and approve its plan with one click.

- **Works with huge files.** A 50 GB source is as easy as a 50 MB one. Your video never leaves your computer; the assistant only sees a compact summary.
- **Tuned for your kind of video.** Pick a video type (general, unboxing / pack opening, gaming, vlog, tutorial, sports) and the assistant edits in that style.
- **Fun effects built in.** Zooms, shakes, flashes, holo shimmer, slow motion, freeze frames, bold titles and 8 sound effects.
- **Runs locally** in your browser on Mac, Windows or Linux. You bring your own Anthropic API key.

![The editor: media pool, viewer, assistant panel and multi-track timeline](docs/screenshot.png)

> The assistant is powered by Claude, Anthropic's AI model. This is an independent open-source project, not an official Anthropic product.

## Get started

1. **Download:** on the GitHub page click **Code → Download ZIP**, then unzip it somewhere like your Documents folder. (Or `git clone` it.)
2. **Install the two tools it needs** (one time only):
   - **Node.js:** from [nodejs.org](https://nodejs.org), click the LTS button and run the installer.
   - **FFmpeg:**
     - Windows, in PowerShell: `winget install Gyan.FFmpeg`
     - Mac, after installing [Homebrew](https://brew.sh): `brew install ffmpeg`
     - Linux: `sudo apt install ffmpeg` (or your distro's equivalent)
3. **Start it:** double-click **`Start Claude Editor (Windows).bat`** or **`Start Claude Editor (Mac).command`**. The first start installs a few packages (about a minute), then your browser opens to the editor. Keep the black window open while you edit.
   - On a Mac, if it says Apple "could not verify" the file, click **Done**. Then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. Or start it from Terminal: type `cd ` (with a space), drag the unzipped folder into the window, press Return, then run `bash "Start Claude Editor (Mac).command"`.
   - On Linux, or if you prefer the terminal: `npm install && npm start`, then open http://localhost:5317.
4. **Add your Anthropic API key** for the assistant: click ⚙ in the top right. Get a key at [console.anthropic.com](https://console.anthropic.com). API usage is billed by Anthropic to your account, separately from any Claude.ai subscription. The editor itself works without a key.

**Recommended for talking videos:** install [Whisper](https://github.com/openai/whisper) for transcripts:
- Mac: `brew install openai-whisper`
- Elsewhere: `pip install -U openai-whisper`

Then click **📝 Transcribe** on a video in the media pool. With a transcript the assistant can edit by what's said ("cut the part where I talk about pricing"), add captions, and title your key points. The first run downloads a speech model (about 140 MB).

## Using the assistant

1. Import your footage (**Import media → From disk** is fastest for big files) and double-click it to put it on the timeline.
2. In the Claude panel, set the **Video type**. This changes the assistant's editing style and the quick-action buttons.
3. Click a quick action or type a request. The assistant replies with a plan, such as "remove 14 pauses (38 s)", "flash + sparkle at 1:02" or "freeze frame at 2:31".
4. Review the plan and click **Apply**. Everything is undoable (Ctrl/Cmd+Z), and you can keep editing by hand.

| Video type | The assistant focuses on |
|---|---|
| General | Tight pacing, dead-air removal, effects only where they matter |
| Unboxing / pack opening | Finding the big reveals (from your reactions and the frames) and hyping them with build-up, flash, sparkle, zoom, freeze or slow-mo |
| Gaming | Clutch plays, wins, fails, reactions; cutting menus and loading screens |
| Vlog / talking head | Tight jump cuts, subtle punch-in zooms, key-point titles |
| Tutorial / screen recording | Removing mistakes and waits, step titles, chapters; minimal effects |
| Sports / action | Key plays, slow-motion replays, freeze-frame finishes |

Adding a new type means adding one entry to [`shared/presets.js`](shared/presets.js).

## Features

**Editor**
- Media pool with thumbnails and drag-and-drop; import by path (no copying) or upload
- Viewer playing every track in sync, with timecode and frame stepping
- Multi-track timeline:
  - two effects tracks (FX1/FX2)
  - titles (T1)
  - two video tracks (V2 overlays V1)
  - two audio tracks (A1/A2)
- Filmstrips and waveforms on clips
- Move, trim, blade/split, delete and ripple delete, with snapping, markers, zoom, undo/redo and autosave
- Inspector: timing, source in/out, speed, volume, fit or fill framing, title style, effect type and intensity
- Project formats: 16:9, 9:16, 4:5, 1:1 and 4K, at 23.976 to 60 fps
- Export to H.264/AAC MP4 at draft, standard or high quality, rendered from your original files

**Effects** (from the ✨ Effects and 🔊 Sounds menus, or ask the assistant)
- Zoom punch-in, camera shake, white flash, rainbow holo shimmer, blur, black & white, spotlight vignette, each with adjustable intensity
- Slow motion and speed changes (0.25× to 4×, pitch-corrected audio) and freeze frames. Later material shifts automatically to stay in sync.
- Caption and "impact" (big, bold, outlined) titles
- 8 sound effects synthesized with FFmpeg, so there's nothing to license: whoosh, sparkle chime, pop, bass boom, ka-ching, drumroll, tension riser, air horn

## How it works

```
Your video ──► FFmpeg, on your computer
                 ├─ proxy.mp4        540p copy for smooth editing
                 ├─ thumbnails, waveform
                 ├─ scene cuts, silences, loud moments
                 ├─ keyframes        one JPEG every 2 s (up to 150 per file)
                 └─ transcript       optional, with Whisper
                              │
                              ▼  summary + keyframes (a few MB at most)
                          Claude ──► edit plan (a list of typed operations)
                                          │  you review and click Apply
                                          ▼
Export ◄── FFmpeg renders the timeline from your ORIGINAL full-quality files
```

- **The assistant never receives your video file.** It gets the timeline as JSON, the analysis above and the keyframe images, and replies with a structured plan of 18 operation types (cuts, inserts, effects, sounds, slow motion, freeze frames, titles, markers, format changes…). Every plan is dry-run before you see it. If a step fails, the assistant gets one chance to fix it.
- **The footage block is prompt-cached**, so follow-up requests on the same video cost much less than the first.
- **Exports** cut each clip from the original with a fast seek, apply effects and titles in the same pass, and join the segments losslessly. Memory stays flat with hundreds of cuts.

### Measured performance (4-core Linux machine)

| Source | Import | Preparation | Sent to the assistant |
|---|---|---|---|
| 3 min, 720p | 0.09 s | 58 s | 90 keyframes + analysis (~2.5 MB) |
| 2 min, 1080p, 569 MB | 0.09 s | 33 s | 24 keyframes + analysis (~320 KB) |
| 20 min, 1080p, 1.2 GB | 0.09 s | 4 min 52 s | 140 keyframes + analysis (~1.9 MB) |

A 20-minute export with 60 cuts and a title took 9 min 6 s at standard quality, with exact output length. Machines with more cores are proportionally faster. The design targets videos up to about an hour; longer ones work, but the assistant's visual samples get sparser.

## Privacy

- Your videos stay on your computer. The local server only listens on `127.0.0.1`.
- When you use the assistant, the analysis data, keyframe images (432p stills), your timeline and your message are sent to Anthropic's API under your own API key. Nothing is sent anywhere else, and nothing is sent until you ask the assistant something.
- Your API key is stored in `data/config.json` on your computer.

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

## Contributing

Contributions are welcome: bug reports, new effects, new video types, translations, packaging. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organized and how to add things.

**Roadmap ideas:** a desktop app with an installer (Electron or Tauri, with Node and FFmpeg bundled); animated stickers and particles; transitions and audio fades; color correction and LUTs; word-level transcript editing; more tracks with mute/lock; hardware-accelerated encoding.

## License

[MIT](LICENSE). Use it, change it, share it, sell things you make with it.
