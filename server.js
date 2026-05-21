const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

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
    nums.reduce((acc, n) => acc + (n - m) ** 2, 0) / (nums.length - 1);
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

function handleCities(_req, res) {
  const cities = Object.entries(CITY_CONFIG).map(([id, cfg]) => ({
    id,
    ...cfg
  }));

  sendJson(res, 200, {
    cities,
    defaultWindows: getDefaultWindows()
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

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) return sendText(res, 500, "File read error");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/cities") {
    return handleCities(req, res);
  }

  if (req.method === "GET") {
    const reqPath = reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname;
    return serveStatic(reqPath, res);
  }

  return sendText(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});