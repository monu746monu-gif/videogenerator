import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureGeneratedFolders } from "@/lib/media";

export type WebsiteAnalysis = {
  productName: string;
  tagline: string;
  description: string;
  features: string[];
  cta: string;
  selectedPages: string[];
};

export function fallbackScript(data: WebsiteAnalysis) {
  const detectedFeatures = Array.isArray(data.features) ? data.features : [];
  const features = detectedFeatures.length ? detectedFeatures.slice(0, 4) : ["a clear product experience", "useful website sections", "simple ways to learn more"];
  const productName = data.productName || "this product";
  const tagline = data.tagline ? ` ${data.tagline}` : "";
  const cta = data.cta || "visit the website to learn more";

  return [
    `Looking for a better way to understand what ${productName} offers?${tagline}`,
    `${productName} presents its main value clearly, with pages that guide visitors through the product, benefits, and next steps.`,
    `Key highlights include ${features.join(", ")}.`,
    `As you move through the site, the experience is designed to help potential customers compare options, understand the offering, and decide whether it fits their needs.`,
    `If it looks useful for your team or workflow, the next step is simple: ${cta}.`
  ].join(" ");
}

export async function generateVoiceScript(data: WebsiteAnalysis) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return fallbackScript(data);
  }

  const prompt = `Write a natural 45-60 second launch/demo video voiceover in simple professional English.
Use 110-140 words.
Start with a hook, introduce the product, explain 3-5 key features and benefits, and end with a CTA.
Avoid excessive hype.

Product: ${data.productName}
Tagline: ${data.tagline}
Description: ${data.description}
Features: ${(Array.isArray(data.features) ? data.features : []).join(", ")}
CTA: ${data.cta}
Important pages: ${(Array.isArray(data.selectedPages) ? data.selectedPages : []).join(", ")}

Return only the voiceover script.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 280
        }
      })
    });

    if (!response.ok) {
      return fallbackScript(data);
    }

    const json = await response.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join(" ").trim();
    return text || fallbackScript(data);
  } catch {
    return fallbackScript(data);
  }
}

type AudioOutputOptions = {
  audioDir?: string;
  audioUrlBase?: string;
};

export async function generateVoiceoverAudio(script: string, options: AudioOutputOptions = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is required to generate voiceover audio for this MVP.");
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: script,
      response_format: "mp3"
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS failed. ${details}`.trim());
  }

  const { audioDir } = options.audioDir ? { audioDir: options.audioDir } : await ensureGeneratedFolders();
  const audioName = `voiceover-${Date.now()}.mp3`;
  const audioPath = path.join(audioDir, audioName);
  await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));

  return {
    audioPath,
    audioUrl: `${options.audioUrlBase || "/generated/audio"}/${audioName}`
  };
}

export async function tryGenerateSceneVoiceoverAudio(script: string, sceneNumber: number, timestamp: number, options: AudioOutputOptions = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return {
      audioPath: "",
      audioUrl: "",
      warning: `Scene ${sceneNumber}: OPENAI_API_KEY is not set, using silent video.`
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: script,
        response_format: "mp3"
      })
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      return {
        audioPath: "",
        audioUrl: "",
        warning: `Scene ${sceneNumber}: TTS failed, using silent video. ${details}`.trim()
      };
    }

    const { audioDir } = options.audioDir ? { audioDir: options.audioDir } : await ensureGeneratedFolders();
    const audioName = `scene-${sceneNumber}-${timestamp}.mp3`;
    const audioPath = path.join(audioDir, audioName);
    await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));

    return {
      audioPath,
      audioUrl: `${options.audioUrlBase || "/generated/audio"}/${audioName}`,
      warning: ""
    };
  } catch (error) {
    return {
      audioPath: "",
      audioUrl: "",
      warning: `Scene ${sceneNumber}: TTS failed, using silent video. ${error instanceof Error ? error.message : ""}`.trim()
    };
  }
}
