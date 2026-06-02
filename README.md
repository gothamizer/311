# NYC 311 Anomaly Desk

Dense anomaly surveillance workspace for current NYC 311 complaint patterns.

## Run

```bash
npm run refresh:data
npm run dev
```

## Verify

```bash
npm run refresh:data
npm run lint
npm run build
```

## Deployment

The repository includes a GitHub Actions workflow at [.github/workflows/deploy.yml](/Users/uzairqadir/Projects/work/311/.github/workflows/deploy.yml) that refreshes data, builds the static site, and deploys it to GitHub Pages.

It runs on pushes to `main`, manual dispatch, and a daily schedule at 10:17 UTC. In GitHub, set **Settings -> Pages -> Build and deployment -> Source** to **GitHub Actions**.

## Notes

- The dashboard is generated from the live NYC Open Data 311 feed with a rolling three-year window.
- Refreshes choose the latest complete reporting day dynamically by comparing recent daily row counts against same-weekday history. `DASHBOARD_FALLBACK_DATA_LAG_DAYS=3` is used only if the completeness preflight cannot find a usable candidate.
- `npm run refresh:data` writes the static dashboard payloads into [public/data](/Users/uzairqadir/Projects/work/311/public/data).
- The ranked queue is built from all current active alerts, while the category explorer loads heavier entity detail on demand.
- Community-board maps stay at the Problem level; Problem Detail scoring is restricted to the biggest complaint categories to keep the detail layer useful instead of noisy.
