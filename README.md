# NYC 311 Anomaly Desk

Dense anomaly surveillance workspace for current NYC 311 complaint patterns.

## Run

```bash
npm install
npm run dev
```

## Verify

```bash
npm run lint
npm run build
```

## Notes

- The interface opens on the ranked current queue, with fixed panes for `7D`, `MTD`, `QTD`, and `YTD`.
- The map uses official NYC community-district geometry.
- QTD and YTD charts compare the current period against expected pace plus multiple prior periods; shorter horizons use trailing charts.
