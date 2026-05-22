const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

if (process.env.ALLOW_INSECURE_TLS !== "0") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

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

const GREEN_LANDUSE = new Set([
  "forest",
  "grass",
  "meadow",
  "village_green",
  "recreation_ground",
  "orchard"
]);

const GREEN_LEISURE = new Set(["park", "garden", "nature_reserve", "golf_course"]);
const GREEN_NATURAL = new Set(["wood", "scrub", "grassland", "wetland"]);

const BUILT_LANDUSE = new Set(["residential", "industrial", "commercial", "retail"]);
const WATER_NATURAL = new Set(["water", "wetland"]);
const WATER_LANDUSE = new Set(["reservoir", "basin"]);

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter"
];

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

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

async function fetchJson(url, options = {}, timeoutMs = 30000, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "urban-heat-app/1.0",
          ...(options.headers || {})
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function probe(url, parser) {
  try {
    const result = await parser(url);
    return { ok: true, detail: result };
  } catch (error) {
    return { ok: false, detail: error.message };
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

function classifyOsmElement(el) {
  const tags = el?.tags || {};
  const landuse = tags.landuse;
  const leisure = tags.leisure;
  const natural = tags.natural;
  const waterway = tags.waterway;
  const hasBuilding = Object.prototype.hasOwnProperty.call(tags, "building");

  const green =
    GREEN_LANDUSE.has(landuse) || GREEN_LEISURE.has(leisure) || GREEN_NATURAL.has(natural);
  const built = hasBuilding || BUILT_LANDUSE.has(landuse);
  const water = WATER_NATURAL.has(natural) || WATER_LANDUSE.has(landuse) || Boolean(waterway);

  return { green, built, water };
}

async function fetchOsmProxy(lat, lon, radiusMeters) {
  const query = `[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})[building];
  nwr(around:${radiusMeters},${lat},${lon})[landuse];
  nwr(around:${radiusMeters},${lat},${lon})[leisure];
  nwr(around:${radiusMeters},${lat},${lon})[natural];
  nwr(around:${radiusMeters},${lat},${lon})[waterway];
);
out tags;`;

  let data = null;
  let usedEndpoint = null;
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = new URLSearchParams({ data: query });
      data = await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body
        },
        45000,
        1
      );
      usedEndpoint = endpoint;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!data) {
    throw lastError || new Error("Overpass request failed on all endpoints");
  }

  const elements = Array.isArray(data?.elements) ? data.elements : [];
  let greenCount = 0;
  let builtCount = 0;
  let waterCount = 0;

  for (const el of elements) {
    const cls = classifyOsmElement(el);
    if (cls.green) greenCount += 1;
    if (cls.built) builtCount += 1;
    if (cls.water) waterCount += 1;
  }

  return {
    osmQueryOk: true,
    osmEndpoint: usedEndpoint,
    totalTaggedFeatures: elements.length,
    greenCount,
    builtCount,
    waterCount,
    builtDensity: builtCount / Math.max(1, elements.length),
    greenShare: greenCount / Math.max(1, elements.length),
    waterShare: waterCount / Math.max(1, elements.length)
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
    overpass: await probe("https://overpass-api.de/api/interpreter", async (url) => {
      const q = "[out:json][timeout:10];node(around:500,12.9716,77.5946)[amenity];out 5;";
      const body = new URLSearchParams({ data: q });
      const d = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      return `elements: ${Array.isArray(d?.elements) ? d.elements.length : 0}`;
    })
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  sendJson(res, 200, { allOk, checks, checkedAt: new Date().toISOString() });
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
        const [baselineTemp, compareTemp, osm] = await Promise.all([
          fetchTemperatureWindow(point.lat, point.lon, periods.baselineStart, periods.baselineEnd).catch(
            () => Number.NaN
          ),
          fetchTemperatureWindow(point.lat, point.lon, periods.compareStart, periods.compareEnd).catch(
            () => Number.NaN
          ),
          fetchOsmProxy(point.lat, point.lon, safeRadius).catch(() => ({
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
          greenShare: osm.greenShare,
          builtDensity: osm.builtDensity,
          waterShare: osm.waterShare,
          osmFeatureCount: osm.totalTaggedFeatures,
          osmQueryOk: osm.osmQueryOk,
          osmEndpoint: osm.osmEndpoint
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

    const heatValues = rows.map((r) => r.heatDelta);
    const heatMean = mean(heatValues);

    const ranked = [...rows].sort((a, b) => b.heatDelta - a.heatDelta);

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
        hottestDelta: Math.max(...heatValues),
        coolestDelta: Math.min(...heatValues),
        meanDelta: heatMean,
        avgGreenShare: mean(rows.map((r) => r.greenShare)),
        avgBuiltDensity: mean(rows.map((r) => r.builtDensity))
      },
      zones: ranked
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Analysis failed" });
  }
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
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
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
  console.log(`Urban Heat app running at http://localhost:${PORT}`);
});