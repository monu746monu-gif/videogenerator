import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { cleanupOldVideoJobs, deleteVideoJob, finalVideoPathForJob, isValidJobId } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await cleanupOldVideoJobs();

  const jobId = new URL(request.url).searchParams.get("jobId") || "";
  if (!isValidJobId(jobId)) {
    return NextResponse.json({ success: false, error: "Invalid jobId." }, { status: 400 });
  }

  const filePath = finalVideoPathForJob(jobId);
  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) {
    return NextResponse.json({ success: false, error: "Video not found or already deleted." }, { status: 404 });
  }

  const fileStream = createReadStream(filePath);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk) => {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
      });
      fileStream.on("end", () => {
        controller.close();
        void deleteVideoJob(jobId).catch((error) => {
          console.error("[download-video] failed to delete job", jobId, error);
        });
      });
      fileStream.on("error", (error) => {
        controller.error(error);
      });
    },
    cancel() {
      fileStream.destroy();
    }
  });

  return new Response(body, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="launch-video.mp4"',
      "Content-Length": String(fileInfo.size),
      "Cache-Control": "no-store"
    }
  });
}
