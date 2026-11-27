# Contributing

Thanks for helping out! This project aims to stay **simple to run and simple to hack on**:
- no build step
- plain ES modules in the browser
- a small Express server
- FFmpeg for all media work

## Development setup

```bash
npm install
npm run dev      # restarts the server when files change
npm test         # unit tests (no FFmpeg or API key needed)
```

Open http://localhost:5317. You need Node.js 20+ and FFmpeg on your PATH. To try the assistant, add an Anthropic API key in ⚙ Settings or set `ANTHROPIC_API_KEY`.

## How the code is organized

```
shared/timeline.js   The timeline model and every edit operation. Pure functions,
                     used by both the browser and the server. Start here.
shared/presets.js    Video types: assistant guidance + quick actions per genre
shared/graphics.js   Animated graphics templates (outro, subscribe, logo reveal…).
                     Pure canvas drawing code used by both preview and export.
shared/brand.js      The app's name (one place to change it)
server/index.js      HTTP API
server/media.js      Import pipeline: probe, proxy, thumbnails, waveform,
                     scene/silence/loud-moment detection, keyframes, Whisper
server/render.js     Export engine (segments → lossless join → optional composite)
server/ai.js         Assistant: context building, prompt, output schema, dry runs
server/sfx.js        Built-in sound effects (synthesized with FFmpeg)
server/jobs.js       Background job queue
public/js/           The editor UI: timeline (canvas), viewer, inspector,
                     media pool, assistant panel, dialogs
test/                node:test unit tests
```

Key ideas:
- **Every edit is a pure function** from project to project (`shared/timeline.js`). Undo/redo is a snapshot stack, and the assistant's plans are lists of these operations, so the UI and the assistant can't drift apart.
- **Edit with proxies, render from originals.** The viewer plays the 540p proxies; the export reads the original files.
- **Preview and export must match.** Each effect has a CSS version in `public/js/viewer.js` (`applyEffects`) and an FFmpeg version in `server/render.js` (`segmentEffects`). Change both together.

## Common contributions

**A new video type:** add an entry to `VIDEO_TYPES` in `shared/presets.js`, with a label, guidance for the assistant and 3–6 quick actions. Keep the guidance short and concrete: what the good moments are, how to find them (loud moments, keyframes, transcript) and which effects suit them.

**A new animated graphics template:** add an entry to `GRAPHICS` in `shared/graphics.js`. It needs a label, a description, a default duration, editable fields and a `draw({ ctx, t, d, W, H, p, logo, makeCanvas })` function. That's all: the 🎬 menu, the Inspector, the export and the assistant's schema pick it up automatically.
- Draw in project pixels, scaled by `S = Math.min(W, H) / 1080`, so it works at any resolution and in vertical video.
- Use the easing helpers and keep motion fast and clean (most entrances take 0.3–0.6 s).
- Make it a pure function of `t`: no randomness and no state between frames. The export renders each frame independently.
- Use only the bundled fonts (`F(weight, px)`), so the export matches the preview.

**A new visual effect:**
1. Add it to `EFFECT_TYPES` in `shared/timeline.js`, with a label and default intensity.
2. Add the FFmpeg filter in `segmentEffects` in `server/render.js`.
3. Add the CSS preview in `applyEffects` in `public/js/viewer.js`.
4. Add a default length in `EFFECT_LENGTH` in `public/js/main.js`.

The assistant's schema picks up new effect types automatically.

**A new sound effect:**
1. Add it to `SOUND_EFFECTS` in `shared/timeline.js`.
2. Add an FFmpeg `lavfi` recipe in `server/sfx.js`. Durations must match; the server checks this at startup.

Please keep sounds synthesized (or CC0 with attribution) so there's nothing to license.

**A new assistant operation:** implement it in `applyOperation` in `shared/timeline.js` and add a test. Then add its schema in `OPERATIONS_SCHEMA` and its required fields in `PlanZ` (both in `server/ai.js`), and a description in `describeOp` in `public/js/assistant.js`. The plan schema is sent as a regular (non-strict) tool, `propose_edit_plan`, not as `output_config.format` or a strict tool. Those modes compile the schema into a grammar, and a schema this size goes over the API's grammar limit ("The compiled grammar is too large"). The editor validates every plan with zod and dry-runs it instead, so keep the `PlanZ` checks in step with the schema.

## Pull requests

- Run `npm test` and add tests for timeline logic you touch.
- For rendering changes, export a short test video and check the output, e.g. `ffprobe` for exact duration and a few frames with `ffmpeg -vf select=...`.
- Keep PRs focused and describe what you tested.
- Don't commit anything from `data/` (projects, media, API keys); it's in `.gitignore`.
