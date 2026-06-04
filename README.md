# AI Launch Video Generator MVP

Paste a product or website URL and generate a vertical walkthrough video with an AI-written voice explanation.

## Stack

- Next.js
- TypeScript
- Tailwind CSS
- Playwright for website analysis and walkthrough recording
- Gemini for voice script generation
- OpenAI TTS for voiceover audio
- FFmpeg for video/audio processing

## Install

```bash
npm install
npx playwright install chromium
brew install ffmpeg
```

## Environment

Copy the example file and add your keys:

```bash
cp .env.example .env.local
```

```bash
GEMINI_API_KEY=
OPENAI_API_KEY=
```

Gemini is used to write the launch-video voice script. If `GEMINI_API_KEY` is missing or Gemini fails, the app uses a simple fallback script from scraped website data.

OpenAI TTS is used to generate the voiceover MP3. `OPENAI_API_KEY` is required for the full voice launch-video flow. If it is missing, the API returns a clear error. The silent walkthrough recorder still works without OpenAI.

FFmpeg converts Playwright recordings to MP4 and merges voiceover audio with the walkthrough video.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Generate A Launch Video

1. Paste a product or website URL.
2. Click `Generate Launch Video`.
3. The app analyzes the site, records a walkthrough, writes a voice script, generates voiceover audio, and merges audio/video.
4. Preview and download the final MP4.

The page also includes a secondary `Record silent walkthrough only` button that keeps the simple Playwright recording feature available.

Generated assets are written to:

- Raw recordings: `public/generated/recordings`
- Voiceover audio: `public/generated/audio`
- Final videos: `public/generated/videos`

## API Routes

- `POST /api/analyze-url`
  - Body: `{ "url": "https://example.com" }`
  - Returns product name, tagline, description, detected features, CTA, and selected internal pages.

- `POST /api/record-website`
  - Body: `{ "url": "https://example.com", "selectedPages": ["https://example.com/pricing"] }`
  - Records a silent multi-page walkthrough and returns an MP4 URL/path.

- `POST /api/generate-voice-script`
  - Body: website analysis data.
  - Returns `{ "script": "..." }`.

- `POST /api/generate-voiceover`
  - Body: `{ "script": "..." }`
  - Returns an MP3 file path/URL when `OPENAI_API_KEY` is configured.

- `POST /api/generate-launch-video`
  - Body: `{ "url": "https://example.com" }`
  - Orchestrates analysis, recording, script generation, TTS, and FFmpeg merge.

## Limits

- Maximum recording length: 90 seconds.
- Maximum selected internal pages: 5.
- Login, signup, auth, checkout, cart, payment, billing, external, social, and file-download links are skipped.
- If one internal page fails during recording, the app continues with the next safe page where possible.

## Common Errors

- Playwright browser errors:
  - Run `npx playwright install chromium`.

- FFmpeg errors:
  - Run `brew install ffmpeg`.
  - Or set `FFMPEG_PATH` in `.env.local`.

- Voiceover error:
  - Add `OPENAI_API_KEY` to `.env.local`.
  - Restart `npm run dev` after editing environment variables.

- Script generation error:
  - Add `GEMINI_API_KEY` to `.env.local`.
  - If Gemini is unavailable, fallback script generation is used.

## Scope

This MVP intentionally does not include authentication, payments, dashboards, databases, AI avatars, or social posting.
