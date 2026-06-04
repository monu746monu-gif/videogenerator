import { NextResponse } from "next/server";
import { generateVoiceScript, type WebsiteAnalysis } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const data = (await request.json()) as WebsiteAnalysis;
    const script = await generateVoiceScript(data);

    return NextResponse.json({ script });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate voice script." },
      { status: 500 }
    );
  }
}
