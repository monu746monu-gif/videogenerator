# Website Launch Video Generator MVP

Paste a product or website URL, analyze the homepage, generate a 5-scene launch video storyboard, render a vertical MP4 with Remotion, and download the result.

## Stack

- Next.js
- TypeScript
- Tailwind CSS
- Node API routes
- Playwright for screenshots
- Cheerio for title, meta, headings, and page text scraping
- OpenAI or Gemini for storyboard generation
- Remotion for MP4 rendering

## Install

```bash
npm install
npx playwright install chromium
```

## Environment

Copy the example file and add at least one API key if you want AI-generated storyboard copy.

```bash
cp .env.example .env.local
```

```bash
OPENAI_API_KEY=
GEMINI_API_KEY=
```

If no API key is configured, the app uses a simple local fallback storyboard so the local flow still works.

## Run

```bash
npm run dev
```

Open `http://localhost:3000`.

## Generate A Video

1. Paste a full website URL, for example `https://example.com`.
2. Click `Generate`.
3. Wait for website analysis and storyboard generation.
4. Click `Generate MP4`.
5. Preview and download the MP4.

Generated assets are written to:

- Screenshots: `public/generated/screenshots`
- Videos: `public/generated/videos`

## API Routes

- `POST /api/analyze-url`
  - Body: `{ "url": "https://example.com" }`
  - Returns extracted website data and a screenshot path.

- `POST /api/generate-storyboard`
  - Body: website data returned from `/api/analyze-url`
  - Returns `{ "scenes": [...] }` with five launch video scenes.

- `POST /api/render-video`
  - Body: `{ "storyboard": [...], "screenshotPath": "/absolute/path/to/screenshot.png" }`
  - Returns `{ "videoUrl": "/generated/videos/..." }`.

## Common Errors

- `Executable doesn't exist` or Playwright browser errors:
  - Run `npx playwright install chromium`.

- OpenAI or Gemini generation failed:
  - Check `.env.local`.
  - Restart `npm run dev` after changing environment variables.
  - The app falls back only when no key is configured. Invalid keys return an error.

- Render fails with browser or codec errors:
  - Confirm Playwright Chromium is installed.
  - Confirm the screenshot exists in `public/generated/screenshots`.
  - Try a shorter storyboard duration while testing locally.

- Website analysis fails:
  - Confirm the URL is public and reachable.
  - Some sites block scraping or automated screenshots.
  - Try another URL to verify the local setup.

## Scope

This MVP intentionally does not include authentication, payments, dashboards, databases, AI avatars, or social posting.
