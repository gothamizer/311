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

## Notes

- The dashboard is generated from the live NYC Open Data 311 feed with a rolling three-year window.
- `npm run refresh:data` writes the static dashboard payloads into [public/data](/Users/uzairqadir/Projects/work/311/public/data).
- The ranked queue is built from current active alerts, while the category explorer loads heavier entity detail on demand.
- Community-board maps stay at the Problem level; Problem Detail scoring is restricted to the biggest complaint categories to keep the detail layer useful instead of noisy.
