import path from "node:path";
import { NextResponse } from "next/server";
import { ensureGeneratedFolders, mergeAudioWithVideo } from "@/lib/media";
import { normalizeHttpUrl } from "@/lib/url";
import { generateVoiceoverAudio, generateVoiceScript, type WebsiteAnalysis } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RecordResponse = {
  success: boolean;
  videoUrl: string;
  outputPath: string;
  visitedPages: string[];
  selectedPages: string[];
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const url = normalizeHttpUrl(String(body.url || ""));
    const origin = new URL(request.url).origin;

    console.log("[generate-launch-video] analyzing website");
    const analysis = await postJson<WebsiteAnalysis>(`${origin}/api/analyze-url`, { url });

    console.log("[generate-launch-video] recording walkthrough");
    const recording = await postJson<RecordResponse>(`${origin}/api/record-website`, {
      url,
      selectedPages: analysis.selectedPages
    });

    console.log("[generate-launch-video] writing voice script");
    const script = await generateVoiceScript(analysis);

    console.log("[generate-launch-video] generating voiceover");
    const { audioPath } = await generateVoiceoverAudio(script);

    console.log("[generate-launch-video] creating final video");
    const { videosDir } = await ensureGeneratedFolders();
    const outputName = `final-launch-video-${Date.now()}.mp4`;
    const outputPath = path.join(videosDir, outputName);
    await mergeAudioWithVideo(recording.outputPath, audioPath, outputPath);

    return NextResponse.json({
      success: true,
      videoUrl: `/generated/videos/${outputName}`,
      script,
      productName: analysis.productName,
      tagline: analysis.tagline,
      selectedPages: recording.selectedPages?.length ? recording.selectedPages : analysis.selectedPages,
      visitedPages: recording.visitedPages
    });
  } catch (error) {
    console.error("[generate-launch-video] failed", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to generate launch video." },
      { status: 500 }
    );
  }
}

async function postJson<T>(endpoint: string, payload: unknown): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.error || `Request failed: ${endpoint}`);
  }

  return json;
}
