# Football predictions dashboard

A small Node.js web service for a daily football predictions dashboard. It serves the UI and refreshes prediction data server-side, so API tokens are never exposed in browser JavaScript.

## Deploy on Render (without GitHub Actions)

1. Open the Render dashboard and choose **New → Blueprint**.
2. Connect the GitHub account if needed and select this repository: `dsytikov/beting`.
3. Render detects `render.yaml` and creates the `beting-dashboard` web service.
4. Set the environment variables `BSD_TOKEN` and `SSTATS_TOKEN` in the Render service's Environment settings. Use the actual API tokens; never put them in repository files.
5. Wait for the first deploy, then open the public `onrender.com` URL shown by Render.

Render auto-deploys when new commits land on the configured branch. GitHub Actions is not required.

## How refresh works

- The Node.js service listens on the `PORT` provided by Render and exposes `/healthz` for health checks.
- At startup it runs `scripts/build-data.js`, which requests data from Bzzoiro and SStats and writes `data.json`.
- It attempts another refresh every 30 minutes while the service is running.
- When the JSON is older than 30 minutes, a request to `/data.json` triggers a refresh. The dashboard's **Обновить** button also requests a refresh.
- Tokens are read from Render environment variables on the server only.

## Free-plan notes

Render's free web services can spin down after inactivity and have an ephemeral filesystem. This service refreshes on startup and on demand, but it is not a guarantee of unattended, exact 30-minute refreshes while the service is asleep. For continuously scheduled refreshes, choose a suitable paid service or a separate scheduler.

## Data coverage

The dashboard shows match result, total goals, team expected-goal indicators, corners and yellow cards where the providers expose usable fields. Missing data is shown as an em dash; it is not invented. The SStats endpoint and response fields still need validation against the account's real API responses.

## Troubleshooting

- Check the Render service's **Logs** for API errors.
- Check that both tokens are set in the Render service's **Environment** settings and that the tokens have access to the relevant endpoints.
- Open `/healthz` on the deployed service; it should return `{"ok":true}`.
- If a provider returns an unexpected response format, update `scripts/build-data.js` based on the provider's actual response schema.
