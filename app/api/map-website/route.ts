import { NextResponse } from "next/server";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeHttpUrl } from "@/lib/url";
import {
  compactText,
  maxMappedPages,
  type WebsiteBrand,
  type WebsiteMap,
  type WebsiteMapPage,
  type WebsiteSection,
  type WebsiteTheme
} from "@/lib/video-route";
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
    await page.locator("body").waitFor({ state: "attached", timeout: 15000 });
    const theme = await extractWebsiteTheme(page);
    const brand = await extractWebsiteBrand(page, startUrl);

    const homepageLinks = await extractInternalLinks(page, origin);
    const selectedLinks = selectImportantPages(homepageLinks, startUrl, maxMappedPages - 1);
    const selectedPages = uniquePageUrls([startUrl, ...selectedLinks.map((link) => link.href)]).slice(0, maxMappedPages);
    console.log("[map-website] selected pages", selectedPages);

    const pages: WebsiteMapPage[] = [];
    for (const selectedPage of selectedPages) {
      try {
        console.log("[map-website] extracting page", selectedPage);
        await gotoWithFallback(page, selectedPage);
        await page.locator("body").waitFor({ state: "attached", timeout: 12000 });
        pages.push(await extractPageMap(page, selectedPage));
      } catch (error) {
        console.warn("[map-website] skipped failed page", selectedPage, error instanceof Error ? error.message : error);
      }
    }

    const websiteMap: WebsiteMap = {
      startUrl,
      origin,
      selectedPages: pages.map((mappedPage) => mappedPage.url),
      pages,
      brand,
      theme
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

async function extractWebsiteBrand(page: Page, startUrl: string): Promise<WebsiteBrand> {
  const raw = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    };
    const visibleText = (element: Element | null) => (element && isVisible(element) ? normalize(element.textContent || "") : "");
    const header = document.querySelector("header, nav") || document.body;
    const headerRect = header.getBoundingClientRect();
    const headerCandidates = Array.from(header.querySelectorAll<HTMLElement>("a, span, strong, b, div, p"))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: normalize(element.textContent || ""),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
          height: rect.height
        };
      })
      .filter((item) => item.text && item.text.length <= 42 && item.top < Math.max(180, headerRect.bottom + 40));

    const rightBrand = headerCandidates
      .filter((item) => item.left > window.innerWidth * 0.55)
      .sort((a, b) => a.top - b.top || b.right - a.right)[0]?.text;
    const leftBrand = headerCandidates
      .filter((item) => item.left < window.innerWidth * 0.45)
      .sort((a, b) => a.top - b.top || a.left - b.left)[0]?.text;
    const h1 = Array.from(document.querySelectorAll<HTMLElement>("h1")).find(isVisible);
    const heroContainer = (h1?.closest("section, header, main, div") || document.querySelector("main, header, section")) as HTMLElement | null;
    const heroParagraph = heroContainer
      ? Array.from(heroContainer.querySelectorAll<HTMLElement>("p"))
          .filter(isVisible)
          .map((element) => normalize(element.textContent || ""))
          .find(Boolean)
      : "";
    const logoImage = Array.from(header.querySelectorAll<HTMLImageElement>("img"))
      .filter(isVisible)
      .map((image) => ({
        alt: normalize(image.alt || ""),
        src: image.currentSrc || image.src || ""
      }))
      .find((image) => image.alt || image.src);

    return {
      rightBrand,
      leftBrand,
      logo: logoImage?.alt || "",
      logoUrl: logoImage?.src || "",
      title: normalize(document.title || ""),
      heroHeadline: visibleText(h1 || document.querySelector("h2")),
      heroSubheadline: heroParagraph || visibleText(document.querySelector("meta[name='description']"))
    };
  });

  const hostName = new URL(startUrl).hostname.replace(/^www\./, "");
  const name = compactText(raw.rightBrand || raw.logo || raw.leftBrand || raw.title.split(/[|–-]/)[0] || hostName, 80);
  return {
    name,
    logoText: compactText(raw.logo || raw.rightBrand || raw.leftBrand || name, 80),
    logoUrl: raw.logoUrl && /^https?:\/\//i.test(raw.logoUrl) ? raw.logoUrl : undefined,
    heroHeadline: compactText(raw.heroHeadline || raw.title || name, 140),
    heroSubheadline: compactText(raw.heroSubheadline, 180)
  };
}

async function extractWebsiteTheme(page: Page): Promise<WebsiteTheme> {
  const raw = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
    };
    const rgbToHex = (value: string) => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return "";
      return [match[1], match[2], match[3]]
        .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0"))
        .join("")
        .replace(/^/, "#");
    };
    const isUsefulColor = (color: string) => {
      const hex = rgbToHex(color);
      if (!hex) return false;
      const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => parseInt(part, 16));
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max - min > 22 && max > 45 && min < 245;
    };
    const score = new Map<string, number>();
    const add = (color: string, weight: number) => {
      const hex = rgbToHex(color);
      if (!hex || !isUsefulColor(color)) return;
      score.set(hex, (score.get(hex) || 0) + weight);
    };

    const bodyStyle = window.getComputedStyle(document.body);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role='button']")).filter(isVisible).slice(0, 30);
    const headings = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3")).filter(isVisible).slice(0, 20);
    const sections = Array.from(document.querySelectorAll<HTMLElement>("header, main, section, article, div")).filter(isVisible).slice(0, 60);

    buttons.forEach((element) => {
      const style = window.getComputedStyle(element);
      add(style.backgroundColor, 8);
      add(style.color, 4);
      add(style.borderColor, 4);
    });
    headings.forEach((element) => {
      const style = window.getComputedStyle(element);
      add(style.color, 5);
    });
    sections.forEach((element) => {
      const style = window.getComputedStyle(element);
      add(style.backgroundColor, 2);
      add(style.borderColor, 1);
    });

    const palette = Array.from(score.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([color]) => color)
      .slice(0, 6);

    return {
      backgroundColor: rgbToHex(bodyStyle.backgroundColor) || rgbToHex(rootStyle.backgroundColor) || "#050816",
      textColor: rgbToHex(bodyStyle.color) || "#ffffff",
      surfaceColor: palette[2] || rgbToHex(bodyStyle.backgroundColor) || "#111827",
      primaryColor: palette[0] || "#38bdf8",
      accentColor: palette[1] || palette[0] || "#14b8a6",
      fontFamily: normalize(bodyStyle.fontFamily || rootStyle.fontFamily || "Inter, system-ui, sans-serif"),
      colorPalette: palette
    };
  });

  return {
    primaryColor: raw.primaryColor,
    accentColor: raw.accentColor,
    backgroundColor: raw.backgroundColor,
    surfaceColor: raw.surfaceColor,
    textColor: raw.textColor,
    fontFamily: compactText(raw.fontFamily, 120),
    colorPalette: raw.colorPalette.filter(Boolean).slice(0, 6)
  };
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
