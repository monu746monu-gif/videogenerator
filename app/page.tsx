"use client";

import { FormEvent, useEffect, useState } from "react";

type Phase = "idle" | "generating" | "video";

type LaunchVideoResponse = {
  success: boolean;
  videoUrl: string;
  script: string;
  productName: string;
  tagline: string;
  selectedPages: string[];
};

type RecordResponse = {
  success: boolean;
  videoUrl: string;
  visitedPages: string[];
};

const loadingSteps = [
  "Analyzing website...",
  "Recording walkthrough...",
  "Writing voice script...",
  "Generating voiceover...",
  "Creating final video..."
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [loadingStep, setLoadingStep] = useState(0);
  const [videoUrl, setVideoUrl] = useState("");
  const [script, setScript] = useState("");
  const [productName, setProductName] = useState("");
  const [tagline, setTagline] = useState("");
  const [selectedPages, setSelectedPages] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (phase !== "generating") return;

    const interval = window.setInterval(() => {
      setLoadingStep((current) => Math.min(current + 1, loadingSteps.length - 1));
    }, 9000);

    return () => window.clearInterval(interval);
  }, [phase]);

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runGeneration("/api/generate-launch-video", true);
  }

  async function handleRecordOnly() {
    await runGeneration("/api/record-website", false);
  }

  async function runGeneration(endpoint: string, withVoice: boolean) {
    setError("");
    setVideoUrl("");
    setScript("");
    setProductName("");
    setTagline("");
    setSelectedPages([]);

    try {
      validateUrlInput(url);
      setPhase("generating");
      setLoadingStep(0);

      if (withVoice) {
        const generated = await postJson<LaunchVideoResponse>(endpoint, { url });
        setVideoUrl(generated.videoUrl);
        setScript(generated.script);
        setProductName(generated.productName);
        setTagline(generated.tagline);
        setSelectedPages(generated.selectedPages);
      } else {
        const recorded = await postJson<RecordResponse>(endpoint, { url });
        setVideoUrl(recorded.videoUrl);
        setSelectedPages(recorded.visitedPages);
      }

      setPhase("video");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate video.");
      setPhase("idle");
    }
  }

  return (
    <main className="min-h-screen bg-mist">
      <section className="border-b border-line bg-white">
        <div className="mx-auto grid min-h-[92vh] max-w-6xl content-center gap-10 px-5 py-16 md:grid-cols-[0.95fr_1.05fr] md:px-8">
          <div className="flex flex-col justify-center">
            <p className="mb-5 w-fit rounded-full border border-line bg-mist px-4 py-2 text-sm font-semibold text-teal">
              Website to launch video MVP
            </p>
            <h1 className="max-w-3xl text-5xl font-black leading-[1.02] tracking-normal text-ink md:text-7xl">
              AI Launch Video Generator
            </h1>
            <p className="mt-6 max-w-2xl text-xl leading-8 text-slate-600">
              Paste your product link and get a website walkthrough video with voice explanation.
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
                disabled={phase === "generating"}
                className="h-14 rounded-lg bg-action px-7 font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Generate Launch Video
              </button>
            </form>

            <button
              type="button"
              onClick={handleRecordOnly}
              disabled={phase === "generating"}
              className="mt-3 w-fit rounded-lg border border-line bg-white px-5 py-3 text-sm font-bold text-ink transition hover:bg-mist disabled:cursor-not-allowed disabled:text-slate-400"
            >
              Record silent walkthrough only
            </button>

            {phase === "generating" ? <p className="mt-4 font-semibold text-action">{loadingSteps[loadingStep]}</p> : null}
            {error ? <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p> : null}
          </div>

          <div className="flex items-center">
            <div className="w-full rounded-lg border border-line bg-mist p-4 shadow-soft">
              <div className="relative aspect-[9/16] overflow-hidden rounded-md bg-ink">
                {videoUrl ? (
                  <video src={videoUrl} controls className="h-full w-full bg-black object-contain" />
                ) : (
                  <div className="flex h-full flex-col justify-end bg-[linear-gradient(180deg,#E0F2FE_0%,#111827_78%)] p-8 text-white">
                    <div className="mb-4 h-3 w-24 rounded-full bg-coral" />
                    <p className="text-4xl font-black leading-tight">Generated video preview</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {videoUrl ? (
        <section className="border-t border-line bg-white">
          <div className="mx-auto max-w-5xl px-5 py-12 md:px-8">
            <div className="grid gap-6 md:grid-cols-[1fr_0.8fr]">
              <div className="rounded-lg border border-line bg-mist p-6">
                <h2 className="text-2xl font-black text-ink">Generated video is ready</h2>
                {productName ? <p className="mt-3 text-sm font-semibold text-slate-700">{productName}</p> : null}
                {tagline ? <p className="mt-2 text-sm leading-6 text-slate-600">{tagline}</p> : null}
                <a href={videoUrl} download className="mt-5 inline-block rounded-lg bg-action px-5 py-3 text-center font-bold text-white hover:bg-blue-700">
                  Download MP4
                </a>
              </div>

              <div className="rounded-lg border border-line bg-mist p-6">
                <p className="text-sm font-bold uppercase tracking-wider text-teal">Pages shown</p>
                <div className="mt-4 grid gap-2">
                  {selectedPages.map((pageUrl) => (
                    <a key={pageUrl} href={pageUrl} target="_blank" className="truncate text-sm font-semibold text-action">
                      {pageUrl}
                    </a>
                  ))}
                </div>
              </div>
            </div>

            {script ? (
              <div className="mt-6 rounded-lg border border-line bg-mist p-6">
                <p className="text-sm font-bold uppercase tracking-wider text-teal">Voice script</p>
                <p className="mt-3 text-sm leading-6 text-slate-700">{script}</p>
              </div>
            ) : null}
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
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".")) {
      throw new Error("Enter a complete website URL.");
    }
  } catch {
    throw new Error("Enter a valid website URL.");
  }
}
