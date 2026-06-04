import { NextResponse } from "next/server";
import { chromium, type Browser, type Page } from "playwright";
import { normalizeHttpUrl } from "@/lib/url";
import { isAllowedInternalUrl, scoreLink, selectImportantPages, uniqueLinks, type CandidateLink } from "@/lib/website-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  let browser: Browser | undefined;

  try {
    const body = await request.json();
    const url = normalizeHttpUrl(String(body.url || ""));
    const origin = new URL(url).origin;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await gotoWithFallback(page, url);
    await page.locator("body").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(1000);

    const extracted = await page.evaluate(() => {
      const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
      const visibleText = (selector: string) =>
        Array.from(document.querySelectorAll(selector))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          })
          .map((element) => clean(element.textContent))
          .filter(Boolean);

      const title = clean(document.title);
      const metaDescription = clean(document.querySelector("meta[name='description']")?.getAttribute("content"));
      const h1 = visibleText("h1").slice(0, 3);
      const h2 = visibleText("h2").slice(0, 12);
      const buttons = visibleText("a, button").slice(0, 80);
      const bodyText = clean(document.body?.innerText || "").slice(0, 3000);
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter((anchor) => {
          const rect = anchor.getBoundingClientRect();
          const style = window.getComputedStyle(anchor);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((anchor) => ({
          href: (anchor as HTMLAnchorElement).href,
          text: clean(anchor.textContent).toLowerCase()
        }));

      return { title, metaDescription, h1, h2, buttons, bodyText, links };
    });

    const internalLinks = uniqueLinks(
      extracted.links
        .filter((link) => isAllowedInternalUrl(link.href, origin))
        .map((link) => ({ ...link, score: scoreLink(link) }))
    );
    const selectedPages = selectImportantPages(internalLinks, url).map((link) => link.href);
    const productName = detectProductName(extracted.title, extracted.h1, new URL(url).hostname);
    const tagline = extracted.h1.find((heading) => heading.toLowerCase() !== productName.toLowerCase()) || extracted.metaDescription || extracted.h2[0] || "";
    const features = detectFeatures(extracted.h2, extracted.bodyText);
    const cta = detectCta(extracted.buttons);
    const targetAudience = detectAudience(extracted.bodyText);

    return NextResponse.json({
      productName,
      tagline,
      description: extracted.metaDescription || extracted.bodyText.slice(0, 240),
      features,
      cta,
      targetAudience,
      selectedPages,
      importantLinks: internalLinks.slice(0, 20).map((link: CandidateLink) => ({ href: link.href, text: link.text }))
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to analyze website." },
      { status: 500 }
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function gotoWithFallback(page: Page, url: string) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
  }
}

function detectProductName(title: string, h1: string[], hostname: string) {
  const fromH1 = h1[0]?.trim();
  if (fromH1 && fromH1.length <= 70) return fromH1;

  const fromTitle = title.split(/[|:-]/)[0]?.trim();
  if (fromTitle) return fromTitle;

  return hostname.replace(/^www\./, "").split(".")[0] || "the product";
}

function detectFeatures(headings: string[], bodyText: string) {
  const goodHeadings = headings
    .map((heading) => heading.replace(/\s+/g, " ").trim())
    .filter((heading) => heading.length > 3 && heading.length < 90)
    .filter((heading) => !/cookie|privacy|terms/i.test(heading))
    .slice(0, 5);

  if (goodHeadings.length) return goodHeadings;

  return bodyText
    .split(/[.!?]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25 && sentence.length < 120)
    .slice(0, 4);
}

function detectCta(buttons: string[]) {
  const ctaPatterns = [/get started/i, /try/i, /book/i, /demo/i, /start free/i, /contact/i, /learn more/i, /sign up/i];
  return buttons.find((button) => ctaPatterns.some((pattern) => pattern.test(button))) || buttons[0] || "Visit the website to learn more";
}

function detectAudience(bodyText: string) {
  const audiencePatterns = [
    /for ([a-z0-9 ,&-]+?)(?:\.|,| who| that| to)/i,
    /built for ([a-z0-9 ,&-]+?)(?:\.|,| who| that| to)/i,
    /designed for ([a-z0-9 ,&-]+?)(?:\.|,| who| that| to)/i
  ];

  for (const pattern of audiencePatterns) {
    const match = bodyText.match(pattern);
    if (match?.[1] && match[1].length < 80) return match[1].trim();
  }

  return "";
}
