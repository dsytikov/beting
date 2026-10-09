# Football predictions dashboard

A football predictions dashboard with a static browser UI and a server-side Node.js data endpoint. API tokens are used only by the backend and are never included in browser JavaScript.

## Deploy free on Vercel

1. Sign in to [Vercel](https://vercel.com/) using GitHub.
2. Select **Add New → Project** and import the repository `dsytikov/beting`.
3. Keep the project root at `./`; Vercel detects the Node.js functions under `api/` automatically.
4. In **Project Settings → Environment Variables**, add:
   - `BSD_TOKEN` — token for Bzzoiro Sports Data.
   - `SSTATS_TOKEN` — token for SStats.
5. Deploy and open the generated `vercel.app` URL.

The Hobby plan is free within its limits. Do not upgrade to a paid plan. If Vercel asks for payment details, stop rather than entering them; we can choose another no-card option.

## How it works

- Vercel serves `index.html`, `app.js` and `styles.css` as static assets.
- `api/data.js` runs on the Node.js serverless runtime and calls the data providers.
- `GET /api/data` returns cached data for up to five minutes per warm function instance, otherwise it fetches fresh provider data.
- The dashboard's **Обновить** button sends `POST /api/data` to force a refresh.
- API tokens remain server-side and are not sent to the browser.

This serverless version does not keep a background process running. Data is refreshed when users open the dashboard or click refresh, subject to the short in-memory cache and provider availability. It does not guarantee a background refresh every 30 minutes.

## Local development

Use Node.js 20 or newer:

```sh
npm install
BSD_TOKEN=your_token SSTATS_TOKEN=your_token npm start
```

The standalone server remains available for local use. To generate `data.json` locally:

```sh
BSD_TOKEN=your_token SSTATS_TOKEN=your_token npm run build:data
```

## Data coverage and troubleshooting

The dashboard displays match result, total goals, team xG indicators, corners and yellow cards where the providers expose usable fields. Missing values are shown as an em dash rather than invented.

If the dashboard shows no data, inspect the response from `/api/data` and the Vercel function logs. Confirm both environment variables are configured and that the API tokens have access to the requested endpoints. The SStats endpoint and response fields still need validation against real API responses.
