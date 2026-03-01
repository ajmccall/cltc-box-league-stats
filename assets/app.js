const dataUrl = "./data/player-stats.json";
const ACTIVE_BAND_PALETTE = "cltc_vivid";
const BAND_PALETTES = {
  cltc_vivid: {
    light: { odd: "#d8ea9f", even: "#f0db73" },
    dark: { odd: "#3f5e25", even: "#6c6224" }
  },
  cltc_soft: {
    light: { odd: "#e6f2bf", even: "#f8ecc0" },
    dark: { odd: "#314923", even: "#5b5426" }
  },
  cltc_bold: {
    light: { odd: "#b9dd6d", even: "#f3ce3e" },
    dark: { odd: "#4b6e2f", even: "#776a24" }
  }
};

const state = {
  data: null,
  selected: null,
  topGroupByRound: new Map(),
  maxDivision: 1
};

function byId(id) {
  return document.getElementById(id);
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function isDarkMode() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function chartBandColors() {
  const palette = BAND_PALETTES[ACTIVE_BAND_PALETTE] || BAND_PALETTES.cltc_vivid;
  return isDarkMode() ? palette.dark : palette.light;
}

function formatPercent(value) {
  if (value == null) return "-";
  return `${Math.round(value * 100)}%`;
}

function cleanRoundLabel(label, roundId = null) {
  if (!label && roundId == null) return "-";
  const fallback = roundId == null ? "-" : `Round ${roundId}`;
  const trimmed = String(label || "").trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed.replace(/\s*\|\s*LTA - Tennis for Britain\s*$/i, "").trim();
  return cleaned || trimmed || fallback;
}

function roundKey(eventId, roundId) {
  return `${eventId}:${roundId}`;
}

function buildTopGroupMap(data) {
  const map = new Map();
  for (const player of data.players || []) {
    for (const season of player.timeline || []) {
      if (!Number.isFinite(season.groupNumber)) continue;
      const key = roundKey(season.eventId, season.roundId);
      const current = map.get(key);
      if (!Number.isFinite(current) || season.groupNumber < current) {
        map.set(key, season.groupNumber);
      }
    }
  }
  return map;
}

function findMaxDivision(data) {
  let maxDivision = 1;
  for (const player of data.players || []) {
    for (const season of player.timeline || []) {
      if (Number.isFinite(season.groupNumber) && season.groupNumber > maxDivision) {
        maxDivision = season.groupNumber;
      }
    }
  }
  return maxDivision;
}

function fallbackResult(season, topGroupByRound) {
  if (season.withdrawn) {
    return { label: "🚫 Withdrawn", className: "result-withdrawn" };
  }

  if (season.position === 1 && Number.isFinite(season.groupNumber)) {
    const topGroup = topGroupByRound.get(roundKey(season.eventId, season.roundId));
    if (Number.isFinite(topGroup) && season.groupNumber === topGroup) {
      return { label: "🏆 League Champion", className: "result-overall-champion" };
    }
    return { label: "🥇 Box Champ", className: "result-box-champ" };
  }

  switch (season.transition) {
    case "promotion":
      return { label: "⬆️ Promoted", className: "result-promotion" };
    case "relegation":
      return { label: "⬇️ Relegated", className: "result-relegation" };
    case "stayed":
      return { label: "➡️ Stayed", className: "result-stayed" };
    default:
      return { label: "-", className: "result-none" };
  }
}

function parsePlayerFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("player");
  return requested ? requested.trim().toLowerCase() : null;
}

function setPlayerInUrl(name) {
  const url = new URL(window.location.href);
  url.searchParams.set("player", name);
  window.history.replaceState({}, "", url);
}

function renderChart(timeline) {
  const chart = byId("chart");
  chart.innerHTML = "";

  const points = timeline.filter((item) => Number.isFinite(item.groupNumber));
  if (points.length === 0) {
    chart.textContent = "No group movement data found.";
    return;
  }

  const width = 760;
  const height = 220;
  const paddingRight = 20;
  const paddingY = 24;
  const labelAreaWidth = 108;
  const labelBarGap = 8;
  const plotStartX = labelAreaWidth + labelBarGap;
  const minGroup = 1;
  const maxGroup = Math.max(state.maxDivision, ...points.map((p) => p.groupNumber));
  const groupCount = Math.max(1, maxGroup - minGroup + 1);
  const plotTop = paddingY;
  const plotBottom = height - paddingY;
  const plotHeight = plotBottom - plotTop;
  const bandHeight = plotHeight / groupCount;
  const bandInnerPadRatio = 0.08;
  const plotWidth = width - plotStartX - paddingRight;
  const xSlot = points.length > 0 ? plotWidth / points.length : plotWidth;
  const bands = chartBandColors();
  const chartBg = cssVar("--chart-bg", "#f4f8ee");
  const lineColor = cssVar("--chart-line", "#1e78b8");
  const dotColor = cssVar("--chart-dot", "#1e78b8");
  const labelColor = cssVar("--chart-label", "#5e6f62");

  function bandTopForGroup(groupNumber) {
    return plotTop + (groupNumber - minGroup) * bandHeight;
  }

  function yFromStanding(point) {
    const bandTop = bandTopForGroup(point.groupNumber);
    const groupSize = Number.isFinite(point.groupSize) ? point.groupSize : null;
    const position = Number.isFinite(point.position) ? point.position : null;

    if (groupSize && position && groupSize > 1) {
      const normalized = Math.max(0, Math.min(1, (position - 1) / (groupSize - 1)));
      const withinBand = bandInnerPadRatio + normalized * (1 - bandInnerPadRatio * 2);
      return bandTop + withinBand * bandHeight;
    }

    if (groupSize === 1 && position === 1) {
      return bandTop + bandHeight * 0.5;
    }

    return bandTop + bandHeight * 0.5;
  }

  const coords = points.map((point, idx) => ({
    x: plotStartX + xSlot * (idx + 0.5),
    y: yFromStanding(point),
    label: `${cleanRoundLabel(point.roundLabel, point.roundId)} (${point.eventName}) - Group ${point.groupNumber} · Pos ${point.position ?? "-"}${point.groupSize ? `/${point.groupSize}` : ""}`
  }));

  const polyline = coords.map((c) => `${c.x},${c.y}`).join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(height));

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("fill", chartBg);
  svg.appendChild(bg);

  for (let group = minGroup; group <= maxGroup; group += 1) {
    const bandTop = bandTopForGroup(group);
    const fill = group % 2 === 0 ? bands.even : bands.odd;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(plotStartX));
    rect.setAttribute("y", String(bandTop));
    rect.setAttribute("width", String(width - plotStartX - paddingRight));
    rect.setAttribute("height", String(bandHeight));
    rect.setAttribute("fill", fill);
    rect.setAttribute("fill-opacity", "0.85");
    svg.appendChild(rect);

    const y = bandTop + bandHeight * 0.5;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "10");
    label.setAttribute("y", String(y + 4));
    label.setAttribute("fill", labelColor);
    label.setAttribute("font-size", "12");
    label.setAttribute("font-weight", "600");
    label.textContent = `Group ${group}`;
    svg.appendChild(label);
  }

  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path.setAttribute("points", polyline);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", lineColor);
  path.setAttribute("stroke-width", "3");
  svg.appendChild(path);

  for (const point of coords) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(point.x));
    dot.setAttribute("cy", String(point.y));
    dot.setAttribute("r", "5");
    dot.setAttribute("fill", dotColor);

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = point.label;
    dot.appendChild(title);

    svg.appendChild(dot);
  }

  chart.appendChild(svg);
}

function renderSeasons(timeline) {
  const rows = byId("season-rows");
  rows.innerHTML = "";

  for (const season of timeline) {
    const tr = document.createElement("tr");

    const result = season.resultLabel && season.resultClass
      ? { label: season.resultLabel, className: season.resultClass }
      : fallbackResult(season, state.topGroupByRound);

    tr.innerHTML = `
      <td>${cleanRoundLabel(season.roundLabel, season.roundId)}</td>
      <td>${season.groupName || `Group ${season.groupNumber ?? "-"}`}</td>
      <td>${season.position ?? "-"}</td>
      <td>${season.wins ?? 0}</td>
      <td>${season.losses ?? 0}</td>
      <td class="${result.className}">${result.label}</td>
    `;

    rows.appendChild(tr);
  }
}

function renderPlayer(player) {
  byId("empty-state").classList.add("hidden");
  byId("player-view").classList.remove("hidden");

  byId("player-name").textContent = player.name;
  byId("win-rate").textContent = formatPercent(player.winRate);
  byId("career-wl").textContent = `${player.totalWins} / ${player.totalLosses}`;
  byId("promotions").textContent = String(player.promotions ?? 0);
  byId("relegations").textContent = String(player.relegations ?? 0);

  renderChart(player.timeline);
  renderSeasons(player.timeline);
  setPlayerInUrl(player.name);
}

function findPlayerByName(name) {
  if (!name) return null;
  const requested = name.trim().toLowerCase();
  return state.data.players.find((player) => player.name.toLowerCase() === requested) || null;
}

function hydratePlayerOptions() {
  const options = byId("player-options");
  options.innerHTML = "";

  for (const player of state.data.players) {
    const option = document.createElement("option");
    option.value = player.name;
    options.appendChild(option);
  }
}

function bindEvents() {
  const input = byId("player-input");

  const loadSelectedPlayer = () => {
    const player = findPlayerByName(input.value);
    if (!player) return;
    if (state.selected && state.selected.id === player.id) return;
    state.selected = player;
    renderPlayer(player);
  };

  input.addEventListener("input", loadSelectedPlayer);
  input.addEventListener("change", loadSelectedPlayer);
  input.addEventListener("blur", loadSelectedPlayer);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadSelectedPlayer();
    }
  });
}

async function init() {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${dataUrl}: ${response.status}`);
  }

  state.data = await response.json();
  state.topGroupByRound = buildTopGroupMap(state.data);
  state.maxDivision = findMaxDivision(state.data);
  byId("meta").textContent = `Data updated ${new Date(state.data.generatedAt).toLocaleString()} · ${state.data.playerCount} players`;

  hydratePlayerOptions();
  bindEvents();

  const fromUrl = parsePlayerFromUrl();
  if (!fromUrl) return;

  const player = findPlayerByName(fromUrl);
  if (!player) return;

  byId("player-input").value = player.name;
  renderPlayer(player);
}

init().catch((error) => {
  byId("meta").textContent = `Error: ${error.message}`;
});
