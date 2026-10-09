# Football predictions dashboard

Static GitHub Pages dashboard for daily football matches.

## GitHub configuration

In **Settings → Secrets and variables → Actions**, add either repository secrets or repository variables:

- `BSD_TOKEN` — API token for [Bzzoiro Sports Data](https://sports.bzzoiro.com/docs/).
- `SSTATS_TOKEN` — API token for [SStats.net](https://api.sstats.net/docs/).

GitHub Actions reads them during the build and writes the API results to `data.json`. The tokens are not inserted into the website files. If the tokens are configured as repository variables, treat them as public values; repository secrets are preferred.

The workflow runs on pushes to `main`, can be started manually from **Actions**, and refreshes every 30 minutes. GitHub Pages serves the generated static JSON; the browser does not call the data providers directly, avoiding browser CORS restrictions.

## Data coverage

BSD documented prediction fields include match-result probabilities, expected goals, totals and corners. Yellow-card predictions are shown as an em dash when a source does not provide them. Missing values are never invented. SStats response fields vary by endpoint; unsupported fields are shown as an em dash.

## Troubleshooting

- Open **Actions → Build predictions and deploy to GitHub Pages** and inspect the latest run.
- If a token is missing or rejected, the dashboard displays the source status and error summary.
- Confirm Pages is enabled with **GitHub Actions** as the build and deployment source.
- The scheduled workflow can be delayed by GitHub; use **Run workflow** to refresh immediately.
