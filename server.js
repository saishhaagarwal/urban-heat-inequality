const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Ignore TLS issues on some networks
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

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
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

  const variance =
    nums.reduce((acc, n) => acc + (n - m) ** 2, 0) /
    (nums.length - 1);

  return Math.sqrt(variance);
}

function pearson(x, y) {
  if (x.length !== y.length || x.length < 2) {
    return 0;
  }

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

async function fetchJson(
  url,
  options = {},
  timeoutMs = 30000,
  retries = 2
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

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
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function probe(url, parser) {
  try {
    const result = await parser(url);

    return {
      ok: true,
      detail: result
    };
  } catch (error) {
    return {
      ok: false,
      detail: error.message
    };
  }
}

async function fetchTemperatureWindow(
  lat,
  lon,
  startDate,
  endDate
) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: startDate,
    end_date: endDate,
    daily: "temperature_2m_mean",
    timezone: "auto"
  });

  const url =
    `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;

  const data = await fetchJson(url);

  const values = data?.daily?.temperature_2m_mean || [];

  return mean(
    values.filter((v) => typeof v === "number")
  );
}

async function handleCities(_req, res) {
  const cities = Object.entries(CITY_CONFIG).map(([id, cfg]) => ({
    id,
    ...cfg
  }));

  sendJson(res, 200, {
    cities,
    defaultWindows: getDefaultWindows()
  });
}

async function handleSources(_req, res) {
  const checks = {
    openMeteo: await probe(
      "https://archive-api.open-meteo.com/v1/archive?latitude=12.9716&longitude=77.5946&start_date=2024-01-01&end_date=2024-01-05&daily=temperature_2m_mean&timezone=auto",
      async (url) => {
        const data = await fetchJson(url);

        return data?.daily?.temperature_2m_mean?.length
          ? "temperature api working"
          : "unexpected payload";
      }
    )
  };

  sendJson(res, 200, {
    checks,
    checkedAt: new Date().toISOString()
  });
}

async function handleAnalyze(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  const cityId =
    reqUrl.searchParams.get("city") || "pune";

  const city = CITY_CONFIG[cityId];

  if (!city) {
    return sendJson(res, 400, {
      error: "Unknown city"
    });
  }

  const windows = getDefaultWindows();

  try {
    const avgTemp = await fetchTemperatureWindow(
      city.center[0],
      city.center[1],
      windows.compareStart,
      windows.compareEnd
    );

    sendJson(res, 200, {
      city: city.name,
      averageTemperature: avgTemp,
      period: {
        start: windows.compareStart,
        end: windows.compareEnd
      }
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message
    });
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
      return fs.readFile(
        path.join(PUBLIC_DIR, "index.html"),
        (indexErr, data) => {

          if (indexErr) {
            return sendText(res, 500, "index.html not found");
          }

          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8"
          });

          res.end(data);
        }
      );
    }

    const ext = path.extname(filePath).toLowerCase();

    const type =
      MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readErr, data) => {

      if (readErr) {
        return sendText(res, 500, "File read error");
      }

      res.writeHead(200, {
        "Content-Type": type
      });

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

  const reqUrl = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (
    req.method === "GET" &&
    reqUrl.pathname === "/api/cities"
  ) {
    return handleCities(req, res);
  }

  if (
    req.method === "GET" &&
    reqUrl.pathname === "/api/sources"
  ) {
    return handleSources(req, res);
  }

  if (
    req.method === "GET" &&
    reqUrl.pathname === "/api/analyze"
  ) {
    return handleAnalyze(req, res);
  }

  if (req.method === "GET") {
    const reqPath =
      reqUrl.pathname === "/"
        ? "index.html"
        : reqUrl.pathname;

    return serveStatic(reqPath, res);
  }

  return sendText(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(
    `Urban Heat app running at http://localhost:${PORT}`
  );
});