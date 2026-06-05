import { execFile } from "node:child_process";
import { access, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const jobIdPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const oneHourMs = 60 * 60 * 1000;

export type VideoJob = {
  jobId: string;
  rootDir: string;
  recordingsDir: string;
  audioDir: string;
  scenesDir: string;
  screenshotsDir: string;
  finalDir: string;
  dataDir: string;
};

void cleanupOldVideoJobs().catch((error) => {
  console.warn("[media] startup job cleanup failed", error);
});

export async function ensureGeneratedFolders() {
  const root = path.join(process.cwd(), "public", "generated");
  const recordingsDir = path.join(root, "recordings");
  const videosDir = path.join(root, "videos");
  const audioDir = path.join(root, "audio");
  const scenesDir = path.join(root, "scenes");

  await Promise.all([
    mkdir(recordingsDir, { recursive: true }),
    mkdir(videosDir, { recursive: true }),
    mkdir(audioDir, { recursive: true }),
    mkdir(scenesDir, { recursive: true })
  ]);

  return { recordingsDir, videosDir, audioDir, scenesDir };
}

export function generatedJobsRoot() {
  return path.join(process.cwd(), "public", "generated", "jobs");
}

export function isValidJobId(jobId: string) {
  return jobIdPattern.test(jobId);
}

export async function createVideoJob(): Promise<VideoJob> {
  await cleanupOldVideoJobs();

  const jobId = crypto.randomUUID();
  const rootDir = safeJobDir(jobId);
  const job = {
    jobId,
    rootDir,
    recordingsDir: path.join(rootDir, "recordings"),
    audioDir: path.join(rootDir, "audio"),
    scenesDir: path.join(rootDir, "scenes"),
    screenshotsDir: path.join(rootDir, "screenshots"),
    finalDir: path.join(rootDir, "final"),
    dataDir: path.join(rootDir, "data")
  };

  await Promise.all([
    mkdir(job.recordingsDir, { recursive: true }),
    mkdir(job.audioDir, { recursive: true }),
    mkdir(job.scenesDir, { recursive: true }),
    mkdir(job.screenshotsDir, { recursive: true }),
    mkdir(job.finalDir, { recursive: true }),
    mkdir(job.dataDir, { recursive: true })
  ]);

  return job;
}

export function safeJobDir(jobId: string) {
  if (!isValidJobId(jobId)) {
    throw new Error("Invalid jobId.");
  }

  const root = path.resolve(generatedJobsRoot());
  const jobDir = path.resolve(root, jobId);
  if (jobDir !== path.join(root, jobId) || !jobDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid job path.");
  }
  return jobDir;
}

export function finalVideoPathForJob(jobId: string) {
  return path.join(safeJobDir(jobId), "final", "final-video.mp4");
}

export async function deleteVideoJob(jobId: string) {
  const root = path.resolve(generatedJobsRoot());
  const jobDir = safeJobDir(jobId);
  if (!jobDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to delete outside generated jobs.");
  }

  await rm(jobDir, { recursive: true, force: true });
}

export async function cleanupOldVideoJobs(now = Date.now()) {
  const root = generatedJobsRoot();
  await mkdir(root, { recursive: true });

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isValidJobId(entry.name))
      .map(async (entry) => {
        const jobDir = safeJobDir(entry.name);
        const info = await stat(jobDir).catch(() => null);
        if (!info || now - info.mtimeMs < oneHourMs) return;
        await rm(jobDir, { recursive: true, force: true });
      })
  );
}

export async function convertToMp4(inputPath: string, outputPath: string) {
  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(
      `Failed to convert Playwright recording to MP4. Install ffmpeg or set FFMPEG_PATH. ${
        error instanceof Error ? error.message : ""
      }`.trim()
    );
  }
}

export async function mergeAudioWithVideo(videoPath: string, audioPath: string, outputPath: string) {
  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to merge voiceover with video. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function mergeSceneAudioWithVideo(videoPath: string, audioPath: string, outputPath: string) {
  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-filter_complex",
      "[0:v:0]tpad=stop_mode=clone:stop_duration=8,format=yuv420p[v]",
      "-map",
      "[v]",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to sync scene audio with video. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function mergeSceneAudioAndEffectsWithVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options: { clickSoundPath?: string; clickAtSecond?: number } = {}
) {
  if (!options.clickSoundPath) {
    await mergeSceneAudioWithVideo(videoPath, audioPath, outputPath);
    return;
  }

  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;
  const clickDelayMs = Math.max(0, Math.round((options.clickAtSecond || 2) * 1000));

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-i",
      options.clickSoundPath,
      "-filter_complex",
      `[0:v:0]tpad=stop_mode=clone:stop_duration=8,format=yuv420p[v];[2:a]adelay=${clickDelayMs}|${clickDelayMs},volume=0.55[click];[1:a][click]amix=inputs=2:duration=first:dropout_transition=0[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to mix scene audio effects. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function mergeClickSoundWithVideo(videoPath: string, clickSoundPath: string, outputPath: string, clickAtSecond = 2) {
  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;
  const clickDelayMs = Math.max(0, Math.round(clickAtSecond * 1000));

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      clickSoundPath,
      "-filter_complex",
      `[0:v:0]format=yuv420p[v];[1:a]adelay=${clickDelayMs}|${clickDelayMs},volume=0.55[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to add click sound. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function ensureClickSound() {
  const soundDir = path.join(process.cwd(), "public", "sounds");
  const soundPath = path.join(soundDir, "click.mp3");
  await mkdir(soundDir, { recursive: true });
  try {
    await access(soundPath);
    return { soundPath, warning: "" };
  } catch {
    // Generate a short, local click-like tone so the app does not need a permanent asset download.
  }

  const ffmpegPath = await findFfmpeg();
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1800:duration=0.035",
      "-af",
      "afade=t=out:st=0.02:d=0.015,volume=0.28",
      soundPath
    ]);
    return { soundPath, warning: "" };
  } catch (error) {
    return {
      soundPath: "",
      warning: `Click sound skipped. ${error instanceof Error ? error.message : ""}`.trim()
    };
  }
}

export async function getMediaDurationSeconds(filePath: string) {
  const ffprobePath = await findFfprobe();
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

export async function copyVideoWithoutAudio(inputPath: string, outputPath: string) {
  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-an",
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to prepare silent scene video. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function concatVideos(inputPaths: string[], outputPath: string) {
  if (!inputPaths.length) {
    throw new Error("No scene videos were created.");
  }

  const ffmpegPath = await findFfmpeg();
  const tempPath = `${outputPath}.tmp.mp4`;
  const listPath = `${outputPath}.concat.txt`;
  const listContent = inputPaths.map((inputPath) => `file '${inputPath.replace(/'/g, "'\\''")}'`).join("\n");

  try {
    await writeFile(listPath, listContent);
    await execFileAsync(ffmpegPath, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      tempPath
    ]);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to combine scene videos. ${error instanceof Error ? error.message : ""}`.trim());
  } finally {
    await unlink(listPath).catch(() => undefined);
  }
}

export async function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Install ffmpeg or set FFMPEG_PATH to create MP4 videos.");
}

async function findFfprobe() {
  const envProbe = process.env.FFPROBE_PATH;
  const ffmpegPath = await findFfmpeg();
  const derivedProbe = ffmpegPath.endsWith("ffmpeg") ? `${ffmpegPath.slice(0, -6)}ffprobe` : "";
  const candidates = [envProbe, derivedProbe, "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Install ffprobe or set FFPROBE_PATH to inspect media duration.");
}
