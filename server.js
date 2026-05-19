l.predictions[idx].toFixed(3))
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
  console.log(`Urban Heat Inequality app running at http://localhost:${PORT}`);
});