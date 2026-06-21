



let map;
let layerGroup;

const els = {
  citySelect: document.getElementById("citySelect"),
  gridSizeSelect: document.getElementById("gridSizeSelect"),
  radiusInput: document.getElementById("radiusInput"),
  backendUrlInput: document.getElementById("backendUrlInput"),
  baselineStart: document.getElementById("baselineStart"),
  baselineEnd: document.getElementById("baselineEnd"),
  compareStart: document.getElementById("compareStart"),
  compareEnd: document.getElementById("compareEnd"),
  checkSourcesBtn: document.getElementById("checkSourcesBtn"),
  runBtn: document.getElementById("runBtn"),
  statusBox: document.getElementById("statusBox"),
  statsSection: document.getElementById("statsSection"),
  importanceBars: document.getElementById("importanceBars"),
  correlationList: document.getElementById("correlationList"),
  zoneTableBody: document.getElementById("zoneTableBody"),
  scatterPlot: document.getElementById("scatterPlot")
};

function detectBackendBase() {
  const remembered = localStorage.getItem("uhi_backend_url");
  if (remembered) return remembered;
  if (window.location.port === "5500") return "http://localhost:3000";
  return "";
}

function getBaseUrl() {
  const value = els.backendUrlInput.value.trim();
  if (!value) return "";
  return value.replace(/\/$/, "");
}

async function api(path, options = {}) {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const error = await res.json();
      if (error?.error) message = error.error;
    } catch {
      // Ignore parse error.
    }
    throw new Error(message);
  }
  return res.json();
}

function setStatus(msg) {
  els.statusBox.textContent = msg;
}

function fmt(num, digits = 3) {
  return Number(num || 0).toFixed(digits);
}

function colorForHeatDelta(delta, min, max) {
  const t = (delta - min) / Math.max(0.0001, max - min);
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(48 + clamped * 205);
  const g = Math.round(180 - clamped * 120);
  const b = Math.round(242 - clamped * 180);
  return `rgb(${r}, ${g}, ${b})`;
}

function initMap(center) {
  if (!map) {
    map = L.map("map", {
      zoomControl: true,
      attributionControl: true
    }).setView(center, 11);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    layerGroup = L.layerGroup().addTo(map);
  } else {
    map.setView(center, 11);
    layerGroup.clearLayers();
  }
}

function renderStats(summary) {
  const items = [
    ["Zones", summary.zones, 0],
    ["Mean Heat Delta (C)", summary.meanDelta, 3],
    ["Hottest Delta (C)", summary.hottestDelta, 3],
    ["Avg Green Share", summary.avgGreenShare, 3],
    ["Avg Built Density", summary.avgBuiltDensity, 3]
  ];

  els.statsSection.innerHTML = items
    .map(
      ([label, value, digits]) => `
      <div class="stat-card">
        <div class="k">${label}</div>
        <div class="v">${fmt(value, digits)}</div>
      </div>
    `
    )
    .join("");
}

function renderFeatureImportance(importance) {
  const entries = Object.entries(importance).sort((a, b) => b[1] - a[1]);
  els.importanceBars.innerHTML = entries
    .map(
      ([key, value]) => `
      <div class="bar-row">
        <span>${key}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, value)}%"></div></div>
        <span>${fmt(value, 1)}%</span>
      </div>
    `
    )
    .join("");
}

function renderCorrelations(correlations) {
  const entries = Object.entries(correlations).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  els.correlationList.innerHTML = entries
    .map(
      ([key, value]) => `
      <div class="corr-item">
        <span>${key}</span>
        <span>${fmt(value, 3)}</span>
      </div>
    `
    )
    .join("");
}

function renderTable(zones) {
  const top = zones.slice(0, 10);
  els.zoneTableBody.innerHTML = top
    .map(
      (z) => `
      <tr>
        <td>${z.zoneId}</td>
        <td>${fmt(z.heatDelta, 3)}</td>
        <td>${fmt(z.greenShare, 3)}</td>
        <td>${fmt(z.builtDensity, 3)}</td>
        <td>${fmt(z.vulnerabilityIndex, 2)}</td>
      </tr>
    `
    )
    .join("");
}

function renderScatter(zones) {
  const svg = els.scatterPlot;
  svg.innerHTML = "";

  const width = 560;
  const height = 320;
  const pad = { top: 18, right: 20, bottom: 40, left: 46 };

  const xVals = zones.map((z) => z.greenShare);
  const yVals = zones.map((z) => z.heatDelta);

  const xMin = Math.min(...xVals);
  const xMax = Math.max(...xVals);
  const yMin = Math.min(...yVals);
  const yMax = Math.max(...yVals);

  const xScale = (x) => pad.left + ((x - xMin) / Math.max(0.0001, xMax - xMin)) * (width - pad.left - pad.right);
  const yScale = (y) => height - pad.bottom - ((y - yMin) / Math.max(0.0001, yMax - yMin)) * (height - pad.top - pad.bottom);

  const axis = document.createElementNS("http://www.w3.org/2000/svg", "g");
  axis.innerHTML = `
    <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="#456d69" stroke-width="1" />
    <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="#456d69" stroke-width="1" />
    <text x="${width / 2}" y="${height - 10}" fill="#9fc3b8" font-size="12" text-anchor="middle">Green Share (ESA WorldCover)</text>
    <text x="14" y="${height / 2}" fill="#9fc3b8" font-size="12" text-anchor="middle" transform="rotate(-90,14,${height / 2})">Heat Delta (C)</text>
  `;
  svg.appendChild(axis);

  for (const z of zones) {
    const cx = xScale(z.greenShare);
    const cy = yScale(z.heatDelta);
    const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    point.setAttribute("cx", String(cx));
    point.setAttribute("cy", String(cy));
    point.setAttribute("r", "4");
    point.setAttribute("fill", "#44d8a8");
    point.setAttribute("opacity", "0.8");
    svg.appendChild(point);
  }
}

function renderMap(meta, zones) {
  initMap(meta.center);

  const deltas = zones.map((z) => z.heatDelta);
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);

  for (const z of zones) {
    const color = colorForHeatDelta(z.heatDelta, min, max);
    const radius = 8 + Math.max(0, z.vulnerabilityIndex - 40) * 0.6;

    const marker = L.circleMarker([z.lat, z.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.52,
      weight: 1
    });

    marker.bindPopup(`
      <b>${z.zoneId}</b><br/>
      Heat delta: ${fmt(z.heatDelta, 3)} C<br/>
      Green share: ${fmt(z.greenShare, 3)}<br/>
      Built density: ${fmt(z.builtDensity, 3)}<br/>
      Vulnerability: ${fmt(z.vulnerabilityIndex, 2)}
    `);

    marker.addTo(layerGroup);
  }
}

async function loadCities() {
  setStatus("Loading city catalog and default analysis windows...");
  const data = await api("/api/cities");

  els.citySelect.innerHTML = data.cities
    .map((city) => `<option value="${city.id}">${city.name}</option>`)
    .join("");

  els.baselineStart.value = data.defaultWindows.baselineStart;
  els.baselineEnd.value = data.defaultWindows.baselineEnd;
  els.compareStart.value = data.defaultWindows.compareStart;
  els.compareEnd.value = data.defaultWindows.compareEnd;

  setStatus("Ready. Click 'Check External Sources' and then 'Run Full Analysis'.");
}

async function checkSources() {
  setStatus("Checking external APIs and datasets...");
  const data = await api("/api/sources");

  const lines = [
    `Checked at: ${new Date(data.checkedAt).toLocaleString()}`,
    `All sources OK: ${data.allOk}`,
    "",
    `Open-Meteo: ${data.checks.openMeteo.ok} (${data.checks.openMeteo.detail})`,
    `ESA WorldCover: ${data.checks.worldCover.ok} (${data.checks.worldCover.detail})`,
    `Nominatim: ${data.checks.nominatim.ok} (${data.checks.nominatim.detail})`
  ];

  setStatus(lines.join("\n"));
}

async function runAnalysis() {
  const payload = {
    cityId: els.citySelect.value,
    gridSize: Number(els.gridSizeSelect.value),
    radiusMeters: Number(els.radiusInput.value),
    baselineStart: els.baselineStart.value,
    baselineEnd: els.baselineEnd.value,
    compareStart: els.compareStart.value,
    compareEnd: els.compareEnd.value
  };

  setStatus("Running analysis. Fetching temperature + ESA WorldCover land-cover features for all zones...");
  els.runBtn.disabled = true;

  try {
    const data = await api("/api/analyze", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    renderStats(data.summary);
    renderFeatureImportance(data.featureImportance);
    renderCorrelations(data.correlations);
    renderTable(data.zones);
    renderScatter(data.zones);
    renderMap(data.meta, data.zones);

    const top = data.zones[0];
    setStatus(
      [
        `Analysis complete for ${data.meta.cityName}.`,
        `Zones analyzed: ${data.summary.zones}`,
        `Mean heat delta: ${fmt(data.summary.meanDelta, 3)} C`,
        `Most vulnerable zone: ${top.zoneId} (index ${fmt(top.vulnerabilityIndex, 2)})`,
        `Generated: ${new Date(data.meta.generatedAt).toLocaleString()}`
      ].join("\n")
    );
  } catch (error) {
    setStatus(`Analysis failed: ${error.message}`);
  } finally {
    els.runBtn.disabled = false;
  }
}

function attachEvents() {
  els.checkSourcesBtn.addEventListener("click", () => {
    checkSources().catch((e) => setStatus(`Source check failed: ${e.message}`));
  });
  els.runBtn.addEventListener("click", runAnalysis);
  els.backendUrlInput.addEventListener("change", () => {
    localStorage.setItem("uhi_backend_url", els.backendUrlInput.value.trim());
  });
}

async function boot() {
  els.backendUrlInput.value = detectBackendBase();
  attachEvents();

  try {
    await loadCities();
    await checkSources();
  } catch (error) {
    setStatus(
      [
        "Failed to connect to backend.",
        "If using Live Server, start Node backend and set Backend URL to http://localhost:3000",
        `Details: ${error.message}`
      ].join("\n")
    );
  }
}

boot();