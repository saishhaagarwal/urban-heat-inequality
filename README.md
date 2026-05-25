# Mapping Urban Heat Inequality in Indian Cities

A browser-first Node.js project that analyzes urban heat differences across city zones in India using open data APIs.

## What this app does

- Checks if external data APIs are accessible.
- Builds a zone-level dataset for a selected city.
- Computes heat delta between baseline and comparison periods.
- Uses OpenStreetMap-derived proxies for green share, built density, and water share.
- Fits a multivariate linear model and estimates feature influence.
- Visualizes results with:
  - interactive heat inequality map
  - feature importance bars
  - correlation panel
  - scatter plot and vulnerability ranking table

## Data sources

- Open-Meteo archive API (historical temperature)
- OpenStreetMap Overpass API (urban form proxies)
- Nominatim (geocoding availability check)

## Run locally

```bash
npm start
```

Open:

- http://localhost:3000

## If you want to use Live Server

1. Keep backend running with `npm start` (port 3000).
2. Open `public/index.html` via Live Server.
3. In the UI, set **Backend URL** to `http://localhost:3000`.

## Notes

- Grid sizes above 5x5 can be slow because each zone triggers API calls.
- Overpass can throttle under heavy load; the app has graceful fallbacks.
- In managed enterprise networks, TLS interception can break Node HTTPS verification. This project enables a local fallback by default. Set `ALLOW_INSECURE_TLS=0` to disable it.
- This is a strong foundation to extend with ward shapefiles, Landsat LST, and socioeconomic layers.
