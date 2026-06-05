import type { Page } from "playwright";

export const maxMappedPages = 6;
export const maxWebsiteScenes = 7;
export const maxScenes = 9;
export const maxTotalRouteSeconds = 60;

export type WebsiteSection = {
  id: string;
  url: string;
  heading: string;
  text: string;
  buttonTexts: string[];
  index: number;
  top: number;
  height: number;
};

export type WebsiteMapPage = {
  url: string;
  title: string;
  metaDescription: string;
  sections: WebsiteSection[];
};

export type WebsiteBrand = {
  name: string;
  logoText: string;
  logoUrl?: string;
  heroHeadline: string;
  heroSubheadline: string;
};

export type WebsiteTheme = {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  fontFamily: string;
  colorPalette: string[];
};

export type WebsiteMap = {
  startUrl: string;
  origin: string;
  selectedPages: string[];
  pages: WebsiteMapPage[];
  brand?: WebsiteBrand;
  theme?: WebsiteTheme;
};

export type VideoScene = {
  sceneNumber: number;
  sceneType: string;
  title: string;
  pageUrl: string;
  targetText: string;
  sectionId?: string;
  targetElementType: "hero" | "feature_card" | "process_step" | "button" | "pricing_card" | "testimonial" | "cta";
  visualAction:
    | "open_intro"
    | "open_page"
    | "scroll_to_section"
    | "zoom_to_element"
    | "highlight_element"
    | "hover_and_click"
    | "feature_showcase"
    | "process_zoom"
    | "outro";
  cameraMovement: "fade_in" | "slide_in" | "slow_zoom" | "scroll_then_zoom" | "focus_highlight" | "click_focus" | "step_zoom" | "fade_out";
  interaction: "none" | "hover" | "click";
  overlayText: string;
  voiceover: string;
  estimatedDurationSeconds: number;
  clickAtSecond?: number;
  fallbackAction: string;
};

export type VideoRoute = {
  productName: string;
  tagline: string;
  targetAudience: string;
  mainPromise: string;
  scenes: VideoScene[];
};

export const fixedSceneTypes = [
  "Hero / product name / banner headline",
  "Problem or pain point",
  "Main promise / most important benefit",
  "Feature 1",
  "Feature 2",
  "Feature 3",
  "How it works / workflow",
  "Use case / audience / proof",
  "Pricing / offer / trust",
  "CTA / final action"
];

const overusedPhrasePatterns = ["the focus here is", "this section shows", "this feature allows users to", "introduces one clear idea"];

export function compactText(value: unknown, maxLength = 280) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function clampSceneDuration(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(8, Math.max(2, Math.round(parsed)));
}

export function normalizeVideoRoute(input: Partial<VideoRoute>, websiteMap: WebsiteMap): VideoRoute {
  const sections = websiteMap.pages.flatMap((page) => page.sections);
  const homepage = websiteMap.pages[0];
  const fallbackProduct = compactText(websiteMap.brand?.name || homepage?.sections[0]?.heading || homepage?.title || new URL(websiteMap.startUrl).hostname, 80);
  const rawScenes = Array.isArray(input.scenes) ? input.scenes : [];
  let websiteScenes: VideoScene[] = rawScenes
    .filter((scene) => !["intro", "outro"].includes(String(scene?.sceneType || "").toLowerCase()))
    .slice(0, maxWebsiteScenes)
    .map((scene, index) => {
    const fallbackSection = sections[index] || sections[0];
    const pageUrl = isMappedPageUrl(scene?.pageUrl, websiteMap) ? String(scene.pageUrl) : fallbackSection?.url || websiteMap.startUrl;
    const targetText = compactText(scene?.targetText || fallbackSection?.heading || fallbackSection?.text || fallbackProduct, 160);

    return {
      sceneNumber: index + 1,
      sceneType: compactText(scene?.sceneType || fixedSceneTypes[index] || `Scene ${index + 1}`, 80),
      title: compactText(scene?.title || targetText || `Scene ${index + 1}`, 80),
      pageUrl,
      targetText,
      sectionId: typeof scene?.sectionId === "string" ? scene.sectionId : fallbackSection?.id,
      targetElementType: normalizeEnum(scene?.targetElementType, ["hero", "feature_card", "process_step", "button", "pricing_card", "testimonial", "cta"], inferElementType(fallbackSection, index)),
      visualAction: normalizeEnum(
        scene?.visualAction,
        ["open_intro", "open_page", "scroll_to_section", "zoom_to_element", "highlight_element", "hover_and_click", "feature_showcase", "process_zoom", "outro"],
        inferVisualAction(fallbackSection, index)
      ),
      cameraMovement: normalizeEnum(
        scene?.cameraMovement,
        ["fade_in", "slide_in", "slow_zoom", "scroll_then_zoom", "focus_highlight", "click_focus", "step_zoom", "fade_out"],
        inferCameraMovement(fallbackSection, index)
      ),
      interaction: normalizeEnum(scene?.interaction, ["none", "hover", "click"], inferInteraction(scene, fallbackSection, index)),
      overlayText: compactText(scene?.overlayText || scene?.title || targetText, 90),
      voiceover: sanitizeVoiceover(compactText(scene?.voiceover || voiceForSection(fallbackSection, fallbackProduct), 260)),
      estimatedDurationSeconds: clampSceneDuration(scene?.estimatedDurationSeconds),
      clickAtSecond: normalizeClickSecond(scene?.clickAtSecond),
      fallbackAction: compactText(scene?.fallbackAction || "Open the page, center the matching element, and show a focused highlight.", 140)
    } satisfies VideoScene;
  });

  if (!websiteScenes.length) {
    websiteScenes = sections.slice(0, Math.min(maxWebsiteScenes, Math.max(5, sections.length))).map((section, index) => ({
      sceneNumber: index + 1,
      sceneType: fixedSceneTypes[index] || `Scene ${index + 1}`,
      title: section.heading || `Scene ${index + 1}`,
      pageUrl: section.url,
      targetText: section.heading || section.text,
      sectionId: section.id,
      targetElementType: inferElementType(section, index),
      visualAction: inferVisualAction(section, index),
      cameraMovement: inferCameraMovement(section, index),
      interaction: inferInteraction({}, section, index),
      overlayText: section.heading || fallbackProduct,
      voiceover: voiceForSection(section, fallbackProduct),
      estimatedDurationSeconds: index === 0 ? 6 : 7,
      clickAtSecond: inferInteraction({}, section, index) === "click" ? 2 : undefined,
      fallbackAction: "Open the page, center the matching element, and show a focused highlight."
    }));
  }

  websiteScenes = cleanupRepeatedVoiceovers(websiteScenes);
  const productName = compactText(input.productName || fallbackProduct, 80);
  const tagline = compactText(input.tagline || websiteMap.brand?.heroSubheadline || websiteMap.brand?.heroHeadline || homepage?.metaDescription || "", 140);
  const scenes = fitRouteDuration([
    introScene(productName, tagline, websiteMap.startUrl),
    ...websiteScenes,
    outroScene(productName, websiteMap.startUrl)
  ]).map((scene, index) => ({ ...scene, sceneNumber: index + 1 }));

  return {
    productName,
    tagline,
    targetAudience: compactText(input.targetAudience || "Website visitors", 80),
    mainPromise: compactText(input.mainPromise || scenes[2]?.voiceover || scenes[0]?.voiceover || "", 140),
    scenes
  };
}

export function cleanupRepeatedVoiceovers(scenes: VideoScene[]) {
  const seenSentences = new Set<string>();
  const phraseCounts = new Map<string, number>();

  return scenes.map((scene) => {
    const cleanedSentences = splitSentences(scene.voiceover)
      .map((sentence) => removeOverusedPhrases(sentence, phraseCounts))
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((sentence) => {
        const normalized = normalizeSentence(sentence);
        if (!normalized || seenSentences.has(normalized)) return false;
        seenSentences.add(normalized);
        return true;
      });

    const fallback = compactText(`${scene.title}. ${scene.overlayText}`, 180);
    return {
      ...scene,
      voiceover: compactText(cleanedSentences.join(" ") || fallback, 260)
    };
  });
}

export async function injectOverlay(page: Page, text: string) {
  await page.evaluate((overlayText) => {
    const existing = document.getElementById("__synced_video_overlay");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "__synced_video_overlay";
    overlay.textContent = overlayText;
    overlay.style.position = "fixed";
    overlay.style.left = "50%";
    overlay.style.bottom = "48px";
    overlay.style.transform = "translateX(-50%)";
    overlay.style.maxWidth = "880px";
    overlay.style.padding = "22px 28px";
    overlay.style.borderRadius = "14px";
    overlay.style.background = "rgba(17, 24, 39, 0.88)";
    overlay.style.color = "white";
    overlay.style.font = "700 34px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    overlay.style.lineHeight = "1.18";
    overlay.style.textAlign = "center";
    overlay.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.28)";
    overlay.style.zIndex = "2147483647";
    overlay.style.pointerEvents = "none";
    document.documentElement.appendChild(overlay);
  }, text);
}

export async function highlightTargetElement(page: Page, targetText: string, sectionId?: string) {
  return page.evaluate(
    ({ targetText, sectionId }) => {
      const previous = document.querySelector("[data-synced-video-highlight='true']") as HTMLElement | null;
      if (previous) {
        previous.style.outline = previous.dataset.syncedOriginalOutline || "";
        previous.style.boxShadow = previous.dataset.syncedOriginalBoxShadow || "";
        previous.removeAttribute("data-synced-video-highlight");
      }

      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const needle = normalize(targetText || "");
      let element: HTMLElement | null = null;

      if (sectionId) {
        element = document.querySelector(`[data-synced-section-id="${CSS.escape(sectionId)}"]`) as HTMLElement | null;
      }

      if (!element && needle) {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("section, main, header, article, div, h1, h2, h3"));
        element =
          candidates.find((candidate) => normalize(candidate.textContent || "").includes(needle)) ||
          candidates.find((candidate) => needle.includes(normalize(candidate.textContent || "").slice(0, 120))) ||
          null;
      }

      if (!element) return false;

      const target = element.closest("section, article, header, main, div") as HTMLElement | null;
      const highlight = target || element;
      highlight.dataset.syncedOriginalOutline = highlight.style.outline;
      highlight.dataset.syncedOriginalBoxShadow = highlight.style.boxShadow;
      highlight.dataset.syncedVideoHighlight = "true";
      highlight.style.outline = "6px solid rgba(20, 184, 166, 0.95)";
      highlight.style.boxShadow = "0 0 0 12px rgba(20, 184, 166, 0.22), 0 22px 60px rgba(15, 23, 42, 0.22)";
      highlight.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      return true;
    },
    { targetText, sectionId }
  );
}

export async function focusTargetElement(page: Page, targetText: string, options: { sectionId?: string; overlayText?: string; targetElementType?: string } = {}) {
  return page.evaluate(
    ({ targetText, sectionId, overlayText, targetElementType }) => {
      const cleanup = () => {
        document.getElementById("__synced_video_focus_scrim")?.remove();
        document.getElementById("__synced_video_focus_label")?.remove();
        const previous = document.querySelector("[data-synced-video-focus='true']") as HTMLElement | null;
        if (previous) {
          previous.style.position = previous.dataset.syncedOriginalPosition || "";
          previous.style.zIndex = previous.dataset.syncedOriginalZIndex || "";
          previous.style.outline = previous.dataset.syncedOriginalOutline || "";
          previous.style.boxShadow = previous.dataset.syncedOriginalBoxShadow || "";
          previous.style.borderRadius = previous.dataset.syncedOriginalBorderRadius || "";
          previous.style.transform = previous.dataset.syncedOriginalTransform || "";
          previous.style.transition = previous.dataset.syncedOriginalTransition || "";
          previous.style.filter = previous.dataset.syncedOriginalFilter || "";
          previous.removeAttribute("data-synced-video-focus");
        }
      };

      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
      };
      const needle = normalize(targetText || "");

      cleanup();
      let element: HTMLElement | null = sectionId ? (document.querySelector(`[data-synced-section-id="${CSS.escape(sectionId)}"]`) as HTMLElement | null) : null;
      if (!element && needle) {
        const selector = targetElementType === "button" || targetElementType === "cta" ? "a, button, [role='button']" : "h1, h2, h3, p, li, a, button, section, article, div";
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
        element =
          candidates.find((candidate) => normalize(candidate.textContent || "") === needle) ||
          candidates.find((candidate) => normalize(candidate.textContent || "").includes(needle)) ||
          candidates.find((candidate) => needle.includes(normalize(candidate.textContent || "").slice(0, 100))) ||
          null;
      }

      if (!element) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return false;
      }

      const closestSelector = targetElementType === "button" || targetElementType === "cta" ? "a, button, [role='button']" : "article, section, li, [class*='card' i], [class*='feature' i], [class*='price' i], div";
      const target = (element.closest(closestSelector) as HTMLElement | null) || element;
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

      const scrim = document.createElement("div");
      scrim.id = "__synced_video_focus_scrim";
      scrim.style.position = "fixed";
      scrim.style.inset = "0";
      scrim.style.background = "radial-gradient(circle at center, rgba(255,255,255,0.02), rgba(3, 7, 18, 0.28))";
      scrim.style.backdropFilter = "blur(6px)";
      scrim.style.zIndex = "2147483600";
      scrim.style.pointerEvents = "none";
      document.documentElement.appendChild(scrim);

      target.dataset.syncedOriginalPosition = target.style.position;
      target.dataset.syncedOriginalZIndex = target.style.zIndex;
      target.dataset.syncedOriginalOutline = target.style.outline;
      target.dataset.syncedOriginalBoxShadow = target.style.boxShadow;
      target.dataset.syncedOriginalBorderRadius = target.style.borderRadius;
      target.dataset.syncedOriginalTransform = target.style.transform;
      target.dataset.syncedOriginalTransition = target.style.transition;
      target.dataset.syncedOriginalFilter = target.style.filter;
      target.dataset.syncedVideoFocus = "true";
      if (window.getComputedStyle(target).position === "static") target.style.position = "relative";
      target.style.zIndex = "2147483620";
      target.style.outline = "none";
      target.style.boxShadow = "0 34px 90px rgba(15, 23, 42, 0.30)";
      target.style.borderRadius = target.style.borderRadius || "16px";
      target.style.transition = "transform 1100ms cubic-bezier(.2,.8,.2,1), box-shadow 900ms ease";
      target.style.transform = `${target.style.transform || ""} scale(1.12)`.trim();

      if (overlayText) {
        const rect = target.getBoundingClientRect();
        const label = document.createElement("div");
        label.id = "__synced_video_focus_label";
        label.textContent = overlayText;
        label.style.position = "fixed";
        label.style.left = `${Math.max(28, Math.min(window.innerWidth - 520, rect.left))}px`;
        label.style.top = `${Math.max(28, rect.top - 82)}px`;
        label.style.maxWidth = "500px";
        label.style.padding = "16px 20px";
        label.style.borderRadius = "14px";
        label.style.background = "rgba(255, 255, 255, 0.94)";
        label.style.color = "#0f172a";
        label.style.font = "800 24px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        label.style.lineHeight = "1.18";
        label.style.boxShadow = "0 22px 60px rgba(0, 0, 0, 0.32)";
        label.style.zIndex = "2147483630";
        label.style.pointerEvents = "none";
        document.documentElement.appendChild(label);
      }

      return true;
    },
    { targetText, sectionId: options.sectionId || "", overlayText: options.overlayText || "", targetElementType: options.targetElementType || "" }
  );
}

export async function clearSceneDecorations(page: Page) {
  await page.evaluate(() => {
    document.getElementById("__synced_video_overlay")?.remove();
    document.getElementById("__synced_video_focus_scrim")?.remove();
    document.getElementById("__synced_video_focus_label")?.remove();
    document.getElementById("__synced_video_step_label")?.remove();
    document.getElementById("__synced_video_cursor")?.remove();
    document.getElementById("__director_captions")?.remove();
    const highlighted = document.querySelector("[data-synced-video-highlight='true']") as HTMLElement | null;
    if (highlighted) {
      highlighted.style.outline = highlighted.dataset.syncedOriginalOutline || "";
      highlighted.style.boxShadow = highlighted.dataset.syncedOriginalBoxShadow || "";
      highlighted.removeAttribute("data-synced-video-highlight");
    }
    const focused = document.querySelector("[data-synced-video-focus='true']") as HTMLElement | null;
    if (focused) {
      focused.style.position = focused.dataset.syncedOriginalPosition || "";
      focused.style.zIndex = focused.dataset.syncedOriginalZIndex || "";
      focused.style.outline = focused.dataset.syncedOriginalOutline || "";
      focused.style.boxShadow = focused.dataset.syncedOriginalBoxShadow || "";
      focused.style.borderRadius = focused.dataset.syncedOriginalBorderRadius || "";
      focused.style.transform = focused.dataset.syncedOriginalTransform || "";
      focused.style.transition = focused.dataset.syncedOriginalTransition || "";
      focused.style.filter = focused.dataset.syncedOriginalFilter || "";
      focused.removeAttribute("data-synced-video-focus");
    }
  });
}

function fitRouteDuration(scenes: VideoScene[]) {
  const sanitized = scenes.map((scene, index) => ({
    ...scene,
    sceneNumber: index + 1,
    estimatedDurationSeconds: clampSceneDuration(scene.estimatedDurationSeconds)
  }));
  let total = sanitized.reduce((sum, scene) => sum + scene.estimatedDurationSeconds, 0);

  while (total > maxTotalRouteSeconds) {
    const longest = sanitized.reduce((candidate, scene, index) => (scene.estimatedDurationSeconds > sanitized[candidate].estimatedDurationSeconds ? index : candidate), 0);
    if (sanitized[longest].estimatedDurationSeconds <= 3) break;
    sanitized[longest].estimatedDurationSeconds -= 1;
    total -= 1;
  }

  return sanitized;
}

function introScene(productName: string, tagline: string, pageUrl: string): VideoScene {
  return {
    sceneNumber: 1,
    sceneType: "intro",
    title: productName,
    pageUrl,
    targetText: productName,
    targetElementType: "hero",
    visualAction: "open_intro",
    cameraMovement: "slide_in",
    interaction: "none",
    overlayText: productName,
    voiceover: tagline ? `This is ${productName}. ${tagline}` : `This is ${productName}, a product built to make the next step clearer.`,
    estimatedDurationSeconds: 5,
    fallbackAction: "Show the animated product intro."
  };
}

function outroScene(productName: string, pageUrl: string): VideoScene {
  return {
    sceneNumber: 1,
    sceneType: "outro",
    title: "Ready to launch?",
    pageUrl,
    targetText: "Ready to launch?",
    targetElementType: "cta",
    visualAction: "outro",
    cameraMovement: "fade_out",
    interaction: "none",
    overlayText: "Create your product video in minutes",
    voiceover: `Ready to launch? Turn ${productName} into a clear product video in minutes.`,
    estimatedDurationSeconds: 3,
    fallbackAction: "Show the animated CTA outro."
  };
}

function splitSentences(value: string) {
  return compactText(value, 500)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeSentence(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function sanitizeVoiceover(value: string) {
  let output = value;
  for (const phrase of overusedPhrasePatterns) {
    output = output.replace(new RegExp(phrase, "gi"), "");
  }
  return compactText(output.replace(/\s+/g, " ").trim(), 260);
}

function removeOverusedPhrases(sentence: string, phraseCounts: Map<string, number>) {
  let output = sentence;
  for (const phrase of overusedPhrasePatterns) {
    const count = phraseCounts.get(phrase) || 0;
    if (output.toLowerCase().includes(phrase)) {
      phraseCounts.set(phrase, count + 1);
      if (count >= 0) {
        output = output.replace(new RegExp(phrase, "gi"), "");
      }
    }
  }
  return output;
}

function inferElementType(section: WebsiteSection | undefined, index: number): VideoScene["targetElementType"] {
  const text = `${section?.heading || ""} ${section?.text || ""} ${(section?.buttonTexts || []).join(" ")}`.toLowerCase();
  if (index === 0) return "hero";
  if (/how it works|how-it-works|workflow|step|process|use|setup|install|create|connect/.test(text)) return "process_step";
  if (/price|plan|billing|subscription/.test(text)) return "pricing_card";
  if (/testimonial|customer|review|trusted|proof/.test(text)) return "testimonial";
  if (/contact|get started|book|demo|start|try|launch/.test(text)) return "cta";
  return "feature_card";
}

function inferVisualAction(section: WebsiteSection | undefined, index: number): VideoScene["visualAction"] {
  const text = `${section?.heading || ""} ${section?.text || ""}`.toLowerCase();
  if (index === 0) return "open_page";
  if (/how it works|how-it-works|workflow|step|process|use|setup|install|create|connect/.test(text)) return "process_zoom";
  if (/feature|benefit|capability|tool|automate|manage|track|dashboard|integrat/.test(text)) return "feature_showcase";
  return "zoom_to_element";
}

function inferCameraMovement(section: WebsiteSection | undefined, index: number): VideoScene["cameraMovement"] {
  const action = inferVisualAction(section, index);
  if (action === "process_zoom") return "step_zoom";
  if (action === "feature_showcase") return "slide_in";
  return index === 0 ? "slow_zoom" : "focus_highlight";
}

function inferInteraction(scene: unknown, section: WebsiteSection | undefined, index: number): VideoScene["interaction"] {
  const requested = (scene as { interaction?: unknown })?.interaction;
  if (requested === "click" || requested === "hover" || requested === "none") return requested;
  const text = `${section?.heading || ""} ${(section?.buttonTexts || []).join(" ")}`.toLowerCase();
  if (index > 1 && /(learn more|view demo|features|pricing|contact|get started|start|try)/.test(text)) return "click";
  return index === 0 ? "none" : "hover";
}

function normalizeClickSecond(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(8, Math.max(0.5, parsed));
}

function voiceForSection(section: WebsiteSection | undefined, productName: string) {
  const heading = compactText(section?.heading, 100);
  const visibleText = compactText(section?.text || heading, 170);
  if (!visibleText) return `${productName} gives visitors a clear reason to keep exploring.`;
  if (heading) return `${heading}: ${visibleText}`;
  return visibleText;
}

function isMappedPageUrl(value: unknown, websiteMap: WebsiteMap) {
  if (typeof value !== "string") return false;
  return websiteMap.selectedPages.includes(value) || websiteMap.pages.some((page) => page.url === value);
}

function normalizeEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}
