import { access, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { convertToMp4, createVideoJob, safeJobDir } from "@/lib/media";
import { normalizeHttpUrl } from "@/lib/url";
import {
  canonicalUrl,
  isAllowedInternalUrl,
  maxSelectedPages,
  safeClickKeywords,
  scoreLink,
  selectImportantPages,
  shouldSkipUrl,
  uniqueLinks,
  type CandidateLink
} from "@/lib/website-links";

const viewport = { width: 1080, height: 1920 };
const maxPages = maxSelectedPages + 1;
const maxPageTimeMs = 12000;
const maxTotalTimeMs = 90000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    const body = (await request.json()) as { url?: unknown; selectedPages?: unknown; jobId?: unknown };
    const startUrl = normalizeHttpUrl(String(body.url || ""));
    const origin = new URL(startUrl).origin;
    const requestedPages = Array.isArray(body.selectedPages)
      ? body.selectedPages.map((pageUrl: unknown) => String(pageUrl)).filter((pageUrl: string) => isAllowedInternalUrl(pageUrl, origin)).slice(0, maxSelectedPages)
      : [];
    const startedAt = Date.now();
    const visitedPages: string[] = [];

    console.log("[record-website] starting URL", startUrl);

    const requestedJobId = typeof body.jobId === "string" ? body.jobId : "";
    const standaloneJob = requestedJobId ? null : await createVideoJob();
    const jobId = requestedJobId || standaloneJob!.jobId;
    const jobRoot = standaloneJob?.rootDir || safeJobDir(jobId);
    const recordingsDir = path.join(jobRoot, "recordings");
    const videosDir = path.join(jobRoot, "final");

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport,
      recordVideo: {
        dir: recordingsDir,
        size: viewport
      },
      userAgent: "Mozilla/5.0 Full Website Walkthrough Recorder MVP"
    });

    const page = await context.newPage();
    const video = page.video();

    await visitAndScroll(page, startUrl, startedAt, true, "Homepage");
    visitedPages.push(canonicalUrl(startUrl));

    const homepageLinks = await extractInternalLinks(page, origin);
    console.log("[record-website] detected internal links count", homepageLinks.length);

    const selectedPages = requestedPages.length
      ? requestedPages.map((href) => ({ href: canonicalUrl(href), text: "", score: 100 }))
      : selectImportantPages(homepageLinks, startUrl, Math.min(maxSelectedPages, maxPages - visitedPages.length));
    console.log("[record-website] selected pages", selectedPages.map((link) => link.href));

    const queue = [...selectedPages];
    const queued = new Set(queue.map((link) => canonicalUrl(link.href)));
    const visited = new Set(visitedPages);

    while (queue.length && visitedPages.length < maxPages && Date.now() - startedAt < maxTotalTimeMs) {
      const next = queue.shift();
      if (!next) break;

      const normalized = canonicalUrl(next.href);
      if (visited.has(normalized) || shouldSkipUrl(next.href, origin)) {
        continue;
      }

      try {
        await visitAndScroll(page, next.href, startedAt, false, labelForUrl(next.href));
        visited.add(normalized);
        visitedPages.push(normalized);
      } catch (error) {
        console.warn("[record-website] skipping failed page", next.href, error instanceof Error ? error.message : error);
        visited.add(normalized);
        continue;
      }

      if (visitedPages.length >= maxPages || Date.now() - startedAt >= maxTotalTimeMs) {
        break;
      }

      const safeLinks = await extractSafeActionLinks(page, origin);
      for (const link of safeLinks) {
        const safeUrl = canonicalUrl(link.href);
        if (visited.has(safeUrl) || queued.has(safeUrl) || shouldSkipUrl(link.href, origin)) {
          continue;
        }

        queue.push(link);
        queued.add(safeUrl);
        if (queue.length + visitedPages.length >= maxPages) {
          break;
        }
      }
    }

    await page.waitForTimeout(1000);
    await context.close();
    context = undefined;

    const rawVideoPath = await video?.path();
    if (!rawVideoPath) {
      throw new Error("Recording file not found.");
    }
    await access(rawVideoPath);
    console.log("[record-website] raw video path", rawVideoPath);

    const outputName = requestedJobId ? "recorded-walkthrough.mp4" : "final-video.mp4";
    const outputPath = path.join(videosDir, outputName);
    await convertToMp4(rawVideoPath, outputPath);
    await unlink(rawVideoPath).catch(() => undefined);

    console.log("[record-website] final MP4 path", outputPath);
    console.log("[record-website] total visited pages", visitedPages.length);

    return NextResponse.json({
      success: true,
      jobId,
      videoUrl: requestedJobId ? `/generated/jobs/${jobId}/final/${outputName}` : `/api/download-video?jobId=${jobId}`,
      previewUrl: `/generated/jobs/${jobId}/final/${outputName}`,
      outputPath,
      visitedPages,
      selectedPages: selectedPages.map((link) => link.href)
    });
  } catch (error) {
    console.error("[record-website] failed", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to record website walkthrough." },
      { status: 500 }
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function visitAndScroll(page: Page, url: string, startedAt: number, returnToTop: boolean, label: string) {
  if (Date.now() - startedAt >= maxTotalTimeMs) {
    return;
  }

  console.log("[record-website] currently visiting page", url);
  await gotoWithFallback(page, url);
  await page.locator("body").waitFor({ state: "visible", timeout: 15000 });
  await showOverlayLabel(page, label);
  await page.waitForTimeout(returnToTop ? 2000 : 1500);

  const pageHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  console.log("[record-website] page height", pageHeight);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await smoothScrollPage(page, Math.min(Date.now() + maxPageTimeMs, startedAt + maxTotalTimeMs));
  await page.waitForTimeout(900);

  if (returnToTop && Date.now() - startedAt < maxTotalTimeMs) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await page.waitForTimeout(1200);
  }
}

async function showOverlayLabel(page: Page, label: string) {
  await page.evaluate((text) => {
    const existing = document.getElementById("__walkthrough_label");
    existing?.remove();

    const labelElement = document.createElement("div");
    labelElement.id = "__walkthrough_label";
    labelElement.textContent = text;
    labelElement.style.position = "fixed";
    labelElement.style.left = "32px";
    labelElement.style.top = "32px";
    labelElement.style.zIndex = "2147483647";
    labelElement.style.padding = "18px 24px";
    labelElement.style.borderRadius = "14px";
    labelElement.style.background = "rgba(17, 24, 39, 0.88)";
    labelElement.style.color = "white";
    labelElement.style.font = "700 32px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    labelElement.style.boxShadow = "0 20px 45px rgba(0, 0, 0, 0.22)";
    labelElement.style.pointerEvents = "none";
    document.documentElement.appendChild(labelElement);
  }, label);
}

function labelForUrl(href: string) {
  const pathname = new URL(href).pathname;
  const segment = pathname.split("/").filter(Boolean).pop() || "Page";
  return segment
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function gotoWithFallback(page: Page, url: string) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  } catch {
    console.warn("[record-website] networkidle timeout or navigation issue, retrying with domcontentloaded", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
  }
}

async function smoothScrollPage(page: Page, deadline: number) {
  while (Date.now() < deadline) {
    const position = await page.evaluate(() => ({
      totalHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewportHeight: window.innerHeight,
      currentScroll: window.scrollY
    }));

    if (position.currentScroll >= position.totalHeight - position.viewportHeight - 8) {
      break;
    }

    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(250);
  }
}

async function extractInternalLinks(page: Page, origin: string): Promise<CandidateLink[]> {
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .filter((anchor) => {
        const rect = anchor.getBoundingClientRect();
        const style = window.getComputedStyle(anchor);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        text: (anchor.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()
      }))
  );

  return uniqueLinks(
    links
      .filter((link) => isAllowedInternalUrl(link.href, origin))
      .map((link) => ({ ...link, score: scoreLink(link) }))
  );
}

async function extractSafeActionLinks(page: Page, origin: string): Promise<CandidateLink[]> {
  const links = await extractInternalLinks(page, origin);
  return links
    .filter((link) => safeClickKeywords.some((keyword) => link.text.includes(keyword)))
    .filter((link) => !shouldSkipUrl(link.href, origin))
    .slice(0, 2);
}
