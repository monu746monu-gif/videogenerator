import { NextResponse } from "next/server";
import { generateVoiceoverAudio } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const script = String(body.script || "").trim();
    if (!script) {
      return NextResponse.json({ error: "Voice script is required." }, { status: 400 });
    }

    const audio = await generateVoiceoverAudio(script);
    return NextResponse.json(audio);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate voiceover." },
      { status: 500 }
    );
  }
}
