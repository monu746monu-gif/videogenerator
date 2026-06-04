"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import type { WebsiteData } from "@/lib/types";

type Phase = "idle" | "analyzing" | "recording" | "video";

export default function Home() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [website, setWebsite] = useState<WebsiteData | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [error, setError] = useState("");

  const loadingText = useMemo(() => {
    if (phase === "analyzing") return "Analyzing website...";
    if (phase === "recording") return "Recording browser walkthrough...";
    return "";
  }, [phase]);

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setWebsite(null);
    setVideoUrl("");

    try {
      validateUrlInput(url);
      setPhase("analyzing");
      const analyzed = await postJson<WebsiteData>("/api/analyze-url", { url });
      setWebsite(analyzed);

      setPhase("recording");
      const recorded = await postJson<{ videoUrl: string }>("/api/record-website", { url: analyzed.url });
      setVideoUrl(recorded.videoUrl);
      setPhase("video");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  return (
    <main className="min-h-screen bg-mist">
      <section className="border-b border-line bg-white">
        <div className="mx-auto grid min-h-[92vh] max-w-6xl content-center gap-10 px-5 py-16 md:grid-cols-[1.05fr_0.95fr] md:px-8">
          <div className="flex flex-col justify-center">
            <p className="mb-5 w-fit rounded-full border border-line bg-mist px-4 py-2 text-sm font-semibold text-teal">
              Website to video MVP
            </p>
            <h1 className="max-w-3xl text-5xl font-black leading-[1.02] tracking-normal text-ink md:text-7xl">
              Turn any website into a launch video
            </h1>
            <p className="mt-6 max-w-2xl text-xl leading-8 text-slate-600">
              Paste your product link and get a launch video script + MP4.
            </p>

            <form onSubmit={handleGenerate} className="mt-9 flex flex-col gap-3 sm:flex-row">
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                className="h-14 min-w-0 flex-1 rounded-lg border border-line bg-white px-5 text-base outline-none transition focus:border-action focus:ring-4 focus:ring-blue-100"
              />
              <button
                type="submit"
                disabled={phase === "analyzing" || phase === "recording"}
                className="h-14 rounded-lg bg-action px-7 font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Record MP4
              </button>
            </form>

            {loadingText ? <p className="mt-4 font-semibold text-action">{loadingText}</p> : null}
            {error ? <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p> : null}
          </div>

          <div className="flex items-center">
            <div className="w-full rounded-lg border border-line bg-mist p-4 shadow-soft">
              <div className="relative aspect-[9/16] overflow-hidden rounded-md bg-ink">
                {website?.screenshotUrl ? (
                  <Image
                    src={website.screenshotUrl}
                    alt="Website screenshot"
                    fill
                    sizes="(min-width: 768px) 420px, 90vw"
                    className="object-cover opacity-80"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full flex-col justify-end bg-[linear-gradient(180deg,#E0F2FE_0%,#111827_78%)] p-8 text-white">
                    <div className="mb-4 h-3 w-24 rounded-full bg-coral" />
                    <p className="text-4xl font-black leading-tight">Launch video preview</p>
                    <p className="mt-4 text-lg text-slate-200">Screenshots, animated text, and clean transitions.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {website ? (
        <section className="mx-auto max-w-6xl px-5 py-12 md:px-8">
          <div className="grid gap-6 md:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-lg border border-line bg-white p-6">
              <p className="text-sm font-bold uppercase tracking-wider text-teal">Website summary</p>
              <h2 className="mt-3 text-2xl font-black text-ink">{website.title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">{website.description || website.text.slice(0, 240)}</p>
              <a href={website.url} target="_blank" className="mt-4 block truncate text-sm font-semibold text-action">
                {website.url}
              </a>
              {website.headings.length ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {website.headings.slice(0, 6).map((heading) => (
                    <span key={heading} className="rounded-md bg-mist px-3 py-2 text-xs font-semibold text-slate-700">
                      {heading}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border border-line bg-white p-6">
              <p className="text-sm font-bold uppercase tracking-wider text-teal">Walkthrough recording</p>
              <h2 className="mt-2 text-2xl font-black text-ink">Real browser movement</h2>
              {phase === "recording" ? (
                <div className="mt-6 rounded-lg border border-line bg-mist p-5">
                  <div className="h-2 overflow-hidden rounded-full bg-white">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-action" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-slate-700">Recording can take 20-60 seconds depending on page length.</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {videoUrl ? (
        <section className="border-t border-line bg-white">
          <div className="mx-auto max-w-4xl px-5 py-12 md:px-8">
            <div className="flex flex-col gap-5 rounded-lg border border-line bg-mist p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-2xl font-black text-ink">Your walkthrough MP4 is ready</h2>
                <a href={videoUrl} download className="rounded-lg bg-action px-5 py-3 text-center font-bold text-white hover:bg-blue-700">
                  Download MP4
                </a>
              </div>
              <video src={videoUrl} controls className="mx-auto aspect-[9/16] max-h-[720px] rounded-lg bg-black" />
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

async function postJson<T>(endpoint: string, payload: unknown): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.error || `Request failed: ${endpoint}`);
  }

  return json;
}

function validateUrlInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Enter a website URL.");
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname.includes(".")) {
      throw new Error("Enter a complete website URL.");
    }
  } catch {
    throw new Error("Enter a valid website URL.");
  }
}
