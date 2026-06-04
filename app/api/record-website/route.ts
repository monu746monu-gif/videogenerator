import { execFile } from "node:child_process";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeHttpUrl } from "@/lib/url";

const execFileAsync = promisify(execFile);
const viewport = { width: 1080, height: 1920 };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let recordedPath: string | undefined;

  try {
    const body = await request.json();
    const url = normalizeHttpUrl(String(body.url || ""));

    const outputDir = path.join(process.cwd(), "public", "generated", "recordings");
    await mkdir(outputDir, { recursive: true });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport,
      recordVideo: {
        dir: outputDir,
        size: viewport
      },
      userAgent: "Mozilla/5.0 Website Walkthrough Recorder MVP"
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => undefined);
    await page.locator("body").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(2000);

    await recordWalkthrough(page);

    const video = page.video();
    await context.close();
    context = undefined;

    recordedPath = await video?.path();
    if (!recordedPath) {
      throw new Error("Playwright did not produce a recording.");
    }

    const outputName = `${Date.now()}-${safeHost(url)}-walkthrough.mp4`;
    const outputPath = path.join(outputDir, outputName);
    await convertToMp4(recordedPath, outputPath);
    await unlink(recordedPath).catch(() => undefined);

    return NextResponse.json({
      videoUrl: `/generated/recordings/${outputName}`,
      outputPath
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record website walkthrough." },
      { status: 500 }
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function recordWalkthrough(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);

  const scrollTargets = await page.evaluate((height) => {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - height);
    const sectionTops = Array.from(document.querySelectorAll("main, section, article, h1, h2"))
      .map((element) => {
        const top = element.getBoundingClientRect().top + window.scrollY;
        return Math.max(0, Math.min(maxScroll, Math.round(top - 120)));
      })
      .filter((top) => top > 0);

    const pageSteps = Array.from({ length: Math.ceil(maxScroll / Math.round(height * 0.65)) }, (_, index) =>
      Math.min(maxScroll, Math.round((index + 1) * height * 0.65))
    );

    return Array.from(new Set([...sectionTops, ...pageSteps, maxScroll]))
      .sort((a, b) => a - b)
      .filter((top, index, values) => index === 0 || top - values[index - 1] > 220)
      .slice(0, 12);
  }, viewport.height);

  for (const target of scrollTargets) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "smooth" }), target);
    await page.waitForTimeout(1600);
  }

  await page.waitForTimeout(1500);
}

async function convertToMp4(inputPath: string, outputPath: string) {
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

async function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    path.join(process.cwd(), "node_modules", "@remotion", "compositor-darwin-arm64", "ffmpeg")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Install ffmpeg or set FFMPEG_PATH to convert Playwright recordings to MP4.");
}

function safeHost(value: string): string {
  return new URL(value).hostname.replace(/[^a-z0-9.-]/gi, "-").slice(0, 48);
}
