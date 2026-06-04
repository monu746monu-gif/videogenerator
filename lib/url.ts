export function normalizeHttpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter a website URL.");
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  return parsed.toString();
}

export function toPublicPath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}
