import { spawn } from "node:child_process";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// Run a command, collecting stdout/stderr. Rejects on non-zero exit.
export function run(cmd, args, { onStdout, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (onStdout) onStdout(d);
      else stdout += d;
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      onStderr?.(s);
    });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("Cancelled"));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.split("\n").slice(-8).join("\n")}`));
    });
  });
}

// Run ffmpeg and report progress (0..1) against a known output duration.
export function ffmpeg(args, { duration, onProgress, signal } = {}) {
  const full = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args];
  let buf = "";
  return run(FFMPEG, full, {
    signal,
    onStdout: (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const [k, v] = line.split("=");
        if ((k === "out_time_us" || k === "out_time_ms") && duration && onProgress) {
          const t = Number(v) / 1e6;
          if (Number.isFinite(t)) onProgress(Math.min(1, Math.max(0, t / duration)));
        }
      }
    },
  });
}

export async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = info.streams.find((s) => s.codec_type === "audio");
  const parseRate = (r) => {
    if (!r) return 0;
    const [n, d] = r.split("/").map(Number);
    return d ? n / d : n;
  };
  let width = v?.width ?? 0;
  let height = v?.height ?? 0;
  const rotation = Math.abs(
    Number(v?.tags?.rotate ?? v?.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0)
  );
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const isImage = !!v && ["png", "mjpeg", "bmp", "webp", "tiff"].includes(v.codec_name) && !a && (Number(info.format.duration) || 0) < 0.1;
  return {
    duration: Number(info.format.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    size: Number(info.format.size) || 0,
    format: info.format.format_name,
    hasVideo: !!v,
    hasAudio: !!a,
    isImage,
    width,
    height,
    fps: parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate) || 0,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    sampleRate: Number(a?.sample_rate) || 0,
    channels: a?.channels ?? 0,
  };
}
