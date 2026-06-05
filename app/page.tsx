"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { VideoRoute, VideoScene, WebsiteMap } from "@/lib/video-route";

type Phase = "idle" | "mapping" | "preview" | "rendering" | "video";

type MapResponse = {
  success: boolean;
  websiteMap: WebsiteMap;
};

type RouteResponse = {
  success: boolean;
  videoRoute: VideoRoute;
  warnings?: string[];
};

type RenderResponse = {
  success: boolean;
  jobId: string;
  videoUrl: string;
  previewUrl: string;
  visitedScenes: Array<{
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
  }>;
  script: string;
  warnings: string[];
};

const routeSteps = ["Mapping website...", "Selecting synced scenes...", "Preparing route preview..."];
const renderSteps = ["Opening routed pages...", "Recording each scene...", "Generating scene voiceover...", "Syncing audio and video...", "Combining final MP4..."];

export default function Home() {
  const [url, setUrl] = useState("");
  const [founderName, setFounderName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [loadingStep, setLoadingStep] = useState(0);
  const [websiteMap, setWebsiteMap] = useState<WebsiteMap | null>(null);
  const [videoRoute, setVideoRoute] = useState<VideoRoute | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [visitedScenes, setVisitedScenes] = useState<RenderResponse["visitedScenes"]>([]);
  const [script, setScript] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [privacyMessage, setPrivacyMessage] = useState("");
  const [error, setError] = useState("");

  const activeSteps = phase === "rendering" ? renderSteps : routeSteps;
  const totalDuration = useMemo(() => videoRoute?.scenes.reduce((sum, scene) => sum + scene.estimatedDurationSeconds, 0) || 0, [videoRoute]);

  useEffect(() => {
    if (phase !== "mapping" && phase !== "rendering") return;

    const interval = window.setInterval(() => {
      setLoadingStep((current) => Math.min(current + 1, activeSteps.length - 1));
    }, phase === "rendering" ? 11000 : 5000);

    return () => window.clearInterval(interval);
  }, [activeSteps.length, phase]);

  async function handleCreateRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setVideoUrl("");
    setDownloadUrl("");
    setPrivacyMessage("");
    setVisitedScenes([]);
    setScript("");
    setWarnings([]);
    setWebsiteMap(null);
    setVideoRoute(null);

    try {
      const normalizedUrl = validateUrlInput(url);
      setUrl(normalizedUrl);
      setPhase("mapping");
      setLoadingStep(0);

      const mapped = await postJson<MapResponse>("/api/map-website", { url: normalizedUrl });
      setWebsiteMap(mapped.websiteMap);
      setLoadingStep(1);

      const routed = await postJson<RouteResponse>("/api/generate-video-route", {
        url: normalizedUrl,
        websiteMap: mapped.websiteMap
      });
      setVideoRoute(routed.videoRoute);
      setWarnings(routed.warnings || []);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create route preview.");
      setPhase("idle");
    }
  }

  async function handleRenderSyncedVideo() {
    if (!websiteMap || !videoRoute) {
      setError("Create a route preview before rendering.");
      return;
    }

    try {
      setError("");
      setWarnings([]);
      setPhase("rendering");
      setLoadingStep(0);

      const rendered = await postJson<RenderResponse>("/api/render-synced-video", {
        url,
        founderName,
        websiteMap,
        videoRoute
      });

      setVideoUrl(rendered.previewUrl);
      setDownloadUrl(rendered.videoUrl);
      setPrivacyMessage("");
      setVisitedScenes(rendered.visitedScenes);
      setScript(rendered.script);
      setWarnings(rendered.warnings || []);
      setPhase("video");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render synced video.");
      setPhase("preview");
    }
  }

  return (
    <main className="min-h-screen bg-mist">
      <section className="border-b border-line bg-white">
        <div className="mx-auto grid min-h-[88vh] max-w-6xl content-center gap-10 px-5 py-14 md:grid-cols-[0.95fr_1.05fr] md:px-8">
          <div className="flex flex-col justify-center">
            <p className="mb-5 w-fit rounded-full border border-line bg-mist px-4 py-2 text-sm font-semibold text-teal">
              Route-based synced launch video
            </p>
            <h1 className="max-w-3xl text-5xl font-black leading-[1.02] tracking-normal text-ink md:text-7xl">
              AI Launch Video Generator
            </h1>
            <p className="mt-6 max-w-2xl text-xl leading-8 text-slate-600">
              Paste a product link, preview the 10-scene route, then render a video where each voiceover line matches the visible website section.
            </p>

            <form onSubmit={handleCreateRoute} className="mt-9 grid gap-3">
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                className="h-14 min-w-0 flex-1 rounded-lg border border-line bg-white px-5 text-base outline-none transition focus:border-action focus:ring-4 focus:ring-blue-100"
              />
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={founderName}
                  onChange={(event) => setFounderName(event.target.value)}
                  placeholder="Founder name for final slide"
                  className="h-14 min-w-0 flex-1 rounded-lg border border-line bg-white px-5 text-base outline-none transition focus:border-action focus:ring-4 focus:ring-blue-100"
                />
                <button
                  type="submit"
                  disabled={phase === "mapping" || phase === "rendering"}
                  className="h-14 rounded-lg bg-action px-7 font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  Create Route Preview
                </button>
              </div>
            </form>

            {phase === "preview" || phase === "video" ? (
              <button
                type="button"
                onClick={handleRenderSyncedVideo}
                className="mt-3 w-fit rounded-lg bg-ink px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Generate Synced Video
              </button>
            ) : null}

            {phase === "mapping" || phase === "rendering" ? <p className="mt-4 font-semibold text-action">{activeSteps[loadingStep]}</p> : null}
            {error ? <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p> : null}
            {warnings.length ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex items-center">
            <div className="w-full rounded-lg border border-line bg-mist p-4 shadow-soft">
              <div className="relative aspect-square overflow-hidden rounded-md bg-ink">
                {videoUrl ? (
                  <video src={videoUrl} controls className="h-full w-full bg-black object-contain" />
                ) : (
                  <div className="flex h-full flex-col justify-end bg-[linear-gradient(180deg,#E0F2FE_0%,#111827_78%)] p-8 text-white">
                    <div className="mb-4 h-3 w-24 rounded-full bg-coral" />
                    <p className="text-4xl font-black leading-tight">Synced route preview</p>
                    <p className="mt-3 text-sm font-semibold text-slate-200">Voice is generated per visible scene.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {videoRoute ? (
        <section className="border-t border-line bg-white">
          <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
            <div className="grid gap-6 md:grid-cols-[1fr_0.55fr]">
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-teal">Route preview</p>
                <h2 className="mt-2 text-3xl font-black text-ink">{videoRoute.productName}</h2>
                {videoRoute.tagline ? <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">{videoRoute.tagline}</p> : null}
              </div>
              <div className="rounded-lg border border-line bg-mist p-5">
                <p className="text-sm font-bold text-ink">{videoRoute.scenes.length} scenes</p>
                <p className="mt-2 text-sm text-slate-600">{totalDuration} seconds estimated</p>
                <p className="mt-2 text-sm text-slate-600">{videoRoute.mainPromise}</p>
              </div>
            </div>

            <div className="mt-8 grid gap-4">
              {videoRoute.scenes.map((scene) => (
                <SceneCard key={`${scene.sceneNumber}-${scene.pageUrl}-${scene.targetText}`} scene={scene} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {videoUrl ? (
        <section className="border-t border-line bg-white">
          <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
            <div className="grid gap-6 md:grid-cols-[1fr_0.8fr]">
              <div className="rounded-lg border border-line bg-mist p-6">
                <h2 className="text-2xl font-black text-ink">Generated synced video is ready</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  The final MP4 combines the routed scenes with per-scene voiceover when TTS is available.
                </p>
                <a
                  href={downloadUrl}
                  download
                  onClick={() => setPrivacyMessage("Your video has been downloaded. Generated files are deleted for privacy.")}
                  className="mt-5 inline-block rounded-lg bg-action px-5 py-3 text-center font-bold text-white hover:bg-blue-700"
                >
                  Download MP4
                </a>
                {privacyMessage ? <p className="mt-4 text-sm font-semibold text-teal">{privacyMessage}</p> : null}
              </div>

              <div className="rounded-lg border border-line bg-mist p-6">
                <p className="text-sm font-bold uppercase tracking-wider text-teal">Visited scenes</p>
                <div className="mt-4 grid gap-2">
                  {visitedScenes.map((scene) => (
                    <a key={`${scene.sceneNumber}-${scene.videoUrl}`} href={scene.pageUrl} target="_blank" className="truncate text-sm font-semibold text-action">
                      {scene.sceneNumber}. {scene.title} {scene.clickAdded ? "(clicked)" : scene.sectionFound ? "" : "(fallback)"}
                    </a>
                  ))}
                </div>
              </div>
            </div>

            {script ? (
              <div className="mt-6 rounded-lg border border-line bg-mist p-6">
                <p className="text-sm font-bold uppercase tracking-wider text-teal">Script used</p>
                <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{script}</pre>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function SceneCard({ scene }: { scene: VideoScene }) {
  return (
    <article className="rounded-lg border border-line bg-mist p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wider text-teal">
            Scene {scene.sceneNumber} · {scene.sceneType}
          </p>
          <h3 className="mt-2 text-xl font-black text-ink">{scene.title}</h3>
          <a href={scene.pageUrl} target="_blank" className="mt-2 block truncate text-sm font-semibold text-action">
            {scene.pageUrl}
          </a>
        </div>
        <p className="w-fit rounded-full border border-line bg-white px-3 py-1 text-sm font-bold text-slate-700">
          {scene.estimatedDurationSeconds}s
        </p>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Target text</p>
          <p className="mt-2 text-sm leading-6 text-slate-700">{scene.targetText}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Director action</p>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {scene.visualAction} · {scene.interaction}
          </p>
        </div>
        <div className="md:col-span-2">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Voiceover</p>
          <p className="mt-2 text-sm leading-6 text-slate-700">{scene.voiceover}</p>
        </div>
      </div>
    </article>
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
    return parsed.toString();
  } catch {
    throw new Error("Enter a valid website URL.");
  }
}
