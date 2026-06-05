import { NextResponse } from "next/server";
import {
  compactText,
  fixedSceneTypes,
  normalizeVideoRoute,
  type VideoRoute,
  type WebsiteMap,
  type WebsiteSection
} from "@/lib/video-route";
import { normalizeHttpUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { url?: unknown; websiteMap?: unknown };
    const url = normalizeHttpUrl(String(body.url || ""));
    const websiteMap = body.websiteMap as WebsiteMap;

    if (!websiteMap?.pages?.length) {
      throw new Error("websiteMap is required.");
    }

    console.log("[generate-video-route] generating route for", url);
    const routeInput = (await generateRouteWithGemini(websiteMap)) || fallbackRoute(websiteMap);
    const voiceoverWarnings = findVoiceoverWarnings(routeInput);
    const videoRoute = normalizeVideoRoute(routeInput, websiteMap);

    return NextResponse.json({ success: true, videoRoute, warnings: voiceoverWarnings });
  } catch (error) {
    console.error("[generate-video-route] failed", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to generate video route." },
      { status: 500 }
    );
  }
}

async function generateRouteWithGemini(websiteMap: WebsiteMap): Promise<Partial<VideoRoute> | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn("[generate-video-route] GEMINI_API_KEY missing, using fallback route");
    return null;
  }

  const prompt = `You are an AI Director creating a premium guided product launch demo, not a plain website recording.
First understand the whole website: product name, tagline, feature sections, CTAs, page flow, and visual identity.
Use the detected website color theme as the creative direction for the intro and feature emphasis.
The app will first show a 5-second white intro screen: logo/name slides from the right into the center, then one hero line appears below it.
Analyze this website map and return ONLY valid JSON matching this schema:
{
  "productName": "string",
  "tagline": "string",
  "targetAudience": "string",
  "mainPromise": "string",
  "scenes": [
    {
      "sceneNumber": 1,
      "sceneType": "string",
      "title": "string",
      "pageUrl": "string",
      "targetText": "exact heading or visible text from websiteMap when possible",
      "sectionId": "string when possible",
      "targetElementType": "hero | feature_card | process_step | button | pricing_card | testimonial | cta",
      "visualAction": "open_page | scroll_to_section | zoom_to_element | highlight_element | hover_and_click | feature_showcase | process_zoom",
      "cameraMovement": "slow_zoom | scroll_then_zoom | focus_highlight | click_focus | slide_in | step_zoom",
      "interaction": "none | hover | click",
      "overlayText": "string",
      "voiceover": "1-2 simple natural English sentences",
      "estimatedDurationSeconds": 4-10,
      "clickAtSecond": 2,
      "fallbackAction": "string"
    }
  ]
}

Create 5-6 website scenes, max 7. The app will add the 5-second logo intro and a short outro automatically. Total finished video length must stay near 60 seconds or less.
Fixed scene intent order:
${fixedSceneTypes.map((sceneType, index) => `${index + 1}. ${sceneType}`).join("\n")}

Visual direction rules:
- Use websiteMap.brand.name as productName when available.
- Use websiteMap.brand.heroHeadline or heroSubheadline as tagline/mainPromise when available.
- The first generated website scene after the intro should open the website and establish the hero briefly.
- The next 2-3 website scenes should be feature scenes. Use visualAction "feature_showcase" and cameraMovement "slide_in"; the renderer will blur the website background and slide the feature screenshot onto screen.
- The final 2 website scenes should explain how to use the website or workflow. Use visualAction "process_zoom" and cameraMovement "step_zoom"; the renderer will zoom into the visible step/action or CTA.
- Do not show the hero section again after the first website scene unless it contains the only useful feature.
- Do not create random full-page scrolling scenes.
- Each scene must focus one visible target section, card, heading, price, testimonial, button, or CTA.
- Use visualAction "zoom_to_element" or "highlight_element" for feature scenes.
- Use visualAction "hover_and_click" and interaction "click" only for safe internal CTA-style links.
- Good click targets include learn more, view demo, features, pricing, contact, and get started only when it stays internal.
- Avoid login, signup, checkout, cart, payment, auth, external, social, and file-download links.

Voiceover rules:
- Voiceover must explain only what is visible in the selected target section.
- For feature_showcase scenes, sentence one should describe the visible feature; sentence two should explain how a user would use it, only if that use is visible from the section text or button labels.
- Do not repeat the same sentence.
- Do not use the phrase "the focus here is".
- Do not use the phrase "introduces one clear idea".
- Do not start multiple scenes with the same wording.
- Do not mention features that are not in that target section.
- Each scene must explain only one unique idea.
- Voiceover should sound like a human product launch narrator.
- Use simple English.
- Keep each scene voiceover 1-2 sentences.
- Avoid filler words and generic repetition.
- Use exact pageUrl values from websiteMap.
- Use exact sectionId values from websiteMap when possible.
- Use targetText from a heading or text in websiteMap when possible.
- If the website has fewer meaningful sections, use fewer stronger scenes instead of repeating.

websiteMap:
${JSON.stringify(summarizeWebsiteMap(websiteMap), null, 2)}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 2400,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      console.warn("[generate-video-route] Gemini failed", await response.text().catch(() => ""));
      return null;
    }

    const json = await response.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) return null;
    return JSON.parse(stripJsonFence(text)) as Partial<VideoRoute>;
  } catch (error) {
    console.warn("[generate-video-route] Gemini parsing failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function fallbackRoute(websiteMap: WebsiteMap): Partial<VideoRoute> {
  const sections = meaningfulSections(websiteMap).slice(0, 10);
  const homepage = websiteMap.pages[0];
  const productName = compactText(websiteMap.brand?.name || homepage?.sections[0]?.heading || homepage?.title || new URL(websiteMap.startUrl).hostname, 80);
  const tagline = compactText(websiteMap.brand?.heroSubheadline || websiteMap.brand?.heroHeadline || homepage?.metaDescription || homepage?.sections[0]?.text || "", 140);
  const usableSections = orderFallbackSections(sections, websiteMap);

  return {
    productName,
    tagline,
    targetAudience: "Website visitors",
    mainPromise: compactText(usableSections[2]?.text || usableSections[0]?.text || tagline, 140),
    scenes: usableSections.slice(0, Math.min(6, Math.max(5, usableSections.length))).map((section, index) => {
      const visualAction = fallbackVisualAction(section, index);
      return {
      sceneNumber: index + 1,
      sceneType: fallbackSceneType(section, index),
      title: section.heading || fixedSceneTypes[index] || `Scene ${index + 1}`,
      pageUrl: section.url,
      targetText: section.heading || section.text,
      sectionId: section.id,
      targetElementType: inferFallbackElementType(section, index),
      visualAction,
      cameraMovement: visualAction === "feature_showcase" ? "slide_in" : visualAction === "process_zoom" ? "step_zoom" : index === 0 ? "slow_zoom" : "focus_highlight",
      interaction: shouldClickFallback(section, index) ? "click" : index === 0 ? "none" : "hover",
      overlayText: section.heading || productName,
      voiceover: voiceForSection(section, productName),
      estimatedDurationSeconds: index === 0 ? 6 : 7,
      clickAtSecond: shouldClickFallback(section, index) ? 2 : undefined,
      fallbackAction: "Open the page, center the matching element, and show a premium focus highlight."
    };
    })
  };
}

function summarizeWebsiteMap(websiteMap: WebsiteMap) {
  return {
    startUrl: websiteMap.startUrl,
    brand: websiteMap.brand,
    theme: websiteMap.theme,
    selectedPages: websiteMap.selectedPages,
    pages: websiteMap.pages.map((page) => ({
      url: page.url,
      title: page.title,
      metaDescription: page.metaDescription,
      sections: page.sections.slice(0, 10).map((section) => ({
        id: section.id,
        heading: section.heading,
        text: compactText(section.text, 260),
        buttonTexts: section.buttonTexts,
        index: section.index,
        top: section.top,
        height: section.height
      }))
    }))
  };
}

function meaningfulSections(websiteMap: WebsiteMap) {
  return websiteMap.pages
    .flatMap((page) => page.sections)
    .filter((section) => section.heading || section.text)
    .sort((a, b) => {
      if (a.url === websiteMap.startUrl && b.url !== websiteMap.startUrl) return -1;
      if (b.url === websiteMap.startUrl && a.url !== websiteMap.startUrl) return 1;
      return a.url.localeCompare(b.url) || a.index - b.index;
    });
}

function orderFallbackSections(sections: WebsiteSection[], websiteMap: WebsiteMap) {
  const hero = websiteMap.pages[0]?.sections[0] || sections[0];
  const features = sections.filter((section) => /feature|benefit|tool|dashboard|automation|manage|track|integrat|collaborat|report|insight/i.test(`${section.heading} ${section.text}`));
  const process = sections.filter((section) => /how it works|how-it-works|workflow|step|process|use|setup|create|connect|start|install/i.test(`${section.heading} ${section.text}`));
  const rest = sections.filter((section) => section !== hero && !features.includes(section) && !process.includes(section));
  return uniqueSections([hero, ...features.slice(0, 4), ...process.slice(0, 3), ...rest]);
}

function uniqueSections(sections: Array<WebsiteSection | undefined>) {
  const seen = new Set<string>();
  const output: WebsiteSection[] = [];
  for (const section of sections) {
    if (!section) continue;
    const key = `${section.url}-${section.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(section);
  }
  return output;
}

function voiceForSection(section: WebsiteSection, productName: string) {
  const visibleText = compactText(section.text || section.heading, 180);
  if (!visibleText) return `${productName} gives visitors a clear next step.`;
  if (section.heading) return `${section.heading}: ${visibleText}`;
  return visibleText;
}

function stripJsonFence(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
}

function inferFallbackElementType(section: WebsiteSection, index: number) {
  const text = `${section.heading} ${section.text} ${section.buttonTexts.join(" ")}`.toLowerCase();
  if (index === 0) return "hero";
  if (/how it works|how-it-works|workflow|step|process|use|setup|create|connect|start|install/.test(text)) return "process_step";
  if (/price|plan|billing|subscription/.test(text)) return "pricing_card";
  if (/testimonial|customer|review|trusted|proof/.test(text)) return "testimonial";
  if (/contact|get started|book|demo|start|try|launch/.test(text)) return "cta";
  return "feature_card";
}

function fallbackVisualAction(section: WebsiteSection, index: number) {
  const text = `${section.heading} ${section.text}`.toLowerCase();
  if (index === 0) return "open_page";
  if (/how it works|how-it-works|workflow|step|process|use|setup|create|connect|start|install/.test(text)) return "process_zoom";
  if (/feature|benefit|tool|dashboard|automation|manage|track|integrat|collaborat|report|insight/.test(text) || index <= 4) return "feature_showcase";
  return "zoom_to_element";
}

function fallbackSceneType(section: WebsiteSection, index: number) {
  const text = `${section.heading} ${section.text}`.toLowerCase();
  if (index === 0) return "Hero / product name / banner headline";
  if (/how it works|workflow|step|process|use|setup|create|connect|start|install/.test(text)) return "How to use / workflow step";
  if (index <= 4) return `Feature ${index}`;
  return fixedSceneTypes[index] || `Scene ${index + 1}`;
}

function shouldClickFallback(section: WebsiteSection, index: number) {
  if (index < 2) return false;
  return section.buttonTexts.some((buttonText) => /learn more|view demo|features|pricing|contact|get started|start|try/i.test(buttonText));
}

function findVoiceoverWarnings(videoRoute: Partial<VideoRoute>) {
  const seen = new Set<string>();
  const warnings: string[] = [];
  const bannedPhrases = ["the focus here is", "this section shows", "this feature allows users to", "introduces one clear idea"];
  for (const scene of videoRoute.scenes || []) {
    const voiceover = String(scene.voiceover || "");
    const normalized = voiceover.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    if (normalized && seen.has(normalized)) {
      warnings.push("Repeated voiceover lines were removed during route cleanup.");
      break;
    }
    seen.add(normalized);
  }
  if ((videoRoute.scenes || []).some((scene) => bannedPhrases.some((phrase) => String(scene.voiceover || "").toLowerCase().includes(phrase)))) {
    warnings.push("Overused narration phrases were removed during route cleanup.");
  }
  return warnings;
}
