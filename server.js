const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 3000;
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(text);
}

function handleCities(_req, res) {
  const cities = Object.entries(CITY_CONFIG).map(([id, cfg]) => ({
    id,
    ...cfg
  }));

  sendJson(res, 200, { cities });
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