import { mkdir } from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { NextResponse } from "next/server";
import type { StoryboardScene } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const scenes = body.storyboard as StoryboardScene[];
    const screenshotPath = String(body.screenshotPath || "");

    if (!Array.isArray(scenes) || scenes.length !== 5) {
      return NextResponse.json({ error: "A five-scene storyboard is required." }, { status: 400 });
    }

    if (!screenshotPath.includes(path.join("public", "generated", "screenshots"))) {
      return NextResponse.json({ error: "A generated screenshot path is required." }, { status: 400 });
    }

    const outputDir = path.join(process.cwd(), "public", "generated", "videos");
    await mkdir(outputDir, { recursive: true });

    const outputName = `${Date.now()}-launch-video.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const entryPoint = path.join(process.cwd(), "remotion", "index.tsx");
    const origin = new URL(request.url).origin;
    const inputProps = {
      scenes,
      screenshotSrc: `${origin}/generated/screenshots/${path.basename(screenshotPath)}`
    };

    const serveUrl = await bundle({ entryPoint });
    const composition = await selectComposition({
      serveUrl,
      id: "LaunchVideo",
      inputProps
    });

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      chromiumOptions: {
        ignoreCertificateErrors: true
      }
    });

    return NextResponse.json({
      videoUrl: `/generated/videos/${outputName}`,
      outputPath
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to render video." },
      { status: 500 }
    );
  }
}
