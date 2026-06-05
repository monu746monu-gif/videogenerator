import { access, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { chromium, type Browser, type Page } from "playwright";
import {
  cleanupOldVideoJobs,
  concatVideos,
  convertToMp4,
  copyVideoWithoutAudio,
  createVideoJob,
  ensureClickSound,
  getMediaDurationSeconds,
  mergeClickSoundWithVideo,
  mergeSceneAudioAndEffectsWithVideo,
  mergeSceneAudioWithVideo
} from "@/lib/media";
import { normalizeHttpUrl } from "@/lib/url";
import {
  clearSceneDecorations,
  clampSceneDuration,
  compactText,
  focusTargetElement,
  injectOverlay,
  maxScenes,
  normalizeVideoRoute,
  type VideoRoute,
  type WebsiteMap,
  type WebsiteSection
} from "@/lib/video-route";
import { tryGenerateSceneVoiceoverAudio } from "@/lib/voice";
import { canonicalUrl, isAllowedInternalUrl, shouldSkipUrl } from "@/lib/website-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const viewport = { width: 1080, height: 1920 };

type VisitedScene = {
  sceneNumber: number;
  title: string;
  pageUrl: string;
  targetText: string;
  sectionFound: boolean;
  durationSeconds: number;
  videoUrl: string;
  audioUrl?: string;
  visualAction: string;
  interaction: string;
  clickAdded?: boolean;
};

export async function POST(request: Request) {
  let browser: Browser | undefined;

  try {
    const body = (await request.json()) as { url?: unknown; websiteMap?: unknown; videoRoute?: unknown };
    const url = normalizeHttpUrl(String(body.url || ""));
    const websiteMap = body.websiteMap as WebsiteMap;
    const routeInput = body.videoRoute as Partial<VideoRoute>;
    if (!websiteMap?.pages?.length) throw new Error("websiteMap is required.");

    const origin = new URL(url).origin;
    const timestamp = Date.now();
    const videoRoute = normalizeVideoRoute(routeInput, websiteMap);
    const scenes = videoRoute.scenes.slice(0, maxScenes);
    const job = await createVideoJob();
    const warnings: string[] = [];
    const finalScenePaths: string[] = [];
    const visitedScenes: VisitedScene[] = [];

    await Promise.all([
      writeFile(path.join(job.dataDir, "website-map.json"), JSON.stringify(websiteMap, null, 2)),
      writeFile(path.join(job.dataDir, "video-route.json"), JSON.stringify(videoRoute, null, 2))
    ]);

    console.log("[render-synced-video] starting render", { url, scenes: scenes.length, jobId: job.jobId });
    browser = await chromium.launch({ headless: true });

    for (const scene of scenes) {
      const estimatedDurationSeconds = clampSceneDuration(scene.estimatedDurationSeconds);
      const pageUrl = isAllowedInternalUrl(scene.pageUrl, origin) ? canonicalUrl(scene.pageUrl) : canonicalUrl(url);
      const sceneName = `scene-${scene.sceneNumber}-${timestamp}`;
      const rawMp4Path = path.join(job.scenesDir, `${sceneName}-raw.mp4`);
      const finalPath = path.join(job.scenesDir, `${sceneName}-final.mp4`);
      const wantsClick = scene.interaction === "click";

      console.log("[render-synced-video] scene start", scene.sceneNumber, scene.title, pageUrl);
      const audio = await tryGenerateSceneVoiceoverAudio(scene.voiceover, scene.sceneNumber, timestamp, {
        audioDir: job.audioDir,
        audioUrlBase: `/generated/jobs/${job.jobId}/audio`
      });
      if (audio.warning) {
        console.warn("[render-synced-video]", audio.warning);
        warnings.push(audio.warning);
      }
      const audioDuration = audio.audioPath ? await getMediaDurationSeconds(audio.audioPath) : 0;
      const durationSeconds = Math.max(estimatedDurationSeconds, Math.ceil(audioDuration + 0.5));
      const clickSound = wantsClick ? await ensureClickSound() : { soundPath: "", warning: "" };
      if (clickSound.warning) warnings.push(`Scene ${scene.sceneNumber}: ${clickSound.warning}`);

      const context = await browser.newContext({
        viewport,
        recordVideo: {
          dir: job.recordingsDir,
          size: viewport
        },
        userAgent: "Mozilla/5.0 Synced Launch Video Renderer"
      });

      const page = await context.newPage();
      const video = page.video();
      let sectionFound = false;
      let clickAdded = false;

      try {
        if (scene.visualAction === "open_intro" || scene.sceneType.toLowerCase() === "intro") {
          await recordIntroScene(page, videoRoute.productName, videoRoute.tagline, durationSeconds);
          sectionFound = true;
        } else if (scene.visualAction === "outro" || scene.sceneType.toLowerCase() === "outro") {
          await recordOutroScene(page, videoRoute.productName, durationSeconds);
          sectionFound = true;
        } else {
          await gotoWithFallback(page, pageUrl);
          await page.locator("body").waitFor({ state: "visible", timeout: 15000 });
          await tagMappedSections(page);
          await page.waitForTimeout(500);

          const mappedSection = findMappedSection(websiteMap, pageUrl, scene.sectionId, scene.targetText);
          sectionFound = await focusTargetElement(page, scene.targetText || mappedSection?.heading || "", {
            sectionId: mappedSection?.id || scene.sectionId,
            overlayText: scene.overlayText || scene.title,
            targetElementType: scene.targetElementType
          });

          if (!sectionFound) {
            console.warn("[render-synced-video] section fallback", scene.sceneNumber, scene.fallbackAction);
            await fallbackSceneMotion(page);
            await injectOverlay(page, scene.overlayText || scene.title);
          }

          if (scene.interaction === "click" || scene.interaction === "hover") {
            const result = await moveCursorToElementAndClick(page, scene.targetText, {
              origin,
              allowClick: scene.interaction === "click",
              fallbackTexts: [scene.overlayText, scene.title, "Learn more", "View demo", "Features", "Pricing", "Contact", "Get started"]
            });
            clickAdded = result.clicked;
            if (result.warning) warnings.push(`Scene ${scene.sceneNumber}: ${result.warning}`);
          }

          await applyCameraMovement(page, scene.cameraMovement, durationSeconds, sectionFound);
        }
        await clearSceneDecorations(page);
      } catch (error) {
        console.warn("[render-synced-video] scene failed, using fallback", scene.sceneNumber, error instanceof Error ? error.message : error);
        warnings.push(`Scene ${scene.sceneNumber}: render fallback used.`);
        await fallbackScene(page, pageUrl, scene.overlayText || scene.title, durationSeconds).catch(() => undefined);
      } finally {
        await context.close();
      }

      const rawVideoPath = await video?.path();
      if (!rawVideoPath) {
        warnings.push(`Scene ${scene.sceneNumber}: recording file not found.`);
        continue;
      }

      await access(rawVideoPath);
      await convertToMp4(rawVideoPath, rawMp4Path);
      await unlink(rawVideoPath).catch(() => undefined);

      if (audio.audioPath && clickAdded && clickSound.soundPath) {
        await mergeSceneAudioAndEffectsWithVideo(rawMp4Path, audio.audioPath, finalPath, {
          clickSoundPath: clickSound.soundPath,
          clickAtSecond: scene.clickAtSecond || 2
        });
      } else if (audio.audioPath) {
        await mergeSceneAudioWithVideo(rawMp4Path, audio.audioPath, finalPath);
      } else if (clickAdded && clickSound.soundPath) {
        await mergeClickSoundWithVideo(rawMp4Path, clickSound.soundPath, finalPath, scene.clickAtSecond || 2);
      } else {
        await copyVideoWithoutAudio(rawMp4Path, finalPath);
      }
      await unlink(rawMp4Path).catch(() => undefined);

      finalScenePaths.push(finalPath);
      visitedScenes.push({
        sceneNumber: scene.sceneNumber,
        title: scene.title,
        pageUrl,
        targetText: scene.targetText,
        sectionFound,
        durationSeconds,
        videoUrl: `/generated/jobs/${job.jobId}/scenes/${path.basename(finalPath)}`,
        audioUrl: audio.audioUrl || undefined,
        visualAction: scene.visualAction,
        interaction: scene.interaction,
        clickAdded
      });
      console.log("[render-synced-video] scene complete", scene.sceneNumber, finalPath);
    }

    const outputPath = path.join(job.finalDir, "final-video.mp4");
    await concatVideos(finalScenePaths, outputPath);
    await writeFile(path.join(job.dataDir, "voiceover-script.txt"), scenes.map((scene) => `Scene ${scene.sceneNumber}: ${scene.voiceover}`).join("\n\n"));

    console.log("[render-synced-video] final video", outputPath);
    await cleanupOldVideoJobs();
    return NextResponse.json({
      success: true,
      jobId: job.jobId,
      videoUrl: `/api/download-video?jobId=${job.jobId}`,
      previewUrl: `/generated/jobs/${job.jobId}/final/final-video.mp4`,
      outputPath,
      visitedScenes,
      script: scenes.map((scene) => `Scene ${scene.sceneNumber}: ${scene.voiceover}`).join("\n\n"),
      warnings
    });
  } catch (error) {
    console.error("[render-synced-video] failed", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to render synced launch video." },
      { status: 500 }
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await cleanupOldVideoJobs().catch(() => undefined);
  }
}

async function gotoWithFallback(page: Page, url: string) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    console.warn("[render-synced-video] networkidle timeout, retrying domcontentloaded", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
  }
}

async function recordIntroScene(page: Page, productName: string, tagline: string, durationSeconds: number) {
  await page.setContent(animatedTitleHtml({
    eyebrow: "AI-generated product walkthrough",
    title: productName,
    subtitle: tagline || "A guided look at what makes this product useful.",
    cta: ""
  }));
  await page.waitForTimeout(durationSeconds * 1000);
}

async function recordOutroScene(page: Page, productName: string, durationSeconds: number) {
  await page.setContent(animatedTitleHtml({
    eyebrow: productName,
    title: "Ready to launch?",
    subtitle: "Create your product video in minutes",
    cta: "AI-generated product walkthrough"
  }));
  await page.waitForTimeout(durationSeconds * 1000);
}

function animatedTitleHtml(content: { eyebrow: string; title: string; subtitle: string; cta: string }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #050816;
        color: white;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body::before {
        content: "";
        position: fixed;
        inset: -20%;
        background:
          radial-gradient(circle at 25% 25%, rgba(20, 184, 166, 0.36), transparent 28%),
          radial-gradient(circle at 76% 32%, rgba(59, 130, 246, 0.34), transparent 26%),
          radial-gradient(circle at 48% 78%, rgba(244, 114, 182, 0.20), transparent 30%);
        filter: blur(22px);
        animation: glow 4200ms ease-in-out infinite alternate;
      }
      .wrap {
        position: relative;
        z-index: 2;
        display: grid;
        place-content: center;
        width: 100%;
        height: 100%;
        padding: 96px;
        box-sizing: border-box;
      }
      .eyebrow, .title, .subtitle, .cta {
        text-align: center;
        opacity: 0;
        transform: translateY(24px);
        animation: rise 900ms cubic-bezier(.2, .8, .2, 1) forwards;
      }
      .eyebrow {
        color: #67e8f9;
        font-size: 28px;
        font-weight: 800;
        letter-spacing: 0;
        margin-bottom: 28px;
      }
      .title {
        max-width: 920px;
        font-size: 92px;
        line-height: 0.96;
        font-weight: 950;
        letter-spacing: 0;
        text-wrap: balance;
        animation-delay: 120ms;
      }
      .subtitle {
        max-width: 820px;
        margin: 32px auto 0;
        color: #dbeafe;
        font-size: 36px;
        line-height: 1.18;
        font-weight: 650;
        animation-delay: 520ms;
      }
      .cta {
        margin-top: 44px;
        color: #a7f3d0;
        font-size: 24px;
        font-weight: 800;
        animation-delay: 900ms;
      }
      @keyframes rise {
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes glow {
        from { transform: translate3d(-2%, -1%, 0) scale(1); }
        to { transform: translate3d(2%, 1%, 0) scale(1.04); }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <div class="eyebrow">${escapeHtml(content.eyebrow)}</div>
      <div class="title">${escapeHtml(content.title)}</div>
      <div class="subtitle">${escapeHtml(content.subtitle)}</div>
      ${content.cta ? `<div class="cta">${escapeHtml(content.cta)}</div>` : ""}
    </main>
  </body>
</html>`;
}

async function moveCursorToElementAndClick(
  page: Page,
  targetText: string,
  options: { origin: string; allowClick: boolean; fallbackTexts: string[] }
) {
  const target = await page.evaluate(
    ({ targetText, fallbackTexts }) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const unsafeText = /login|log in|sign in|signup|sign up|checkout|cart|payment|billing|auth/i;
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const needles = [targetText, ...fallbackTexts].map((value) => normalize(value || "")).filter(Boolean);
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button']"))
        .filter(isVisible)
        .filter((element) => !unsafeText.test(element.textContent || ""));
      const matched =
        candidates.find((element) => needles.some((needle) => normalize(element.textContent || "") === needle)) ||
        candidates.find((element) => needles.some((needle) => normalize(element.textContent || "").includes(needle) || needle.includes(normalize(element.textContent || "")))) ||
        candidates.find((element) => /learn more|view demo|features|pricing|contact|get started|start|try/i.test(element.textContent || "")) ||
        null;

      if (!matched) return null;
      matched.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      const rect = matched.getBoundingClientRect();
      const href = matched instanceof HTMLAnchorElement ? matched.href : matched.closest("a")?.href || "";
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        text: (matched.textContent || "").replace(/\s+/g, " ").trim(),
        href
      };
    },
    { targetText, fallbackTexts: options.fallbackTexts }
  );

  if (!target) return { clicked: false, warning: "No safe button or link target found; used focus only." };

  await page.waitForTimeout(500);
  await page.mouse.move(target.x, target.y, { steps: 18 });
  await page.waitForTimeout(400);

  if (!options.allowClick) return { clicked: false, warning: "" };
  if (target.href && (!isAllowedInternalUrl(target.href, options.origin) || shouldSkipUrl(target.href, options.origin))) {
    return { clicked: false, warning: `Skipped unsafe click target: ${target.text || target.href}` };
  }

  const beforeUrl = page.url();
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(900);
  const afterUrl = page.url();
  if (afterUrl !== beforeUrl && (!isAllowedInternalUrl(afterUrl, options.origin) || shouldSkipUrl(afterUrl, options.origin))) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => undefined);
    return { clicked: true, warning: "Clicked target navigated to an unsafe page, so the renderer returned to the previous page." };
  }

  return { clicked: true, warning: "" };
}

async function tagMappedSections(page: Page) {
  await page.evaluate(() => {
    Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3"))
      .filter((heading) => {
        const rect = heading.getBoundingClientRect();
        const style = window.getComputedStyle(heading);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .slice(0, 16)
      .forEach((heading, index) => {
        const container = (heading.closest("section, article, header, main, div") || heading.parentElement || heading) as HTMLElement;
        container.setAttribute("data-synced-section-id", `section-${index + 1}`);
      });
  });
}

async function applyCameraMovement(page: Page, cameraMovement: string, durationSeconds: number, sectionFound: boolean) {
  const totalMs = durationSeconds * 1000;
  if (cameraMovement === "fade_in") {
    await page.waitForTimeout(totalMs);
    return;
  }

  if (cameraMovement === "slow_zoom") {
    await page.evaluate(() => {
      document.documentElement.style.transition = "transform 5s ease";
      document.documentElement.style.transformOrigin = "center top";
      document.documentElement.style.transform = "scale(1.018)";
    });
    await page.waitForTimeout(totalMs);
    return;
  }

  if (cameraMovement === "scroll_then_zoom") {
    await page.waitForTimeout(Math.min(1400, totalMs));
    await page.evaluate(() => {
      document.documentElement.style.transition = "transform 4s ease";
      document.documentElement.style.transformOrigin = "center center";
      document.documentElement.style.transform = "scale(1.012)";
    });
    await page.waitForTimeout(Math.max(1000, totalMs - 1400));
    return;
  }

  if (cameraMovement === "click_focus") {
    await page.waitForTimeout(Math.min(1800, totalMs));
    await page.evaluate(() => {
      const focused = document.querySelector("[data-synced-video-focus='true']") as HTMLElement | null;
      if (focused) focused.style.boxShadow = "0 0 0 12px rgba(14, 165, 233, 0.28), 0 30px 90px rgba(0, 0, 0, 0.44)";
    });
    await page.waitForTimeout(Math.max(900, totalMs - 1800));
    return;
  }

  await page.waitForTimeout(sectionFound ? totalMs : Math.max(1000, totalMs));
}

async function fallbackScene(page: Page, pageUrl: string, overlayText: string, durationSeconds: number) {
  await gotoWithFallback(page, pageUrl);
  await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
  await injectOverlay(page, overlayText);
  await fallbackSceneMotion(page);
  await page.waitForTimeout(Math.max(1000, durationSeconds * 1000 - 2000));
}

async function fallbackSceneMotion(page: Page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(1200);
}

function findMappedSection(websiteMap: WebsiteMap, pageUrl: string, sectionId?: string, targetText?: string): WebsiteSection | undefined {
  const page = websiteMap.pages.find((mappedPage) => canonicalUrl(mappedPage.url) === canonicalUrl(pageUrl));
  if (!page) return undefined;
  if (sectionId) {
    const found = page.sections.find((section) => section.id === sectionId);
    if (found) return found;
  }

  const needle = compactText(targetText, 120).toLowerCase();
  if (!needle) return undefined;
  return page.sections.find((section) => `${section.heading} ${section.text}`.toLowerCase().includes(needle));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
