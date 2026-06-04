import type { StoryboardScene, WebsiteData } from "@/lib/types";

const fallbackHeadlines = [
  "Meet the product",
  "Built for the problem",
  "What makes it different",
  "See it in action",
  "Launch with confidence"
];

export function fallbackStoryboard(data: WebsiteData): StoryboardScene[] {
  const product = data.title || new URL(data.url).hostname;
  const description = data.description || data.text || "A product designed to help users move faster.";

  return fallbackHeadlines.map((headline, index) => ({
    sceneNumber: index + 1,
    headline: index === 0 ? `Introducing ${product}` : headline,
    subtext: index === 1 ? description.slice(0, 110) : makeSubtext(index, product),
    voiceover: makeVoiceover(index, product, description),
    duration: 5,
    visualDescription: "Use the website screenshot with a dark overlay and clean animated text."
  }));
}

export function parseStoryboardJson(raw: string): StoryboardScene[] {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  const scenes = Array.isArray(parsed) ? parsed : parsed.scenes;

  if (!Array.isArray(scenes) || scenes.length !== 5) {
    throw new Error("AI response did not include exactly five scenes.");
  }

  return scenes.map((scene, index) => ({
    sceneNumber: Number(scene.sceneNumber) || index + 1,
    headline: String(scene.headline || fallbackHeadlines[index] || "Launch scene").slice(0, 90),
    subtext: String(scene.subtext || "").slice(0, 150),
    voiceover: String(scene.voiceover || "").slice(0, 260),
    duration: Math.min(8, Math.max(3, Number(scene.duration) || 5)),
    visualDescription: String(scene.visualDescription || "Use website screenshot with animated text.").slice(0, 180)
  }));
}

function makeSubtext(index: number, product: string): string {
  const lines = [
    `A fast product story generated from ${product}.`,
    "Turn key benefits into a simple launch narrative.",
    "Highlight the site, message, and offer in seconds.",
    "Bring your homepage into motion with crisp overlays.",
    "Export a vertical MP4 ready to share."
  ];
  return lines[index] || lines[0];
}

function makeVoiceover(index: number, product: string, description: string): string {
  const lines = [
    `${product} gives your audience a clear reason to pay attention.`,
    description.slice(0, 180),
    "The experience is designed around the value users notice first.",
    "Every scene uses the website itself as the visual foundation.",
    "Create a concise launch video and share it wherever your audience watches."
  ];
  return lines[index] || lines[0];
}
