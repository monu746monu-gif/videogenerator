export type CandidateLink = {
  href: string;
  text: string;
  score: number;
};

export const maxSelectedPages = 5;

export const importantKeywords = [
  "features",
  "product",
  "demo",
  "pricing",
  "about",
  "services",
  "solutions",
  "use-cases",
  "customers",
  "testimonials",
  "case-studies",
  "contact"
];

export const safeClickKeywords = ["get started", "try now", "book demo", "start free", "view demo", "learn more"];

const blockedPathParts = ["login", "signin", "sign-in", "signup", "sign-up", "auth", "checkout", "cart", "payment", "billing"];
const fileExtensions = /\.(pdf|zip|rar|7z|jpg|jpeg|png|gif|webp|svg|mp4|mov|avi|webm|mp3|wav|doc|docx|xls|xlsx|ppt|pptx)$/i;
const socialHosts = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "github.com",
  "discord.gg",
  "discord.com"
];

export function selectImportantPages(links: CandidateLink[], startUrl: string, limit = maxSelectedPages) {
  const start = canonicalUrl(startUrl);
  const important = links
    .filter((link) => canonicalUrl(link.href) !== start)
    .filter((link) => link.score > 0)
    .sort((a, b) => b.score - a.score || a.href.length - b.href.length);

  const fallback = links
    .filter((link) => canonicalUrl(link.href) !== start)
    .filter((link) => link.score === 0)
    .sort((a, b) => a.href.length - b.href.length);

  return uniqueLinks([...important, ...fallback]).slice(0, Math.max(0, limit));
}

export function uniqueLinks(links: CandidateLink[]) {
  const seen = new Set<string>();
  const unique: CandidateLink[] = [];

  for (const link of links) {
    const canonical = canonicalUrl(link.href);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push({ ...link, href: canonical });
  }

  return unique;
}

export function scoreLink(link: Pick<CandidateLink, "href" | "text">) {
  const url = new URL(link.href);
  const target = `${url.pathname.toLowerCase()} ${link.text}`;
  let score = 0;

  importantKeywords.forEach((keyword, index) => {
    if (target.includes(keyword)) {
      score += 100 - index;
    }
  });

  if (safeClickKeywords.some((keyword) => link.text.includes(keyword))) {
    score += 25;
  }

  if (url.pathname.split("/").filter(Boolean).length <= 1) {
    score += 10;
  }

  if (target.includes("blog")) {
    score -= 30;
  }

  return score;
}

export function isAllowedInternalUrl(href: string, origin: string) {
  try {
    if (/^(mailto|tel|sms|javascript):/i.test(href)) return false;
    const url = new URL(href);
    if (url.origin !== origin) return false;
    if (url.hash && `${url.origin}${url.pathname}${url.search}` === origin) return false;
    if (fileExtensions.test(url.pathname)) return false;
    if (socialHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return false;
    if (shouldSkipUrl(url.toString(), origin)) return false;
    return true;
  } catch {
    return false;
  }
}

export function shouldSkipUrl(href: string, origin: string) {
  try {
    const url = new URL(href);
    if (url.origin !== origin) return true;
    const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase();
    return blockedPathParts.some((part) => pathAndQuery.includes(part));
  } catch {
    return true;
  }
}

export function canonicalUrl(href: string) {
  const url = new URL(href);
  url.hash = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}
