// Built-in sound effects, synthesized with FFmpeg on first use (no samples
// to license or ship). Each one is imported into a project as a normal audio
// media item the first time it is used there.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { run, FFMPEG } from "./ffmpeg.js";
import { DATA } from "./store.js";
import { SOUND_EFFECTS } from "../shared/timeline.js";

const SFX_DIR = path.join(DATA, "sfx");

// lavfi recipes: [source, duration, extra audio filters]
const RECIPES = {
  whoosh: ["anoisesrc=c=pink:a=0.9:r=48000", 0.9, "bandpass=f=1400:width_type=h:w=1800,afade=t=in:d=0.45:curve=exp,afade=t=out:st=0.45:d=0.45:curve=exp,volume=2.2"],
  sparkle: [
    "aevalsrc='0.35*sin(2*PI*1568*t)*exp(-5*t)+0.3*sin(2*PI*2093*t)*exp(-6*(t-0.09))*gte(t,0.09)+0.3*sin(2*PI*2637*t)*exp(-6*(t-0.18))*gte(t,0.18)+0.25*sin(2*PI*3136*t)*exp(-7*(t-0.27))*gte(t,0.27)':s=48000",
    1.4,
    "aecho=0.8:0.5:60:0.3",
  ],
  pop: ["aevalsrc='0.9*sin(2*PI*(900-700*t/0.09)*t)*exp(-45*t)':s=48000", 0.18, ""],
  boom: ["aevalsrc='0.95*sin(2*PI*(70-30*t)*t)*exp(-2.5*t)+0.25*(random(0)*2-1)*exp(-30*t)':s=48000", 1.6, "lowpass=f=900"],
  cash: [
    "aevalsrc='(0.45*sin(2*PI*2490*t)+0.3*sin(2*PI*3730*t))*exp(-7*t)+(0.45*sin(2*PI*2960*t)+0.3*sin(2*PI*4430*t))*exp(-7*(t-0.13))*gte(t,0.13)+0.3*(random(0)*2-1)*exp(-80*t)':s=48000",
    1.0,
    "",
  ],
  drumroll: ["aevalsrc='(random(0)*2-1)*0.6*exp(-70*mod(t,0.055))*(0.35+0.65*t/2)':s=48000", 2.0, "lowpass=f=2500,highpass=f=120,afade=t=out:st=1.85:d=0.15"],
  riser: ["aevalsrc='0.3*sin(2*PI*(150*t+200*t*t))*(t/2)+0.12*(random(0)*2-1)*(t/2)':s=48000", 2.0, "highpass=f=100,afade=t=out:st=1.9:d=0.1"],
  airhorn: [
    "aevalsrc='0.22*(sin(2*PI*440*t)+0.6*sin(2*PI*880*t)+0.4*sin(2*PI*1320*t)+0.9*sin(2*PI*554*t)+0.5*sin(2*PI*1108*t))*min(1,t*25)':s=48000",
    1.1,
    "afade=t=out:st=0.85:d=0.25,acompressor",
  ],
};

for (const [k, v] of Object.entries(SOUND_EFFECTS)) {
  if (!RECIPES[k]) throw new Error(`Missing SFX recipe: ${k}`);
  if (RECIPES[k][1] !== v.duration) throw new Error(`SFX duration mismatch: ${k}`);
}

export async function sfxFile(name) {
  const r = RECIPES[name];
  if (!r) throw Object.assign(new Error(`Unknown sound effect: ${name}`), { status: 400 });
  await fsp.mkdir(SFX_DIR, { recursive: true });
  const file = path.join(SFX_DIR, `${name}.wav`);
  if (fs.existsSync(file)) return file;
  const [src, dur, af] = r;
  const raw = file + ".raw.wav";
  const tmp = file + ".tmp.wav";
  await run(FFMPEG, [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", src,
    "-t", String(dur),
    "-af", ["aformat=channel_layouts=stereo", af].filter(Boolean).join(","),
    "-ar", "48000", "-c:a", "pcm_s16le", raw,
  ]);
  // Normalize every sound to the same peak (-3 dB) so they're equally punchy.
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-nostdin", "-i", raw, "-af", "volumedetect", "-f", "null", "-"]);
  const peak = Number(stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? -3);
  await run(FFMPEG, ["-hide_banner", "-nostdin", "-y", "-i", raw, "-af", `volume=${(-3 - peak).toFixed(2)}dB,alimiter=limit=0.95`, "-c:a", "pcm_s16le", tmp]);
  await fsp.rm(raw, { force: true });
  await fsp.rename(tmp, file);
  return file;
}
