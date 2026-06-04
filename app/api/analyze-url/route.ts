import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { normalizeHttpUrl } from "@/lib/url";
import type { WebsiteData } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let browser;

  try {
    const body = await request.json();
    const url = normalizeHttpUrl(String(body.url || ""));

    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 Website Launch Video Generator MVP"
      },
      redirect: "follow"
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Website returned ${response.status}. Try another URL.` },
        { status: 400 }
      );
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, svg").remove();

    const title = clean($("title").first().text()) || clean($("meta[property='og:title']").attr("content") || "");
    const description =
      clean($("meta[name='description']").attr("content") || "") ||
      clean($("meta[property='og:description']").attr("content") || "");
    const headings = $("h1, h2")
      .map((_, element) => clean($(element).text()))
      .get()
      .filter(Boolean)
      .slice(0, 12);
    const text = clean($("body").text()).slice(0, 2500);
    const ogImage = absolutize($("meta[property='og:image']").attr("content") || null, url);

    const screenshotDir = path.join(process.cwd(), "public", "generated", "screenshots");
    await mkdir(screenshotDir, { recursive: true });

    const screenshotName = `${Date.now()}-${safeHost(url)}.png`;
    const screenshotPath = path.join(screenshotDir, screenshotName);
    const screenshotUrl = `/generated/screenshots/${screenshotName}`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
    await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const data: WebsiteData = {
      url,
      title: title || new URL(url).hostname,
      description,
      headings,
      text,
      ogImage,
      screenshotPath,
      screenshotUrl
    };

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to analyze website." },
      { status: 400 }
    );
  } finally {
    await browser?.close();
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function absolutize(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function safeHost(value: string): string {
  return new URL(value).hostname.replace(/[^a-z0-9.-]/gi, "-").slice(0, 48);
}
