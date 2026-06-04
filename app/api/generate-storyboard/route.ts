import { NextResponse } from "next/server";
import { fallbackStoryboard, parseStoryboardJson } from "@/lib/storyboard";
import type { StoryboardScene, WebsiteData } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const data = (await request.json()) as WebsiteData;

    if (!data?.url || !data?.title) {
      return NextResponse.json({ error: "Website data is required." }, { status: 400 });
    }

    const scenes = await generateStoryboard(data);
    return NextResponse.json({ scenes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate storyboard." },
      { status: 500 }
    );
  }
}

async function generateStoryboard(data: WebsiteData): Promise<StoryboardScene[]> {
  const prompt = buildPrompt(data);

  if (process.env.OPENAI_API_KEY) {
    return generateWithOpenAI(prompt);
  }

  if (process.env.GEMINI_API_KEY) {
    return generateWithGemini(prompt);
  }

  return fallbackStoryboard(data);
}

async function generateWithOpenAI(prompt: string): Promise<StoryboardScene[]> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You create concise launch video storyboards. Return only JSON with a scenes array containing exactly five scenes."
        },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI storyboard generation failed with status ${response.status}.`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty storyboard.");
  }

  return parseStoryboardJson(content);
}

async function generateWithGemini(prompt: string): Promise<StoryboardScene[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini storyboard generation failed with status ${response.status}.`);
  }

  const json = await response.json();
  const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    throw new Error("Gemini returned an empty storyboard.");
  }

  return parseStoryboardJson(content);
}

function buildPrompt(data: WebsiteData): string {
  return `Create a 5-scene launch video storyboard for this website.

Return strict JSON:
{
  "scenes": [
    {
      "sceneNumber": 1,
      "headline": "Problem hook",
      "subtext": "Short supporting line",
      "voiceover": "One sentence voiceover",
      "duration": 5,
      "visualDescription": "Use website screenshot with dark overlay"
    }
  ]
}

Rules:
- Exactly 5 scenes.
- Each duration should be 4 to 6 seconds.
- Headlines should be short and punchy.
- No AI avatar, no presenter, no scheduling or posting language.
- Use the website screenshot as the main visual foundation.

Website:
URL: ${data.url}
Title: ${data.title}
Meta description: ${data.description || "None"}
Headings: ${data.headings?.join(" | ") || "None"}
Visible text excerpt: ${(data.text || "").slice(0, 1800)}`;
}
