import { readFileSync } from "node:fs";
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
  type VideoScene,
  type VideoRoute,
  type WebsiteMap,
  type WebsiteSection,
  type WebsiteTheme
} from "@/lib/video-route";
import { tryGenerateSceneVoiceoverAudio } from "@/lib/voice";
import { canonicalUrl, isAllowedInternalUrl, shouldSkipUrl } from "@/lib/website-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const viewport = { width: 1080, height: 1080 };

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
    const body = (await request.json()) as { url?: unknown; founderName?: unknown; websiteMap?: unknown; videoRoute?: unknown };
    const url = normalizeHttpUrl(String(body.url || ""));
    const founderName = compactText(body.founderName, 80);
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
    const scriptLines: string[] = [];

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
      const voiceoverText =
        (scene.visualAction === "outro" || scene.sceneType.toLowerCase() === "outro") && founderName
          ? `Built by ${founderName}. ${videoRoute.productName} is ready to share.`
          : scene.voiceover;

      console.log("[render-synced-video] scene start", scene.sceneNumber, scene.title, pageUrl);
      const audio = await tryGenerateSceneVoiceoverAudio(voiceoverText, scene.sceneNumber, timestamp, {
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
          await recordIntroScene(page, videoRoute.productName, videoRoute.tagline, voiceoverText, durationSeconds, websiteMap.theme, websiteMap.brand?.logoUrl);
          sectionFound = true;
        } else if (scene.visualAction === "outro" || scene.sceneType.toLowerCase() === "outro") {
          await recordOutroScene(page, videoRoute.productName, founderName, voiceoverText, durationSeconds, websiteMap.theme);
          sectionFound = true;
        } else {
          await gotoWithFallback(page, pageUrl);
          await page.locator("body").waitFor({ state: "attached", timeout: 15000 });
          await tagMappedSections(page);
          await page.waitForTimeout(500);

          const mappedSection = findMappedSection(websiteMap, pageUrl, scene.sectionId, scene.targetText);

          if (scene.visualAction === "feature_showcase") {
            const captures = await captureWebsiteAndTarget(page, scene, job.screenshotsDir, sceneName, mappedSection);
            await recordFeatureShowcaseScene(page, scene, captures, voiceoverText, durationSeconds, websiteMap.theme);
            sectionFound = captures.sectionFound;
          } else {
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
          }

          if (scene.visualAction === "process_zoom") {
            await recordProcessZoomMotion(page, scene, voiceoverText, durationSeconds, sectionFound, websiteMap.theme);
          } else if (scene.interaction === "click" || scene.interaction === "hover") {
            await injectAnimatedCaptions(page, voiceoverText, durationSeconds, websiteMap.theme);
            const result = await moveCursorToElementAndClick(page, scene.targetText, {
              origin,
              allowClick: scene.interaction === "click",
              fallbackTexts: [scene.overlayText, scene.title, "Learn more", "View demo", "Features", "Pricing", "Contact", "Get started"]
            });
            clickAdded = result.clicked;
            if (result.warning) warnings.push(`Scene ${scene.sceneNumber}: ${result.warning}`);
            await applyCameraMovement(page, scene.cameraMovement, durationSeconds, sectionFound);
          } else if (scene.visualAction !== "feature_showcase") {
            await injectAnimatedCaptions(page, voiceoverText, durationSeconds, websiteMap.theme);
            await applyCameraMovement(page, scene.cameraMovement, durationSeconds, sectionFound);
          }
        }
        await clearSceneDecorations(page);
      } catch (error) {
        console.warn("[render-synced-video] scene failed, using fallback", scene.sceneNumber, error instanceof Error ? error.message : error);
        warnings.push(`Scene ${scene.sceneNumber}: render fallback used.`);
        await fallbackScene(page, pageUrl, scene.overlayText || scene.title, voiceoverText, durationSeconds, websiteMap.theme).catch(() => undefined);
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
      scriptLines.push(`Scene ${scene.sceneNumber}: ${voiceoverText}`);
      console.log("[render-synced-video] scene complete", scene.sceneNumber, finalPath);
    }

    const outputPath = path.join(job.finalDir, "final-video.mp4");
    await concatVideos(finalScenePaths, outputPath);
    await writeFile(path.join(job.dataDir, "voiceover-script.txt"), scriptLines.join("\n\n"));

    console.log("[render-synced-video] final video", outputPath);
    await cleanupOldVideoJobs();
    return NextResponse.json({
      success: true,
      jobId: job.jobId,
      videoUrl: `/api/download-video?jobId=${job.jobId}`,
      previewUrl: `/generated/jobs/${job.jobId}/final/final-video.mp4`,
      outputPath,
      visitedScenes,
      script: scriptLines.join("\n\n"),
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

async function recordIntroScene(page: Page, productName: string, tagline: string, voiceover: string, durationSeconds: number, theme?: WebsiteTheme, logoUrl?: string) {
  await page.setContent(animatedTitleHtml({
    eyebrow: "This is",
    title: productName,
    subtitle: tagline || "A guided look at what makes this product useful.",
    cta: "",
    theme,
    whiteIntro: true,
    logoUrl
  }));
  await injectAnimatedCaptions(page, voiceover, durationSeconds, theme);
  await page.waitForTimeout(durationSeconds * 1000);
}

async function recordOutroScene(page: Page, productName: string, founderName: string, voiceover: string, durationSeconds: number, theme?: WebsiteTheme) {
  await page.setContent(founderOutroHtml({ productName, founderName, theme }));
  await injectAnimatedCaptions(page, voiceover, durationSeconds, theme);
  await page.waitForTimeout(durationSeconds * 1000);
}

async function recordFeatureShowcaseScene(
  page: Page,
  scene: VideoScene,
  captures: { backgroundDataUrl: string; targetDataUrl: string; sectionFound: boolean },
  voiceover: string,
  durationSeconds: number,
  theme?: WebsiteTheme
) {
  await page.setContent(
    await featureShowcaseHtml({
      title: scene.title,
      overlayText: scene.overlayText || scene.title,
      targetText: scene.targetText,
      backgroundDataUrl: captures.backgroundDataUrl,
      targetDataUrl: captures.targetDataUrl,
      theme
    })
  );
  await injectAnimatedCaptions(page, voiceover, durationSeconds, theme);
  await page.waitForTimeout(durationSeconds * 1000);
}

async function recordProcessZoomMotion(page: Page, scene: VideoScene, voiceover: string, durationSeconds: number, sectionFound: boolean, theme?: WebsiteTheme) {
  await page.addScriptTag({ content: getGsapRuntime() }).catch(() => undefined);
  await page.evaluate((label) => {
    document.getElementById("__synced_video_focus_scrim")?.remove();
    const step = document.createElement("div");
    step.id = "__synced_video_step_label";
    step.textContent = label;
    step.style.position = "fixed";
    step.style.top = "36px";
    step.style.left = "36px";
    step.style.maxWidth = "560px";
    step.style.padding = "18px 24px";
    step.style.borderRadius = "16px";
    step.style.background = "rgba(255, 255, 255, 0.94)";
    step.style.color = "#0f172a";
    step.style.font = "800 26px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    step.style.lineHeight = "1.15";
    step.style.boxShadow = "0 28px 80px rgba(15, 23, 42, 0.24)";
    step.style.zIndex = "2147483640";
    step.style.pointerEvents = "none";
    step.style.transform = "translateX(-40px)";
    step.style.opacity = "0";
    document.documentElement.appendChild(step);

    const focused = document.querySelector("[data-synced-video-focus='true']") as HTMLElement | null;
    const cursor = document.createElement("div");
    cursor.id = "__synced_video_cursor";
    cursor.innerHTML = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 5L40 30L25 32L18 47L8 5Z" fill="white" stroke="#0f172a" stroke-width="3" stroke-linejoin="round"/><path d="M27 32L36 45" stroke="#0f172a" stroke-width="5" stroke-linecap="round"/></svg>`;
    cursor.style.position = "fixed";
    cursor.style.left = "calc(50% - 180px)";
    cursor.style.top = "calc(50% + 140px)";
    cursor.style.zIndex = "2147483645";
    cursor.style.filter = "drop-shadow(0 14px 24px rgba(15,23,42,.34))";
    cursor.style.pointerEvents = "none";
    cursor.style.opacity = "0";
    document.documentElement.appendChild(cursor);

    if (focused) {
      focused.style.transition = "transform 1400ms cubic-bezier(.2,.8,.2,1), filter 1400ms ease";
      focused.style.transform = `${focused.dataset.syncedOriginalTransform || ""} scale(1.12)`.trim();
      focused.style.filter = "drop-shadow(0 30px 70px rgba(15,23,42,.28))";
    }

    const timeline = (window as unknown as { gsap?: { timeline: (options?: unknown) => { to: (...args: unknown[]) => unknown } } }).gsap?.timeline();
    if (timeline) {
      timeline.to(step, { opacity: 1, x: 0, duration: 0.7, ease: "power3.out" });
      timeline.to(cursor, { opacity: 1, x: 190, y: -115, duration: 1.15, ease: "power2.inOut" }, "<0.1");
      timeline.to(cursor, { scale: 0.86, duration: 0.12, yoyo: true, repeat: 1, ease: "power1.inOut" });
      timeline.to(focused || document.documentElement, { scale: focused ? 1.08 : 1.012, duration: 1.4, ease: "power2.out" }, "<0.2");
    } else {
      step.animate([{ opacity: 0, transform: "translateX(-40px)" }, { opacity: 1, transform: "translateX(0)" }], {
        duration: 700,
        fill: "forwards",
        easing: "cubic-bezier(.2,.8,.2,1)"
      });
    }
  }, scene.overlayText || scene.title);

  if (!sectionFound) await fallbackSceneMotion(page);
  await injectAnimatedCaptions(page, voiceover, durationSeconds, theme);
  await page.waitForTimeout(durationSeconds * 1000);
}

async function captureWebsiteAndTarget(
  page: Page,
  scene: VideoScene,
  screenshotsDir: string,
  sceneName: string,
  mappedSection?: WebsiteSection
) {
  const target = await locateTargetRect(page, scene.targetText || mappedSection?.heading || "", mappedSection?.id || scene.sectionId);
  const background = await page.screenshot({ fullPage: false });
  const backgroundPath = path.join(screenshotsDir, `${sceneName}-background.png`);
  await writeFile(backgroundPath, background);

  let targetImage = background;
  if (target) {
    const clip = {
      x: Math.max(0, Math.floor(target.x)),
      y: Math.max(0, Math.floor(target.y)),
      width: Math.max(80, Math.min(viewport.width - Math.max(0, Math.floor(target.x)), Math.ceil(target.width))),
      height: Math.max(80, Math.min(viewport.height - Math.max(0, Math.floor(target.y)), Math.ceil(target.height)))
    };
    targetImage = await page.screenshot({ clip });
  }
  const targetPath = path.join(screenshotsDir, `${sceneName}-feature.png`);
  await writeFile(targetPath, targetImage);

  return {
    backgroundDataUrl: `data:image/png;base64,${Buffer.from(background).toString("base64")}`,
    targetDataUrl: `data:image/png;base64,${Buffer.from(targetImage).toString("base64")}`,
    sectionFound: Boolean(target)
  };
}

async function locateTargetRect(page: Page, targetText: string, sectionId?: string) {
  return page.evaluate(
    ({ targetText, sectionId }) => {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const needle = normalize(targetText || "");
      let element = sectionId ? (document.querySelector(`[data-synced-section-id="${CSS.escape(sectionId)}"]`) as HTMLElement | null) : null;
      if (!element && needle) {
        element =
          Array.from(document.querySelectorAll<HTMLElement>("section, article, div, h1, h2, h3, li"))
            .filter(isVisible)
            .find((candidate) => normalize(candidate.textContent || "").includes(needle)) || null;
      }
      if (!element) return null;
      const target = (element.closest("section, article, li, [class*='card' i], [class*='feature' i], div") as HTMLElement | null) || element;
      target.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    },
    { targetText, sectionId: sectionId || "" }
  );
}

function animatedTitleHtml(content: { eyebrow: string; title: string; subtitle: string; cta: string; theme?: WebsiteTheme; whiteIntro?: boolean; logoUrl?: string }) {
  const theme = normalizeTheme(content.theme);
  const background = content.whiteIntro ? "#ffffff" : theme.backgroundColor;
  const textColor = content.whiteIntro ? "#0f172a" : theme.textColor;
  const subtitleColor = content.whiteIntro ? "rgba(15, 23, 42, 0.72)" : hexToRgba(theme.textColor, 0.82);
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
        background: ${background};
        color: ${textColor};
        font-family: ${theme.fontFamily};
      }
      body::before {
        content: "";
        position: fixed;
        inset: -20%;
        display: ${content.whiteIntro ? "none" : "block"};
        background:
          radial-gradient(circle at 25% 25%, ${hexToRgba(theme.primaryColor, 0.42)}, transparent 28%),
          radial-gradient(circle at 76% 32%, ${hexToRgba(theme.accentColor, 0.38)}, transparent 26%),
          radial-gradient(circle at 48% 78%, ${hexToRgba(theme.surfaceColor, 0.30)}, transparent 30%);
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
        transform: translateX(160px);
      }
      .eyebrow {
        color: ${theme.accentColor};
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
      }
      .subtitle {
        max-width: 820px;
        margin: 32px auto 0;
        color: ${subtitleColor};
        font-size: 36px;
        line-height: 1.18;
        font-weight: 650;
      }
      .cta {
        margin-top: 44px;
        color: ${theme.primaryColor};
        font-size: 24px;
        font-weight: 800;
      }
      .logo-mark {
        width: 132px;
        height: 132px;
        margin: 0 auto 30px;
        display: grid;
        place-items: center;
        border-radius: 34px;
        background: ${theme.primaryColor};
        color: white;
        font-size: 56px;
        font-weight: 950;
        box-shadow: 0 30px 90px ${hexToRgba(theme.primaryColor, 0.36)};
        opacity: 0;
        transform: translateX(180px) rotate(4deg);
      }
      .logo-mark img {
        max-width: 84%;
        max-height: 84%;
        object-fit: contain;
        display: block;
      }
      @keyframes glow {
        from { transform: translate3d(-2%, -1%, 0) scale(1); }
        to { transform: translate3d(2%, 1%, 0) scale(1.04); }
      }
    </style>
    <script>${escapeClosingScript(getGsapRuntime())}</script>
  </head>
  <body>
    <main class="wrap">
      <div class="logo-mark">${content.logoUrl ? `<img src="${escapeHtml(content.logoUrl)}" alt="" />` : escapeHtml(initials(content.title))}</div>
      <div class="eyebrow">${escapeHtml(content.eyebrow)}</div>
      <div class="title">${escapeHtml(content.title)}</div>
      <div class="subtitle">${escapeHtml(content.subtitle)}</div>
      ${content.cta ? `<div class="cta">${escapeHtml(content.cta)}</div>` : ""}
    </main>
    <script>
      gsap.timeline({ defaults: { ease: "power3.out" } })
        .to(".logo-mark", { opacity: 1, x: 0, rotate: 0, duration: 0.9 })
        .to(".eyebrow", { opacity: 1, x: 0, duration: 0.7 }, "-=0.25")
        .to(".title", { opacity: 1, x: 0, duration: 0.9 }, "-=0.35")
        .to(".subtitle", { opacity: 1, x: 0, duration: 0.8 }, "-=0.2")
        .to(".cta", { opacity: 1, x: 0, duration: 0.6 }, "-=0.15");
    </script>
  </body>
</html>`;
}

async function featureShowcaseHtml(content: {
  title: string;
  overlayText: string;
  targetText: string;
  backgroundDataUrl: string;
  targetDataUrl: string;
  theme?: WebsiteTheme;
}) {
  const theme = normalizeTheme(content.theme);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #0f172a;
        font-family: ${theme.fontFamily};
      }
      .background {
        position: fixed;
        inset: 0;
        background-image: url("${content.backgroundDataUrl}");
        background-size: cover;
        background-position: center;
        filter: blur(28px) saturate(0.9);
        transform: scale(1.08);
        opacity: 0.72;
      }
      .shade {
        position: fixed;
        inset: 0;
        background: linear-gradient(180deg, rgba(15,23,42,.35), rgba(15,23,42,.82));
      }
      .feature-card {
        position: absolute;
        left: 50%;
        top: 50%;
        width: min(760px, 78vw);
        max-height: 760px;
        transform: translate(72%, -46%) rotate(3deg);
        opacity: 0;
        border-radius: 30px;
        overflow: hidden;
        border: 1px solid ${hexToRgba(theme.primaryColor, 0.38)};
        box-shadow: 0 46px 130px rgba(0,0,0,.52), 0 0 0 12px rgba(255,255,255,.06);
        background: linear-gradient(145deg, rgba(15,23,42,.94), rgba(30,41,59,.88));
        backdrop-filter: blur(14px);
      }
      .feature-card img {
        display: block;
        width: 100%;
        max-height: 520px;
        object-fit: cover;
        border-bottom: 1px solid rgba(255,255,255,.12);
      }
      .caption {
        padding: 28px 32px 34px;
        color: white;
      }
      .caption strong {
        display: block;
        font-size: 34px;
        line-height: 1.05;
        letter-spacing: 0;
      }
      .caption span {
        display: block;
        margin-top: 12px;
        color: rgba(255,255,255,.72);
        font-size: 22px;
        line-height: 1.24;
      }
      .use-pill {
        position: absolute;
        right: 54px;
        top: 54px;
        padding: 14px 18px;
        border-radius: 999px;
        background: rgba(255,255,255,.94);
        color: #0f172a;
        font-size: 20px;
        font-weight: 900;
        box-shadow: 0 20px 55px rgba(0,0,0,.25);
        opacity: 0;
        transform: translateY(-18px);
      }
      .cursor {
        position: absolute;
        left: 58%;
        top: 62%;
        width: 58px;
        height: 58px;
        opacity: 0;
        filter: drop-shadow(0 14px 24px rgba(0,0,0,.38));
        z-index: 5;
      }
      .label {
        position: absolute;
        left: 64px;
        bottom: 72px;
        max-width: 560px;
        color: white;
        font-size: 42px;
        line-height: 1.04;
        font-weight: 900;
        opacity: 0;
        transform: translateY(36px);
      }
      .label::before {
        content: "";
        display: block;
        width: 96px;
        height: 8px;
        border-radius: 999px;
        margin-bottom: 24px;
        background: ${theme.primaryColor};
      }
    </style>
    <script>${escapeClosingScript(getGsapRuntime())}</script>
  </head>
  <body>
    <div class="background"></div>
    <div class="shade"></div>
    <div class="use-pill">Show screen, then use it</div>
    <div class="cursor"><svg width="58" height="58" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 5L40 30L25 32L18 47L8 5Z" fill="white" stroke="#0f172a" stroke-width="3" stroke-linejoin="round"/><path d="M27 32L36 45" stroke="#0f172a" stroke-width="5" stroke-linecap="round"/></svg></div>
    <div class="label">${escapeHtml(content.overlayText)}</div>
    <section class="feature-card">
      <img src="${content.targetDataUrl}" alt="" />
      <div class="caption">
        <strong>${escapeHtml(content.title)}</strong>
        <span>${escapeHtml(content.targetText)}</span>
      </div>
    </section>
    <script>
      gsap.timeline({ defaults: { ease: "power3.out" } })
        .to(".feature-card", { opacity: 1, xPercent: -50, yPercent: -50, x: 0, rotate: -1.5, duration: 1.05 })
        .to(".label", { opacity: 1, y: 0, duration: .75 }, "-=.45")
        .to(".use-pill", { opacity: 1, y: 0, duration: .55 }, "-=.25")
        .to(".cursor", { opacity: 1, x: -155, y: -130, duration: 1.1, ease: "power2.inOut" }, "-=.1")
        .to(".cursor", { scale: .86, duration: .12, yoyo: true, repeat: 1, ease: "power1.inOut" })
        .to(".feature-card", { y: -18, rotate: 1.2, scale: 1.035, duration: 4.2, ease: "sine.inOut" }, "-=.4");
    </script>
  </body>
</html>`;
}

function founderOutroHtml(content: { productName: string; founderName: string; theme?: WebsiteTheme }) {
  const theme = normalizeTheme(content.theme);
  const founder = content.founderName || "Founder";
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
        background: #ffffff;
        color: #0f172a;
        font-family: ${theme.fontFamily};
      }
      main {
        width: 100%;
        height: 100%;
        display: grid;
        place-content: center;
        padding: 88px;
        box-sizing: border-box;
      }
      .line {
        font-size: 34px;
        font-weight: 800;
        color: ${theme.primaryColor};
        text-align: center;
        opacity: 0;
        transform: translateY(22px);
      }
      .name {
        margin-top: 26px;
        min-height: 104px;
        text-align: center;
        font-size: 86px;
        line-height: 1;
        font-weight: 950;
        letter-spacing: 0;
      }
      .product {
        margin-top: 36px;
        text-align: center;
        font-size: 28px;
        font-weight: 750;
        color: rgba(15,23,42,.62);
        opacity: 0;
        transform: translateY(22px);
      }
      .cursor-line {
        display: inline-block;
        width: 5px;
        height: .9em;
        margin-left: 8px;
        background: ${theme.accentColor};
        vertical-align: -8px;
        animation: blink .8s steps(1) infinite;
      }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
    <script>${escapeClosingScript(getGsapRuntime())}</script>
  </head>
  <body>
    <main>
      <div class="line">Built by</div>
      <div class="name"><span id="typed"></span><span class="cursor-line"></span></div>
      <div class="product">${escapeHtml(content.productName)}</div>
    </main>
    <script>
      const founder = ${JSON.stringify(founder)};
      const target = document.getElementById("typed");
      gsap.to(".line", { opacity: 1, y: 0, duration: .7, ease: "power3.out" });
      let i = 0;
      const timer = setInterval(() => {
        target.textContent = founder.slice(0, i++);
        if (i > founder.length) clearInterval(timer);
      }, Math.max(45, Math.min(95, 900 / Math.max(1, founder.length))));
      gsap.to(".product", { opacity: 1, y: 0, duration: .7, delay: 1.4, ease: "power3.out" });
    </script>
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

async function fallbackScene(page: Page, pageUrl: string, overlayText: string, voiceover: string, durationSeconds: number, theme?: WebsiteTheme) {
  await gotoWithFallback(page, pageUrl);
  await page.locator("body").waitFor({ state: "attached", timeout: 10000 });
  await injectOverlay(page, overlayText);
  await fallbackSceneMotion(page);
  await injectAnimatedCaptions(page, voiceover, durationSeconds, theme);
  await page.waitForTimeout(Math.max(1000, durationSeconds * 1000 - 2000));
}

async function fallbackSceneMotion(page: Page) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(1200);
}

async function injectAnimatedCaptions(page: Page, voiceover: string, durationSeconds: number, theme?: WebsiteTheme) {
  const words = compactText(voiceover, 260)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 34);
  if (!words.length) return;

  const normalizedTheme = normalizeTheme(theme);
  const chunkCount = Math.max(1, Math.ceil(words.length / 7));
  const chunkDuration = Math.max(1.25, (durationSeconds - 0.4) / chunkCount);
  const chunks: string[][] = [];
  for (let index = 0; index < words.length; index += 7) {
    chunks.push(words.slice(index, index + 7));
  }

  await page.addScriptTag({ content: getGsapRuntime() }).catch(() => undefined);
  await page.evaluate(
    ({ chunks, chunkDuration, primaryColor, accentColor }) => {
      document.getElementById("__director_captions")?.remove();
      const wrap = document.createElement("div");
      wrap.id = "__director_captions";
      wrap.style.position = "fixed";
      wrap.style.left = "50%";
      wrap.style.bottom = "34px";
      wrap.style.width = "min(880px, calc(100vw - 56px))";
      wrap.style.transform = "translateX(-50%)";
      wrap.style.zIndex = "2147483646";
      wrap.style.pointerEvents = "none";
      wrap.style.display = "grid";
      wrap.style.placeItems = "center";

      const box = document.createElement("div");
      box.style.maxWidth = "100%";
      box.style.padding = "18px 24px";
      box.style.borderRadius = "18px";
      box.style.background = "rgba(15, 23, 42, 0.86)";
      box.style.backdropFilter = "blur(18px)";
      box.style.border = `1px solid ${primaryColor}`;
      box.style.boxShadow = `0 24px 70px rgba(0,0,0,.30), 0 0 0 8px rgba(255,255,255,.05)`;
      box.style.color = "white";
      box.style.font = "850 31px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      box.style.lineHeight = "1.16";
      box.style.textAlign = "center";
      box.style.letterSpacing = "0";
      box.style.opacity = "0";
      box.style.transform = "translateY(26px) scale(.98)";
      wrap.appendChild(box);
      document.documentElement.appendChild(wrap);

      const renderChunk = (chunk: string[]) => {
        box.innerHTML = "";
        chunk.forEach((word, index) => {
          const span = document.createElement("span");
          span.textContent = `${word}${index === chunk.length - 1 ? "" : " "}`;
          span.style.display = "inline-block";
          span.style.opacity = "0.34";
          span.style.transform = "translateY(9px)";
          span.style.marginRight = "4px";
          box.appendChild(span);
        });
        return Array.from(box.querySelectorAll("span"));
      };

      const gsapApi = (window as unknown as { gsap?: { timeline: (options?: unknown) => { to: (...args: unknown[]) => unknown; call: (...args: unknown[]) => unknown } } }).gsap;
      const timeline = gsapApi?.timeline({ defaults: { ease: "power3.out" } });
      const firstWords = renderChunk(chunks[0] || []);
      if (timeline) {
        timeline.to(box, { opacity: 1, y: 0, scale: 1, duration: 0.42 });
        chunks.forEach((chunk, chunkIndex) => {
          if (chunkIndex > 0) timeline.call(() => renderChunk(chunk));
          timeline.to(Array.from(box.querySelectorAll("span")), {
            opacity: 1,
            y: 0,
            color: accentColor,
            stagger: Math.min(0.18, chunkDuration / Math.max(2, chunk.length) / 2),
            duration: 0.28
          });
          timeline.to(box, { opacity: 1, duration: Math.max(0.25, chunkDuration - 0.7) });
          if (chunkIndex < chunks.length - 1) timeline.to(box, { opacity: 0, y: 14, duration: 0.18 });
        });
      } else {
        box.animate([{ opacity: 0, transform: "translateY(26px) scale(.98)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], {
          duration: 420,
          fill: "forwards",
          easing: "cubic-bezier(.2,.8,.2,1)"
        });
        firstWords.forEach((span, index) => {
          span.animate([{ opacity: 0.34, transform: "translateY(9px)" }, { opacity: 1, transform: "translateY(0)" }], {
            duration: 280,
            delay: index * 90,
            fill: "forwards"
          });
        });
      }
    },
    {
      chunks,
      chunkDuration,
      primaryColor: hexToRgba(normalizedTheme.primaryColor, 0.5),
      accentColor: normalizedTheme.accentColor
    }
  );
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

function normalizeTheme(theme?: WebsiteTheme) {
  return {
    primaryColor: safeHex(theme?.primaryColor, "#38bdf8"),
    accentColor: safeHex(theme?.accentColor, "#14b8a6"),
    backgroundColor: safeHex(theme?.backgroundColor, "#050816"),
    surfaceColor: safeHex(theme?.surfaceColor, "#111827"),
    textColor: safeHex(theme?.textColor, "#ffffff"),
    fontFamily: sanitizeFontFamily(theme?.fontFamily || "Inter, ui-sans-serif, system-ui, sans-serif")
  };
}

function safeHex(value: unknown, fallback: string) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function hexToRgba(hex: string, alpha: number) {
  const color = safeHex(hex, "#38bdf8");
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sanitizeFontFamily(value: string) {
  return value
    .split(",")
    .map((part) => part.replace(/[^a-zA-Z0-9 "'-]/g, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(", ") || "Inter, ui-sans-serif, system-ui, sans-serif";
}

function getGsapRuntime() {
  try {
    return readFileSync(path.join(process.cwd(), "node_modules", "gsap", "dist", "gsap.min.js"), "utf8");
  } catch {
    return `window.gsap={timeline:function(){return{to:function(target,vars){var elements=typeof target==="string"?document.querySelectorAll(target):[target].filter(Boolean);elements.forEach(function(el){if(!el||!el.animate)return;var styles={};Object.keys(vars||{}).forEach(function(key){if(["duration","ease","delay"].indexOf(key)===-1)styles[key]=typeof vars[key]==="number"&&key!=="opacity"?vars[key]+"px":vars[key];});el.animate([{},styles],{duration:(vars.duration||.8)*1000,delay:(vars.delay||0)*1000,fill:"forwards",easing:"cubic-bezier(.2,.8,.2,1)"});});return this;}}}};`;
  }
}

function escapeClosingScript(value: string) {
  return value.replace(/<\/script/gi, "<\\/script");
}

function initials(value: string) {
  const parts = compactText(value, 80).split(/\s+/).filter(Boolean);
  if (!parts.length) return "AI";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}
