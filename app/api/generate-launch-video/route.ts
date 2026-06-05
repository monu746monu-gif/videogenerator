import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { cleanupOldVideoJobs, createVideoJob, mergeAudioWithVideo } from "@/lib/media";
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
    const job = await createVideoJob();

    console.log("[generate-launch-video] analyzing website");
    const analysis = await postJson<WebsiteAnalysis>(`${origin}/api/analyze-url`, { url });
    await writeFile(path.join(job.dataDir, "website-analysis.json"), JSON.stringify(analysis, null, 2));

    console.log("[generate-launch-video] recording walkthrough");
    const recording = await postJson<RecordResponse>(`${origin}/api/record-website`, {
      url,
      selectedPages: analysis.selectedPages,
      jobId: job.jobId
    });

    console.log("[generate-launch-video] writing voice script");
    const script = await generateVoiceScript(analysis);
    await writeFile(path.join(job.dataDir, "voiceover-script.txt"), script);

    console.log("[generate-launch-video] generating voiceover");
    const { audioPath } = await generateVoiceoverAudio(script, {
      audioDir: job.audioDir,
      audioUrlBase: `/generated/jobs/${job.jobId}/audio`
    });

    console.log("[generate-launch-video] creating final video");
    const outputPath = path.join(job.finalDir, "final-video.mp4");
    await mergeAudioWithVideo(recording.outputPath, audioPath, outputPath);

    await cleanupOldVideoJobs();
    return NextResponse.json({
      success: true,
      jobId: job.jobId,
      videoUrl: `/api/download-video?jobId=${job.jobId}`,
      previewUrl: `/generated/jobs/${job.jobId}/final/final-video.mp4`,
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
  } finally {
    await cleanupOldVideoJobs().catch(() => undefined);
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
