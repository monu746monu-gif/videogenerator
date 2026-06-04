import { execFile } from "node:child_process";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ensureGeneratedFolders() {
  const root = path.join(process.cwd(), "public", "generated");
  const recordingsDir = path.join(root, "recordings");
  const videosDir = path.join(root, "videos");
  const audioDir = path.join(root, "audio");

  await Promise.all([
    mkdir(recordingsDir, { recursive: true }),
    mkdir(videosDir, { recursive: true }),
    mkdir(audioDir, { recursive: true })
  ]);

  return { recordingsDir, videosDir, audioDir };
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
