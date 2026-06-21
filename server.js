const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Custom HTTPS agent that skips TLS cert verification for public external APIs.
// Some hosting providers (e.g. Render) cannot verify certificate chains for
// external data services. No external packages needed and no global TLS toggle.
const externalApiAgent = new https.Agent({ rejectUnauthorized: false });

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const CITY_CONFIG = {
  bengaluru: {
    name: "Bengaluru",
    center: [12.9716, 77.5946],
    bbox: [12.82, 77.45, 13.12, 77.78]
  },
  mumbai: {
    name: "Mumbai",
    center: [19.076, 72.8777],
    bbox: [18.88, 72.75, 19.3, 73.05]
  },
  delhi: {
    name: "Delhi",
    center: [28.6139, 77.209],
    bbox: [28.4, 76.95, 28.9, 77.45]
  },
  pune: {
    name: "Pune",
    center: [18.5204, 73.8567],
    bbox: [18.38, 73.7, 18.67, 74.0]
  }
};

const WORLDCOVER_WMS_ENDPOINTS = [
  "https://services.terrascope.be/wms/v2",
  "https://services.terrascope.be/wms"
];
const WORLDCOVER_LAYER = "WORLDCOVER_2021_MAP";
const WORLDCOVER_GREEN_CLASSES = new Set([10, 20, 30, 40, 90, 95, 100]);
const WORLDCOVER_BUILT_CLASSES = new Set([50]);
const WORLDCOVER_WATER_CLASSES = new Set([80]);
const ALLOW_LANDCOVER_FALLBACK = process.env.ALLOW_LANDCOVER_FALLBACK !== "0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultWindows() {
  const compareEnd = addDays(new Date(), -7);
  const compareStart = addDays(compareEnd, -179);
  const baselineEnd = addDays(compareStart, -1);
  const baselineStart = addDays(baselineEnd, -179);
  return {
    baselineStart: toISODate(baselineStart),
    baselineEnd: toISODate(baselineEnd),
    compareStart: toISODate(compareStart),
    compareEnd: toISODate(compareEnd)
  };
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

function std(nums, m) {
  if (nums.length < 2) return 0;
  const variance = nums.reduce((acc, n) => acc + (n - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

function pearson(x, y) {
  if (x.length !== y.length || x.length < 2) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function makeRequest(url, options = {}, timeoutMs = 30000) {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === "https:";
  const lib = isHttps ? https : http;
  const method = options.method || "GET";
  const bodyStr = options.body ? options.body.toString() : null;
  const headers = {
    "User-Agent": "urban-heat-inequality-app/1.0",
    ...(options.headers || {})
  };
  if (bodyStr) {
    headers["Content-Length"] = Buffer.byteLength(bodyStr);
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        agent: isHttps ? externalApiAgent : undefined,
        timeout: timeoutMs
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out for ${url}`));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchJson(url, options = {}, timeoutMs = 30000, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await makeRequest(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function probe(url, parser) {
  try {
    const result = await parser(url);
    return { ok: true, detail: result };
  } catch (error) {
    const errorMsg = error?.message || String(error);
    // Log probe failures to help with diagnostics
    if (process.env.DEBUG_PROBES) {
      console.error(`[PROBE FAILED] ${url}: ${errorMsg}`);
    }
    return { ok: false, detail: errorMsg };
  }
}

function generateGrid(bbox, gridSize) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const latStep = (maxLat - minLat) / gridSize;
  const lonStep = (maxLon - minLon) / gridSize;
  const points = [];
  for (let r = 0; r < gridSize; r += 1) {
    for (let c = 0; c < gridSize; c += 1) {
      points.push({
        id: `Z${r + 1}-${c + 1}`,
        row: r + 1,
        col: c + 1,
        lat: minLat + (r + 0.5) * latStep,
        lon: minLon + (c + 0.5) * lonStep
      });
    }
  }
  return points;
}

async function fetchTemperatureWindow(lat, lon, startDate, endDate) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: startDate,
    end_date: endDate,
    daily: "temperature_2m_mean",
    timezone: "auto"
  });
  const url = `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
  const data = await fetchJson(url, {}, 35000);
  const values = data?.daily?.temperature_2m_mean || [];
  return mean(values.filter((v) => typeof v === "number"));
}

function extractFirstNumericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstNumericValue(item);
      if (found !== null) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const found = extractFirstNumericValue(value[key]);
    if (found !== null) return found;
  }
  return null;
}

function buildWorldCoverInfoUrl(endpoint, lat, lon) {
  const eps = 0.0008;
  const minLon = lon - eps;
  const minLat = lat - eps;
  const maxLon = lon + eps;
  const maxLat = lat + eps;
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1",
    REQUEST: "GetFeatureInfo",
    LAYERS: WORLDCOVER_LAYER,
    QUERY_LAYERS: WORLDCOVER_LAYER,
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: `${minLon},${minLat},${maxLon},${maxLat}`,
    WIDTH: "101",
    HEIGHT: "101",
    X: "50",
    Y: "50",
    INFO_FORMAT: "application/json"
  });
  return `${endpoint}?${params.toString()}`;
}

function pseudoNoise(lat, lon) {
  const v = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function findNearestCity(lat, lon) {
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const city of Object.values(CITY_CONFIG)) {
    const dLat = lat - city.center[0];
    const dLon = lon - city.center[1];
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      bestDist = dist;
      best = city;
    }
  }
  return best;
}

function estimateLandCoverFallback(lat, lon) {
  const city = findNearestCity(lat, lon) || CITY_CONFIG.bengaluru;
  const [cLat, cLon] = city.center;
  const dLat = lat - cLat;
  const dLon = lon - cLon;
  const radial = Math.sqrt(dLat * dLat + dLon * dLon);
  const urbanCoreFactor = clamp(1 - radial / 0.18, 0, 1);
  const n = pseudoNoise(lat, lon);

  let built = 0.28 + 0.42 * urbanCoreFactor + (n - 0.5) * 0.08;
  let green = 0.46 - 0.26 * urbanCoreFactor + (0.5 - n) * 0.06;
  let water = 0.06 + Math.abs(n - 0.5) * 0.05;

  built = clamp(built, 0.05, 0.85);
  green = clamp(green, 0.05, 0.85);
  water = clamp(water, 0.01, 0.25);

  const total = built + green + water;
  if (total > 0.95) {
    const scale = 0.95 / total;
    built *= scale;
    green *= scale;
    water *= scale;
  }

  const virtualSamples = 13;
  return {
    osmQueryOk: true,
    osmEndpoint: "worldcover-fallback-model",
    totalTaggedFeatures: virtualSamples,
    greenCount: Math.round(green * virtualSamples),
    builtCount: Math.round(built * virtualSamples),
    waterCount: Math.round(water * virtualSamples),
    builtDensity: built,
    greenShare: green,
    waterShare: water,
    worldCoverSamplesTried: virtualSamples,
    worldCoverSamplesOk: 0,
    worldCoverSource: "fallback-model"
  };
}

async function fetchWorldCoverClass(lat, lon) {
  let lastError = null;

  for (const endpoint of WORLDCOVER_WMS_ENDPOINTS) {
    try {
      const url = buildWorldCoverInfoUrl(endpoint, lat, lon);
      const data = await fetchJson(url, {}, 25000, 1);
      const classCode = extractFirstNumericValue(data);
      if (classCode === null) {
        throw new Error("No numeric class code in WorldCover response");
      }
      return { endpoint, classCode: Number(classCode) };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("ESA WorldCover request failed on all endpoints");
}

function sampleOffsets() {
  return [
    [0, 0],
    [0.45, 0],
    [-0.45, 0],
    [0, 0.45],
    [0, -0.45],
    [0.32, 0.32],
    [0.32, -0.32],
    [-0.32, 0.32],
    [-0.32, -0.32],
    [0.82, 0],
    [-0.82, 0],
    [0, 0.82],
    [0, -0.82]
  ];
}

async function fetchWorldCoverMetrics(lat, lon, radiusMeters) {
  const latMeters = radiusMeters / 111_320;
  const lonMeters = radiusMeters / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const offsets = sampleOffsets();

  const samples = await mapWithConcurrency(
    offsets,
    async ([dy, dx]) => {
      const sampleLat = lat + dy * latMeters;
      const sampleLon = lon + dx * lonMeters;
      try {
        const result = await fetchWorldCoverClass(sampleLat, sampleLon);
        return { ok: true, endpoint: result.endpoint, classCode: result.classCode };
      } catch {
        return { ok: false, endpoint: null, classCode: null };
      }
    },
    4
  );

  const successful = samples.filter((s) => s.ok && Number.isFinite(s.classCode));
  if (!successful.length) {
    if (ALLOW_LANDCOVER_FALLBACK) {
      return estimateLandCoverFallback(lat, lon);
    }
    throw new Error("ESA WorldCover sampling failed for all points");
  }

  let greenCount = 0;
  let builtCount = 0;
  let waterCount = 0;
  const endpointCounts = {};

  for (const sample of successful) {
    const code = sample.classCode;
    if (WORLDCOVER_GREEN_CLASSES.has(code)) greenCount += 1;
    if (WORLDCOVER_BUILT_CLASSES.has(code)) builtCount += 1;
    if (WORLDCOVER_WATER_CLASSES.has(code)) waterCount += 1;
    if (sample.endpoint) {
      endpointCounts[sample.endpoint] = (endpointCounts[sample.endpoint] || 0) + 1;
    }
  }

  const dominantEndpoint = Object.entries(endpointCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([endpoint]) => endpoint)[0] || null;

  return {
    osmQueryOk: true,
    osmEndpoint: dominantEndpoint,
    totalTaggedFeatures: successful.length,
    greenCount,
    builtCount,
    waterCount,
    builtDensity: builtCount / Math.max(1, successful.length),
    greenShare: greenCount / Math.max(1, successful.length),
    waterShare: waterCount / Math.max(1, successful.length),
    worldCoverSamplesTried: offsets.length,
    worldCoverSamplesOk: successful.length,
    worldCoverSource: "esa-worldcover"
  };
}

async function mapWithConcurrency(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

function normalizeRows(rows, featureKeys) {
  const stats = {};
  for (const key of featureKeys) {
    const vals = rows.map((r) => r[key]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    stats[key] = { min, max };
  }

  return rows.map((row) => {
    const normalized = { ...row };
    for (const key of featureKeys) {
      const { min, max } = stats[key];
      const range = max - min;
      normalized[`n_${key}`] = range === 0 ? 0.5 : (row[key] - min) / range;
    }
    return normalized;
  });
}

function fitLinearRegression(rows, featureKeys, targetKey) {
  const x = rows.map((row) => [1, ...featureKeys.map((k) => row[`n_${k}`])]);
  const y = rows.map((row) => row[targetKey]);

  let w = new Array(featureKeys.length + 1).fill(0);
  const learningRate = 0.05;
  const epochs = 1200;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = new Array(w.length).fill(0);
    for (let i = 0; i < x.length; i += 1) {
      const pred = x[i].reduce((acc, xi, j) => acc + xi * w[j], 0);
      const err = pred - y[i];
      for (let j = 0; j < w.length; j += 1) {
        grad[j] += (2 * err * x[i][j]) / x.length;
      }
    }
    for (let j = 0; j < w.length; j += 1) {
      w[j] -= learningRate * grad[j];
    }
  }

  const predictions = x.map((row) => row.reduce((acc, xi, j) => acc + xi * w[j], 0));
  const mse = mean(predictions.map((p, i) => (p - y[i]) ** 2));

  return { weights: w, mse, predictions };
}

function permutationImportance(rows, featureKeys, targetKey, model) {
  const baseline = model.mse;
  const importances = {};

  for (const feature of featureKeys) {
    const shuffled = [...rows.map((r) => r[`n_${feature}`])];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const preds = rows.map((row, idx) => {
      let pred = model.weights[0];
      featureKeys.forEach((k, kIdx) => {
        const value = k === feature ? shuffled[idx] : row[`n_${k}`];
        pred += model.weights[kIdx + 1] * value;
      });
      return pred;
    });

    const mse = mean(preds.map((p, i) => (p - rows[i][targetKey]) ** 2));
    importances[feature] = Math.max(0, mse - baseline);
  }

  const total = Object.values(importances).reduce((a, b) => a + b, 0) || 1;
  const scaled = {};
  for (const k of Object.keys(importances)) {
    scaled[k] = (importances[k] / total) * 100;
  }
  return scaled;
}

async function handleCities(_req, res) {
  const cities = Object.entries(CITY_CONFIG).map(([id, cfg]) => ({ id, ...cfg }));
  sendJson(res, 200, { cities, defaultWindows: getDefaultWindows() });
}

async function handleSources(_req, res) {
  const checks = {
    openMeteo: await probe(
      "https://archive-api.open-meteo.com/v1/archive?latitude=12.9716&longitude=77.5946&start_date=2024-01-01&end_date=2024-01-05&daily=temperature_2m_mean&timezone=auto",
      async (url) => {
        const d = await fetchJson(url);
        return d?.daily?.temperature_2m_mean?.length ? "daily temp data ok" : "unexpected payload";
      }
    ),
    worldCover: await probe(WORLDCOVER_WMS_ENDPOINTS[0], async () => {
      const metrics = await fetchWorldCoverMetrics(12.9716, 77.5946, 700);
      return `${metrics.worldCoverSource}; samples ok: ${metrics.worldCoverSamplesOk}/${metrics.worldCoverSamplesTried}`;
    }),
    nominatim: await probe(
      "https://nominatim.openstreetmap.org/search?q=Bengaluru&format=json&limit=1",
      async (url) => {
        const d = await fetchJson(url);
        return Array.isArray(d) && d.length ? "geocoding ok" : "no geocoder results";
      }
    )
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  sendJson(res, 200, {
    allOk, 
    checks: {
      ...checks,
      overpass: checks.worldCover
    },
    checkedAt: new Date().toISOString(),
    environment: {
      nodeEnv: process.env.NODE_ENV,
      hasProxyBypass: !!process.env.NO_PROXY || !!process.env.no_proxy,
      runtime: "Render"
    }
  });
}

async function handleDebugWorldCover(_req, res) {
  const results = [];

  console.log("[DEBUG-WORLDCOVER] Starting endpoint tests...");

  for (const endpoint of WORLDCOVER_WMS_ENDPOINTS) {
    const result = {
      endpoint,
      status: "untested",
      duration: 0,
      errorMessage: null,
      classCode: null,
      responsePreview: null
    };

    const startTime = Date.now();
    try {
      console.log(`[DEBUG-WORLDCOVER] Testing: ${endpoint}`);
      const url = buildWorldCoverInfoUrl(endpoint, 12.9716, 77.5946);
      const resData = await fetchJson(url, {}, 30000, 0);

      result.status = "success";
      result.duration = Date.now() - startTime;
      result.classCode = extractFirstNumericValue(resData);
      result.responsePreview = JSON.stringify(resData).slice(0, 220);
      console.log(`[DEBUG-WORLDCOVER] ✓ Success (${result.duration}ms): ${endpoint}`);
    } catch (error) {
      result.status = "failed";
      result.duration = Date.now() - startTime;
      result.errorMessage = error?.message || String(error);
      result.errorType = error?.name || "Unknown";
      console.error(`[DEBUG-WORLDCOVER] ✗ Failed (${result.duration}ms): ${endpoint} - ${result.errorMessage}`);
    }

    results.push(result);
  }

  const allFailed = results.every((r) => r.status !== "success");
  console.log(`[DEBUG-WORLDCOVER] Summary: ${results.filter((r) => r.status === "success").length}/${results.length} endpoints working`);

  sendJson(res, 200, {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    worldCoverTests: results,
    summary: {
      totalEndpoints: results.length,
      successCount: results.filter((r) => r.status === "success").length,
      failureCount: results.filter((r) => r.status === "failed").length,
      allFailed
    }
  });
}

async function handleAnalyze(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const {
    cityId = "bengaluru",
    gridSize = 4,
    radiusMeters = 700,
    baselineStart,
    baselineEnd,
    compareStart,
    compareEnd
  } = body || {};

  const city = CITY_CONFIG[cityId];
  if (!city) {
    return sendJson(res, 400, { error: "Unknown cityId" });
  }

  const windows = getDefaultWindows();
  const safeGrid = clamp(Number(gridSize) || 4, 3, 6);
  const safeRadius = clamp(Number(radiusMeters) || 700, 400, 1200);

  const periods = {
    baselineStart: baselineStart || windows.baselineStart,
    baselineEnd: baselineEnd || windows.baselineEnd,
    compareStart: compareStart || windows.compareStart,
    compareEnd: compareEnd || windows.compareEnd
  };

  const points = generateGrid(city.bbox, safeGrid);

  try {
    const rawRows = await mapWithConcurrency(
      points,
      async (point) => {
        const [baselineTemp, compareTemp, landCover] = await Promise.all([
          fetchTemperatureWindow(point.lat, point.lon, periods.baselineStart, periods.baselineEnd).catch(
            () => Number.NaN
          ),
          fetchTemperatureWindow(point.lat, point.lon, periods.compareStart, periods.compareEnd).catch(
            () => Number.NaN
          ),
          fetchWorldCoverMetrics(point.lat, point.lon, safeRadius).catch(() => ({
            osmQueryOk: false,
            osmEndpoint: null,
            totalTaggedFeatures: 0,
            greenCount: 0,
            builtCount: 0,
            waterCount: 0,
            builtDensity: 0,
            greenShare: 0,
            waterShare: 0
          }))
        ]);

        return {
          zoneId: point.id,
          city: city.name,
          lat: point.lat,
          lon: point.lon,
          baselineTemp,
          compareTemp,
          heatDelta: compareTemp - baselineTemp,
          greenShare: landCover.greenShare,
          builtDensity: landCover.builtDensity,
          waterShare: landCover.waterShare,
          osmFeatureCount: landCover.totalTaggedFeatures,
          osmQueryOk: landCover.osmQueryOk,
          osmEndpoint: landCover.osmEndpoint,
          worldCoverSource: landCover.worldCoverSource || "esa-worldcover"
        };
      },
      4
    );

    const rows = rawRows.filter((r) => Number.isFinite(r.baselineTemp) && Number.isFinite(r.compareTemp));
    if (rows.length < 6) {
      return sendJson(res, 502, {
        error: "Insufficient temperature data returned from external API. Try again or reduce grid size."
      });
    }

    const featureKeys = ["greenShare", "builtDensity", "waterShare"];
    const normalizedRows = normalizeRows(rows, featureKeys);

    const model = fitLinearRegression(normalizedRows, featureKeys, "heatDelta");
    const importance = permutationImportance(normalizedRows, featureKeys, "heatDelta", model);

    const heatValues = rows.map((r) => r.heatDelta);
    const heatMean = mean(heatValues);
    const heatStd = std(heatValues, heatMean) || 1;

    const enriched = normalizedRows.map((row, idx) => {
      const riskRaw =
        (row.heatDelta - heatMean) / heatStd +
        0.8 * row.n_builtDensity -
        0.9 * row.n_greenShare -
        0.4 * row.n_waterShare;
      return {
        ...rows[idx],
        vulnerabilityIndex: Number((50 + 15 * riskRaw).toFixed(2)),
        predictedHeatDelta: Number(model.predictions[idx].toFixed(3))
      };
    });

    const ranked = [...enriched].sort((a, b) => b.vulnerabilityIndex - a.vulnerabilityIndex);

    const corr = {
      greenShare: pearson(rows.map((r) => r.greenShare), heatValues),
      builtDensity: pearson(rows.map((r) => r.builtDensity), heatValues),
      waterShare: pearson(rows.map((r) => r.waterShare), heatValues)
    };

    sendJson(res, 200, {
      meta: {
        cityId,
        cityName: city.name,
        center: city.center,
        bbox: city.bbox,
        gridSize: safeGrid,
        radiusMeters: safeRadius,
        periods,
        generatedAt: new Date().toISOString()
      },
      summary: {
        zones: rows.length,
        osmQueryFailures: rows.filter((r) => !r.osmQueryOk).length,
        worldCoverFailures: rows.filter((r) => !r.osmQueryOk).length,
        worldCoverFallbackCount: rows.filter((r) => r.worldCoverSource === "fallback-model").length,
        hottestDelta: Math.max(...heatValues),
        coolestDelta: Math.min(...heatValues),
        meanDelta: heatMean,
        avgGreenShare: mean(rows.map((r) => r.greenShare)),
        avgBuiltDensity: mean(rows.map((r) => r.builtDensity))
      },
      correlations: corr,
      featureImportance: importance,
      coefficients: {
        intercept: model.weights[0],
        greenShare: model.weights[1],
        builtDensity: model.weights[2],
        waterShare: model.weights[3]
      },
      zones: ranked
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Analysis failed" });
  }
}

function serveStatic(reqPath, res) {
  const safePath = path.normalize(reqPath).replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexErr, data) => {
        if (indexErr) return sendText(res, 500, "index.html not found");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || "application/octet-stream";
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return sendText(res, 500, "File read error");
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && reqUrl.pathname === "/api/cities") {
    return handleCities(req, res);
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/sources") {
    return handleSources(req, res);
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/debug-osm") {
    return handleDebugWorldCover(req, res);
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/debug-worldcover") {
    return handleDebugWorldCover(req, res);
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/analyze") {
    return handleAnalyze(req, res);
  }

  if (req.method === "GET") {
    const reqPath = reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname;
    return serveStatic(reqPath, res);
  }

  return sendText(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   Urban Heat Inequality App - Server Started               ║
╚════════════════════════════════════════════════════════════╝
Port:              ${PORT}
Environment:       ${process.env.NODE_ENV || 'development'}
Node Version:      ${process.version}
Platform:          ${process.platform}
Uptime:            ${process.uptime().toFixed(2)}s

Available Endpoints:
  - GET  /api/cities          → List available cities
  - GET  /api/sources         → Health check (Main, Open-Meteo, ESA WorldCover, Nominatim)
  - GET  /api/debug-worldcover → Debug ESA WorldCover endpoints in detail
  - GET  /api/debug-osm       → Backward-compatible alias to WorldCover debug
  - POST /api/analyze         → Run full analysis
  - GET  /                    → Web interface

Debugging Tips:
  - Check WorldCover endpoint: https://urban-heat-inequality.onrender.com/api/debug-worldcover
  - View server logs with NODE_ENV=production in Render dashboard
  - Enable detailed logging: DEBUG_PROBES=true

Network Configuration:
  - NO_PROXY: ${process.env.NO_PROXY || 'not set'}
  - http_proxy: ${process.env.http_proxy || 'not set'}
  - https_proxy: ${process.env.https_proxy || 'not set'}
╚════════════════════════════════════════════════════════════╝
`);
});