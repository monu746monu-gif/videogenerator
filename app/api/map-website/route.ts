import { NextResponse } from "next/server";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeHttpUrl } from "@/lib/url";
import { compactText, maxMappedPages, type WebsiteMap, type WebsiteMapPage, type WebsiteSection } from "@/lib/video-route";
import { canonicalUrl, isAllowedInternalUrl, scoreLink, selectImportantPages, shouldSkipUrl, uniqueLinks, type CandidateLink } from "@/lib/website-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const viewport = { width: 1080, height: 1920 };

export async function POST(request: Request) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    const body = (await request.json()) as { url?: unknown };
    const startUrl = canonicalUrl(normalizeHttpUrl(String(body.url || "")));
    const origin = new URL(startUrl).origin;

    console.log("[map-website] opening homepage", startUrl);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport,
      userAgent: "Mozilla/5.0 Website Route Mapper"
    });

    const page = await context.newPage();
    await gotoWithFallback(page, startUrl);
    await page.locator("body").waitFor({ state: "visible", timeout: 15000 });

    const homepageLinks = await extractInternalLinks(page, origin);
    const selectedLinks = selectImportantPages(homepageLinks, startUrl, maxMappedPages - 1);
    const selectedPages = uniquePageUrls([startUrl, ...selectedLinks.map((link) => link.href)]).slice(0, maxMappedPages);
    console.log("[map-website] selected pages", selectedPages);

    const pages: WebsiteMapPage[] = [];
    for (const selectedPage of selectedPages) {
      try {
        console.log("[map-website] extracting page", selectedPage);
        await gotoWithFallback(page, selectedPage);
        await page.locator("body").waitFor({ state: "visible", timeout: 12000 });
        pages.push(await extractPageMap(page, selectedPage));
      } catch (error) {
        console.warn("[map-website] skipped failed page", selectedPage, error instanceof Error ? error.message : error);
      }
    }

    const websiteMap: WebsiteMap = {
      startUrl,
      origin,
      selectedPages: pages.map((mappedPage) => mappedPage.url),
      pages
    };

    return NextResponse.json({ success: true, websiteMap });
  } catch (error) {
    console.error("[map-website] failed", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to map website." },
      { status: 500 }
    );
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function gotoWithFallback(page: Page, url: string) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    console.warn("[map-website] networkidle timeout, retrying domcontentloaded", url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
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
      .filter((link) => isAllowedInternalUrl(link.href, origin) && !shouldSkipUrl(link.href, origin))
      .map((link) => ({ ...link, score: scoreLink(link) }))
  );
}

async function extractPageMap(page: Page, url: string): Promise<WebsiteMapPage> {
  const raw = await page.evaluate((currentUrl) => {
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    };
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const nearestBlock = (heading: HTMLElement) => heading.closest("section, article, header, main, div") || heading.parentElement || heading;
    const headings = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3")).filter(isVisible).slice(0, 16);

    const sections = headings.map((heading, index) => {
      const container = nearestBlock(heading) as HTMLElement;
      const rect = container.getBoundingClientRect();
      const paragraphs = Array.from(container.querySelectorAll<HTMLElement>("p, li"))
        .filter(isVisible)
        .map((element) => normalize(element.textContent || ""))
        .filter(Boolean)
        .slice(0, 4);
      const buttons = Array.from(container.querySelectorAll<HTMLElement>("a, button"))
        .filter(isVisible)
        .map((element) => normalize(element.textContent || ""))
        .filter(Boolean)
        .slice(0, 6);
      const id = `section-${index + 1}`;
      container.setAttribute("data-synced-section-id", id);

      return {
        id,
        url: currentUrl,
        heading: normalize(heading.textContent || ""),
        text: paragraphs.join(" "),
        buttonTexts: buttons,
        index,
        top: Math.round(rect.top + window.scrollY),
        height: Math.round(rect.height)
      };
    });

    return {
      title: normalize(document.title || ""),
      metaDescription: normalize(document.querySelector("meta[name='description']")?.getAttribute("content") || ""),
      sections
    };
  }, url);

  const fallbackTitle = compactText(raw.title || new URL(url).hostname, 120);
  const sections = raw.sections
    .map(
      (section): WebsiteSection => ({
        id: section.id,
        url,
        heading: compactText(section.heading || fallbackTitle, 140),
        text: compactText(section.text, 450),
        buttonTexts: section.buttonTexts.map((buttonText) => compactText(buttonText, 80)).filter(Boolean).slice(0, 6),
        index: section.index,
        top: section.top,
        height: Math.max(1, section.height)
      })
    )
    .filter((section) => section.heading || section.text)
    .slice(0, 12);

  if (!sections.length) {
    sections.push({
      id: "section-1",
      url,
      heading: fallbackTitle,
      text: compactText(raw.metaDescription, 450),
      buttonTexts: [],
      index: 0,
      top: 0,
      height: viewport.height
    });
  }

  return {
    url,
    title: fallbackTitle,
    metaDescription: compactText(raw.metaDescription, 260),
    sections
  };
}

function uniquePageUrls(urls: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const href of urls) {
    const canonical = canonicalUrl(href);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    output.push(canonical);
  }
  return output;
}
