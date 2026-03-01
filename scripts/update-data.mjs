import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlayerStats } from "./build-stats.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const configPath = path.join(repoRoot, "config/league-config.json");
const rawDir = path.join(repoRoot, "data/raw");
const normalizedPath = path.join(repoRoot, "data/normalized/rounds.json");
const statsPath = path.join(repoRoot, "data/player-stats.json");
const updateMetaPath = path.join(repoRoot, "data/last-update.json");
const runStartedAt = Date.now();
const quietMode = process.env.QUIET_UPDATE_DATA === "1";

function elapsedSeconds() {
  return ((Date.now() - runStartedAt) / 1000).toFixed(1);
}

function logProgress(message) {
  if (quietMode) return;
  console.log(`[update-data +${elapsedSeconds()}s] ${message}`);
}

function logWarning(message) {
  if (quietMode) return;
  console.warn(`[update-data +${elapsedSeconds()}s] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(input) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOutcomeFromCell(text, html) {
  const normalized = `${text} ${html}`.toLowerCase();

  if (/\b(win|won|winner|w)\b/.test(normalized) || /success|green|check|tick/.test(normalized)) {
    return "win";
  }

  if (/\b(loss|lost|loser|l)\b/.test(normalized) || /danger|red|cross|fail/.test(normalized)) {
    return "loss";
  }

  const scores = [...text.matchAll(/(\d+)\s*-\s*(\d+)/g)];
  if (scores.length > 0) {
    let firstSideSetWins = 0;
    let secondSideSetWins = 0;

    for (const score of scores) {
      const left = Number.parseInt(score[1], 10);
      const right = Number.parseInt(score[2], 10);
      if (left > right) firstSideSetWins += 1;
      if (right > left) secondSideSetWins += 1;
    }

    if (firstSideSetWins > secondSideSetWins) return "win";
    if (secondSideSetWins > firstSideSetWins) return "loss";
  }

  return null;
}

function extractRoundMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : null;

  const dateMatch = html.match(/\((\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s+to\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\)/i);

  return {
    title,
    roundStart: dateMatch ? dateMatch[1] : null,
    roundEnd: dateMatch ? dateMatch[2] : null
  };
}

function parseSetCookie(setCookieValue) {
  if (!setCookieValue) return null;
  const firstPart = setCookieValue.split(";")[0]?.trim();
  if (!firstPart) return null;
  const eqIdx = firstPart.indexOf("=");
  if (eqIdx <= 0) return null;
  const name = firstPart.slice(0, eqIdx).trim();
  const value = firstPart.slice(eqIdx + 1).trim();
  if (!name) return null;
  return { name, value };
}

function isCookieWall(html) {
  return (
    /action="\/cookiewall\/Save"/i.test(html) &&
    /id="ReturnUrl"/i.test(html) &&
    /message-page/i.test(html)
  );
}

function extractCookieWallReturnUrl(html) {
  const match = html.match(/id="ReturnUrl"[^>]*value="([^"]+)"/i);
  return match ? match[1] : null;
}

function isNotFoundPage(html) {
  if (!html) return false;
  return /404\s*-\s*Page not found/i.test(html) || /can&#39;t seem to find the page/i.test(html);
}

function extractRoundIds(html, eventId) {
  const found = new Set();
  const re = /\/event\/(\d+)\/round\/(\d+)/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const foundEvent = Number.parseInt(match[1], 10);
    const roundId = Number.parseInt(match[2], 10);
    if (Number.isFinite(roundId) && foundEvent === eventId) {
      found.add(roundId);
    }
  }

  return [...found].sort((a, b) => b - a);
}

function parseDrawIdFromUrl(urlPath) {
  const drawMatch = urlPath.match(/[?&]drawID=(\d+)/i);
  if (!drawMatch) return null;
  const drawId = Number.parseInt(drawMatch[1], 10);
  return Number.isFinite(drawId) ? drawId : null;
}

function extractGroupContentDescriptors(html) {
  const descriptors = [];
  const seen = new Set();
  const re = /data-headerurl="([^"]*GetGroupContent\?[^"]+)"/gi;
  let match;

  while ((match = re.exec(html)) !== null) {
    const raw = match[1].replace(/&amp;/g, "&").trim();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    const contextStart = Math.max(0, (match.index ?? 0) - 5000);
    const context = html.slice(contextStart, match.index ?? 0);
    const groupMatches = [...context.matchAll(/Group\s+(\d+)/gi)];
    const nearbyGroupNumber =
      groupMatches.length > 0 ? Number.parseInt(groupMatches[groupMatches.length - 1][1], 10) : null;
    const groupNumber = Number.isFinite(nearbyGroupNumber) ? nearbyGroupNumber : null;
    const drawId = parseDrawIdFromUrl(raw);

    descriptors.push({
      drawId,
      groupNumber,
      groupName: Number.isFinite(groupNumber) ? `Group ${groupNumber}` : null,
      urlPath: raw
    });
  }

  const unnamed = descriptors.filter((d) => !Number.isFinite(d.groupNumber));
  if (unnamed.length > 0) {
    const sortedByDraw = [...descriptors]
      .filter((d) => Number.isFinite(d.drawId))
      .sort((a, b) => a.drawId - b.drawId);
    if (sortedByDraw.length === descriptors.length) {
      for (let i = 0; i < sortedByDraw.length; i += 1) {
        if (!Number.isFinite(sortedByDraw[i].groupNumber)) {
          sortedByDraw[i].groupNumber = i + 1;
          sortedByDraw[i].groupName = `Group ${i + 1}`;
        }
      }
    }
  }

  descriptors.sort((a, b) => {
    if (Number.isFinite(a.groupNumber) && Number.isFinite(b.groupNumber)) {
      return a.groupNumber - b.groupNumber;
    }
    if (Number.isFinite(a.drawId) && Number.isFinite(b.drawId)) {
      return a.drawId - b.drawId;
    }
    return a.urlPath.localeCompare(b.urlPath);
  });

  return descriptors;
}

function detectGroupFromContext(cleanedHtml, rowIndex) {
  const contextStart = Math.max(0, rowIndex - 4000);
  const context = cleanedHtml.slice(contextStart, rowIndex);
  const matches = [...context.matchAll(/Group\s+(\d+)/gi)];
  if (matches.length === 0) return { groupNumber: null, groupName: null };
  const groupNumber = Number.parseInt(matches[matches.length - 1][1], 10);
  if (!Number.isFinite(groupNumber)) return { groupNumber: null, groupName: null };
  return { groupNumber, groupName: `Group ${groupNumber}` };
}

function normalizePlayerName(name) {
  return String(name || "")
    .replace(/\s*\[WDN\]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNameAndIdFromCells(cells) {
  for (const cell of cells) {
    const hrefMatch = cell.html.match(/href="([^"]*\/player\/(\d+)\/event\/\d+\/round\/\d+)"/i);
    if (!hrefMatch) continue;
    const name = normalizePlayerName(stripTags(cell.html));
    if (!name) continue;
    const playerId = Number.parseInt(hrefMatch[2], 10);
    const withdrawn = /title="Withdrawn"/i.test(cell.html) || /<s\b/i.test(cell.html) || /\[WDN\]/i.test(cell.html);
    return {
      name,
      playerId: Number.isFinite(playerId) ? playerId : null,
      withdrawn
    };
  }
  return { name: null, playerId: null, withdrawn: false };
}

function parseIntOrNull(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function getPlayerRoundKey(player) {
  if (Number.isFinite(player.playerId)) {
    return `id:${player.playerId}`;
  }
  return `name:${String(player.name || "").trim().toLowerCase()}`;
}

function playerRowQualityScore(player) {
  let score = 0;
  if (Number.isFinite(player.groupNumber)) score += 100;
  if (Number.isFinite(player.position)) score += 10;
  if (Number.isFinite(player.played)) score += 10;
  if (Number.isFinite(player.wins)) score += 10;
  if (Number.isFinite(player.losses)) score += 10;
  if (Number.isFinite(player.points)) score += 10;
  if (Array.isArray(player.markers)) score += player.markers.length;
  return score;
}

function mergePlayerRows(existing, incoming) {
  const existingScore = playerRowQualityScore(existing);
  const incomingScore = playerRowQualityScore(incoming);

  const primary = incomingScore > existingScore ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;

  return {
    ...secondary,
    ...primary,
    name: primary.name || secondary.name,
    playerId: Number.isFinite(primary.playerId) ? primary.playerId : secondary.playerId,
    groupName: primary.groupName ?? secondary.groupName ?? null,
    groupNumber: Number.isFinite(primary.groupNumber) ? primary.groupNumber : secondary.groupNumber ?? null,
    position: Number.isFinite(primary.position) ? primary.position : secondary.position ?? null,
    played: Number.isFinite(primary.played) ? primary.played : secondary.played ?? null,
    wins: Number.isFinite(primary.wins) ? primary.wins : secondary.wins ?? null,
    losses: Number.isFinite(primary.losses) ? primary.losses : secondary.losses ?? null,
    points: Number.isFinite(primary.points) ? primary.points : secondary.points ?? null,
    withdrawn: Boolean(primary.withdrawn || secondary.withdrawn),
    markers:
      (Array.isArray(primary.markers) ? primary.markers.length : 0) >=
      (Array.isArray(secondary.markers) ? secondary.markers.length : 0)
        ? primary.markers || []
        : secondary.markers || []
  };
}

function parsePlayersFromHtml(html, groupHint = null) {
  const cleaned = html
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const players = [];
  const rowMatches = [...cleaned.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1];
    if (!/\/player\/\d+\/event\/\d+\/round\/\d+/i.test(rowHtml)) continue;

    const cellMatches = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
    const cells = cellMatches.map((cell) => ({
      html: cell[1],
      text: stripTags(cell[1])
    }));

    if (cells.length < 5) continue;

    const { name, playerId, withdrawn } = extractNameAndIdFromCells(cells);
    if (!name) continue;
    if (/player/i.test(name) && !/\s/.test(name)) continue;

    const numericCells = cells
      .map((cell) => parseIntOrNull(cell.text))
      .filter((n) => Number.isFinite(n));

    if (numericCells.length < 4) continue;

    const position = numericCells[0] ?? null;
    const played = numericCells[1] ?? null;
    const wins = numericCells[2] ?? null;
    const losses = numericCells[3] ?? null;
    const points = numericCells[4] ?? null;

    let groupNumber = groupHint?.groupNumber ?? null;
    let groupName = groupHint?.groupName ?? null;
    if (!Number.isFinite(groupNumber)) {
      const detected = detectGroupFromContext(cleaned, rowMatch.index ?? 0);
      groupNumber = detected.groupNumber;
      groupName = detected.groupName;
    }

    const markers = [];
    for (const cell of cells.slice(2)) {
      const outcome = parseOutcomeFromCell(cell.text, cell.html);
      if (outcome) markers.push(outcome);
    }

    players.push({
      name,
      playerId,
      position: Number.isFinite(position) ? position : null,
      groupName,
      groupNumber: Number.isFinite(groupNumber) ? groupNumber : null,
      withdrawn: Boolean(withdrawn || /title="Withdrawn"/i.test(rowHtml) || /<s\b/i.test(rowHtml)),
      played: Number.isFinite(played) ? played : null,
      wins: Number.isFinite(wins) ? wins : null,
      losses: Number.isFinite(losses) ? losses : null,
      points: Number.isFinite(points) ? points : null,
      markers
    });
  }

  const deduped = new Map();
  for (const player of players) {
    const key = getPlayerRoundKey(player);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergePlayerRows(existing, player) : player);
  }

  return [...deduped.values()];
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  updateFromResponse(response) {
    const allSetCookies = response.headers.getSetCookie?.() || [];
    for (const line of allSetCookies) {
      const parsed = parseSetCookie(line);
      if (parsed) this.cookies.set(parsed.name, parsed.value);
    }
  }

  asHeader() {
    if (this.cookies.size === 0) return "";
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function resolveRedirectUrl(currentUrl, locationValue) {
  try {
    return new URL(locationValue, currentUrl).toString();
  } catch {
    return null;
  }
}

async function fetchWithJar(url, userAgent, jar, options = {}) {
  const headers = {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml",
    ...(options.headers || {})
  };

  const cookieHeader = jar.asHeader();
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  let currentUrl = url;
  let method = options.method || "GET";
  let body = options.body;

  for (let redirectCount = 0; redirectCount < 8; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      method,
      headers,
      body,
      redirect: "manual"
    });

    jar.updateFromResponse(response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const nextUrl = resolveRedirectUrl(currentUrl, location);
      if (!nextUrl) {
        return {
          ok: false,
          status: response.status,
          html: ""
        };
      }

      currentUrl = nextUrl;
      method = "GET";
      body = undefined;
      continue;
    }

    return {
      ok: response.ok,
      status: response.status,
      html: await response.text()
    };
  }

  return {
    ok: false,
    status: 310,
    html: ""
  };
}

function seedCookieJarFromHeader(jar, headerValue) {
  if (!headerValue) return;
  const parts = String(headerValue)
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    jar.cookies.set(name, value);
  }
}

async function submitCookieConsent(baseUrl, userAgent, jar, returnUrl) {
  const sendConsent = async (purposes) => {
    const body = new URLSearchParams();
    body.set("ReturnUrl", returnUrl || "/");
    body.set("SettingsOpen", "false");
    for (const purpose of purposes) {
      body.append("CookiePurposes", purpose);
    }

    return fetchWithJar(`${baseUrl}/cookiewall/Save`, userAgent, jar, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: baseUrl,
        referer: `${baseUrl}${returnUrl || "/"}`,
        "upgrade-insecure-requests": "1"
      },
      body: body.toString()
    });
  };

  // First attempt mirrors normal browser submission: checked, enabled purpose boxes.
  await sendConsent(["2", "4", "8", "16"]);

  // Fallback: include all values in case server expects explicit full set.
  await sendConsent(["1", "2", "4", "8", "16"]);

  // Fallback: minimal accept payload.
  await fetchWithJar(`${baseUrl}/cookiewall/Save`, userAgent, jar, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: baseUrl,
      referer: `${baseUrl}${returnUrl || "/"}`,
      "upgrade-insecure-requests": "1"
    },
    body: new URLSearchParams({
      ReturnUrl: returnUrl || "/",
      SettingsOpen: "false"
    }).toString()
  });
}

async function fetchHtml(url, userAgent, jar, baseUrl, notes, logPrefix, requestOptions = {}) {
  let result = await fetchWithJar(url, userAgent, jar, requestOptions);

  if (isCookieWall(result.html)) {
    const returnUrl = extractCookieWallReturnUrl(result.html);
    notes.push(`${logPrefix}: cookie wall encountered, submitting consent.`);
    logProgress(`${logPrefix}: cookie wall encountered, submitting consent.`);
    await submitCookieConsent(baseUrl, userAgent, jar, returnUrl);
    result = await fetchWithJar(url, userAgent, jar, requestOptions);
  }

  return result;
}

function getRoundUrl(baseUrl, ladderId, eventId, roundId) {
  return `${baseUrl}/box-ladder/${ladderId}/event/${eventId}/round/${roundId}`;
}

async function loadConfig() {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function scrapeEvent(config, eventConfig, notes) {
  const rounds = [];
  const discovered = new Set(eventConfig.seedRoundIds || []);
  const jar = new CookieJar();
  logProgress(`Event ${eventConfig.id} (${eventConfig.slug}): start.`);
  seedCookieJarFromHeader(jar, process.env.LTA_COOKIE_HEADER);
  if (process.env.LTA_COOKIE_HEADER) {
    notes.push(`${eventConfig.slug}: using cookies from LTA_COOKIE_HEADER.`);
    logProgress(`Event ${eventConfig.id}: using cookies from LTA_COOKIE_HEADER.`);
  }
  const maxSeed = Math.max(...(eventConfig.seedRoundIds || [config.scan.maxRoundsToTry]));

  for (const seedRoundId of eventConfig.seedRoundIds || []) {
    const seedUrl = getRoundUrl(config.baseUrl, config.ladderId, eventConfig.id, seedRoundId);
    logProgress(`Event ${eventConfig.id}: seed fetch round ${seedRoundId}`);

    try {
      const seedResult = await fetchHtml(
        seedUrl,
        config.scrape.userAgent,
        jar,
        config.baseUrl,
        notes,
        `${eventConfig.slug} seed ${seedRoundId}`
      );
      if (!seedResult.ok) {
        notes.push(`${eventConfig.slug}: seed round ${seedRoundId} returned HTTP ${seedResult.status}`);
        logWarning(`Event ${eventConfig.id}: seed round ${seedRoundId} returned HTTP ${seedResult.status}`);
        continue;
      }

      const discoveredIds = extractRoundIds(seedResult.html, eventConfig.id);
      for (const discoveredRoundId of discoveredIds) {
        discovered.add(discoveredRoundId);
      }
      logProgress(
        `Event ${eventConfig.id}: seed ${seedRoundId} discovered ${discoveredIds.length} round links (unique total ${discovered.size})`
      );
    } catch (error) {
      notes.push(`${eventConfig.slug}: failed seed fetch round ${seedRoundId} (${error.message})`);
      logWarning(`Event ${eventConfig.id}: seed round ${seedRoundId} request failed (${error.message})`);
    }

    await sleep(config.scan.requestDelayMs);
  }

  let roundIds = [...discovered].sort((a, b) => b - a);
  if (roundIds.length === 0) {
    for (let i = maxSeed; i >= config.scan.minRoundId && roundIds.length < config.scan.maxRoundsToTry; i -= 1) {
      roundIds.push(i);
    }
    notes.push(`${eventConfig.slug}: no rounds discovered from links, using fallback scan.`);
    logWarning(`Event ${eventConfig.id}: no rounds discovered from links, using fallback scan (${roundIds.length} candidates).`);
  }
  logProgress(`Event ${eventConfig.id}: scanning ${roundIds.length} rounds.`);

  let misses = 0;

  for (const roundId of roundIds) {
    if (misses >= config.scan.consecutiveMissesToStop) {
      notes.push(`${eventConfig.slug}: stopped after ${misses} consecutive misses.`);
      logWarning(`Event ${eventConfig.id}: stopping after ${misses} consecutive misses.`);
      break;
    }

    const url = getRoundUrl(config.baseUrl, config.ladderId, eventConfig.id, roundId);
    logProgress(`Event ${eventConfig.id}: fetching round ${roundId}`);

    let result;
    try {
      result = await fetchHtml(
        url,
        config.scrape.userAgent,
        jar,
        config.baseUrl,
        notes,
        `${eventConfig.slug} round ${roundId}`
      );
    } catch (error) {
      misses += 1;
      notes.push(`${eventConfig.slug}: round ${roundId} request failed (${error.message})`);
      logWarning(`Event ${eventConfig.id}: round ${roundId} request failed (${error.message})`);
      await sleep(config.scan.requestDelayMs);
      continue;
    }

    if (!result.ok) {
      misses += 1;
      notes.push(`${eventConfig.slug}: round ${roundId} returned HTTP ${result.status}`);
      logWarning(`Event ${eventConfig.id}: round ${roundId} returned HTTP ${result.status}`);
      await sleep(config.scan.requestDelayMs);
      continue;
    }

    misses = 0;

    if (config.scrape.saveRawHtml) {
      const rawPath = path.join(rawDir, `event-${eventConfig.id}-round-${roundId}.html`);
      await fs.writeFile(rawPath, result.html, "utf8");
    }

    const meta = extractRoundMeta(result.html);
    const roundLabel = meta.title || `Round ${roundId}`;
    const groupDescriptors = extractGroupContentDescriptors(result.html);
    const groupUrls = groupDescriptors.map((g) => g.urlPath);
    logProgress(
      `Event ${eventConfig.id} round ${roundId}: fetched "${roundLabel}" with ${groupDescriptors.length} group endpoint(s).`
    );
    const playersByKey = new Map();
    let combinedHtml = result.html;
    for (const player of parsePlayersFromHtml(result.html)) {
      const key = getPlayerRoundKey(player);
      const existing = playersByKey.get(key);
      playersByKey.set(key, existing ? mergePlayerRows(existing, player) : player);
    }

    for (const descriptor of groupDescriptors) {
      const groupPath = descriptor.urlPath;
      const fullGroupUrl = groupPath.startsWith("http") ? groupPath : `${config.baseUrl}${groupPath}`;
      logProgress(
        `Event ${eventConfig.id} round ${roundId}: loading group content ${descriptor.groupName || groupPath}`
      );
      try {
        let groupResult = await fetchHtml(
          fullGroupUrl,
          config.scrape.userAgent,
          jar,
          config.baseUrl,
          notes,
          `${eventConfig.slug} round ${roundId} group content`,
          {
            method: "GET",
            headers: {
              accept: "text/html, */*; q=0.01",
              "x-requested-with": "XMLHttpRequest",
              referer: url
            }
          }
        );

        if (groupResult.ok && isNotFoundPage(groupResult.html)) {
          logWarning(
            `Event ${eventConfig.id} round ${roundId}: GET group content returned not-found page, retrying with POST (${descriptor.groupName || fullGroupUrl}).`
          );
          groupResult = await fetchHtml(
            fullGroupUrl,
            config.scrape.userAgent,
            jar,
            config.baseUrl,
            notes,
            `${eventConfig.slug} round ${roundId} group content`,
            {
              method: "POST",
              headers: {
                accept: "text/html, */*; q=0.01",
                "x-requested-with": "XMLHttpRequest",
                referer: url,
                "content-type": "application/x-www-form-urlencoded"
              },
              body: ""
            }
          );
        }

        if (groupResult.ok && !isNotFoundPage(groupResult.html)) {
          combinedHtml += `\n<!-- group-content ${fullGroupUrl} -->\n${groupResult.html}\n`;
          if (config.scrape.saveRawHtml) {
            const groupSuffix = descriptor.groupNumber ?? "x";
            const rawGroupPath = path.join(
              rawDir,
              `event-${eventConfig.id}-round-${roundId}-group-${groupSuffix}.html`
            );
            await fs.writeFile(rawGroupPath, groupResult.html, "utf8");
          }
          const groupPlayers = parsePlayersFromHtml(groupResult.html, {
            groupNumber: descriptor.groupNumber,
            groupName: descriptor.groupName
          });
          logProgress(
            `Event ${eventConfig.id} round ${roundId}: parsed ${groupPlayers.length} player row(s) from ${descriptor.groupName || "group endpoint"}.`
          );
          for (const player of groupPlayers) {
            const key = getPlayerRoundKey(player);
            const existing = playersByKey.get(key);
            playersByKey.set(key, existing ? mergePlayerRows(existing, player) : player);
          }
        } else {
          const status = groupResult.status;
          const reason = isNotFoundPage(groupResult.html) ? "not-found page" : `HTTP ${status}`;
          notes.push(`${eventConfig.slug}: group content failed (${reason}) ${fullGroupUrl}`);
          logWarning(
            `Event ${eventConfig.id} round ${roundId}: group content failed (${reason}) (${descriptor.groupName || fullGroupUrl}).`
          );
        }
      } catch (error) {
        notes.push(`${eventConfig.slug}: group content request failed (${error.message}) ${fullGroupUrl}`);
        logWarning(
          `Event ${eventConfig.id} round ${roundId}: group content request failed (${error.message}) (${descriptor.groupName || fullGroupUrl}).`
        );
      }
      await sleep(config.scan.requestDelayMs);
    }

    const fallbackPlayers = parsePlayersFromHtml(combinedHtml);
    for (const player of fallbackPlayers) {
      const key = getPlayerRoundKey(player);
      const existing = playersByKey.get(key);
      playersByKey.set(key, existing ? mergePlayerRows(existing, player) : player);
    }
    const players = [...playersByKey.values()];

    rounds.push({
      eventId: eventConfig.id,
      eventName: eventConfig.name,
      roundId,
      roundLabel,
      roundStart: meta.roundStart,
      roundEnd: meta.roundEnd,
      url,
      groupContentUrls: groupUrls,
      players,
      playerCount: players.length,
      fetchedAt: new Date().toISOString()
    });
    logProgress(`Event ${eventConfig.id} round ${roundId}: collected ${players.length} unique player row(s).`);

    await sleep(config.scan.requestDelayMs);
  }

  logProgress(`Event ${eventConfig.id} (${eventConfig.slug}): completed with ${rounds.length} round(s).`);
  return rounds;
}

async function main() {
  logProgress("Starting update-data run.");
  const config = await loadConfig();
  const notes = [];
  const enabledEvents = config.events.filter((event) => event.enabled);
  const rounds = [];
  logProgress(`Enabled events: ${enabledEvents.map((e) => `${e.id}:${e.slug}`).join(", ") || "none"}`);

  for (const eventConfig of enabledEvents) {
    notes.push(`Scraping event ${eventConfig.id} (${eventConfig.slug})`);
    const scraped = await scrapeEvent(config, eventConfig, notes);
    rounds.push(...scraped);
    logProgress(`Event ${eventConfig.id} (${eventConfig.slug}) contributed ${scraped.length} round(s).`);
  }

  rounds.sort((a, b) => {
    if (a.eventId !== b.eventId) return a.eventId - b.eventId;
    return a.roundId - b.roundId;
  });

  const stats = buildPlayerStats(rounds, {
    roundFilters: config.roundFilters || {}
  });
  if (stats.excludedRoundCount > 0) {
    const excludedSummary = stats.excludedRounds
      .map((x) => `${x.roundId} (${x.reason})`)
      .join(", ");
    notes.push(`Excluded rounds from stats: ${excludedSummary}`);
    logProgress(
      `Excluded ${stats.excludedRoundCount} round(s) from stats based on filters: ${excludedSummary}`
    );
  }

  if (rounds.length === 0) {
    await writeJson(updateMetaPath, {
      generatedAt: new Date().toISOString(),
      rounds: 0,
      players: 0,
      events: enabledEvents.map((event) => ({
        id: event.id,
        slug: event.slug,
        name: event.name
      })),
      notes
    });
    console.error(
      "No rounds were scraped. Existing normalized/player data was left unchanged. See data/last-update.json notes."
    );
    logWarning("No rounds scraped. Existing data preserved.");
    process.exitCode = 1;
    return;
  }

  if (stats.playerCount === 0) {
    await writeJson(updateMetaPath, {
      generatedAt: new Date().toISOString(),
      rounds: rounds.length,
      players: 0,
      events: enabledEvents.map((event) => ({
        id: event.id,
        slug: event.slug,
        name: event.name
      })),
      notes
    });
    console.error(
      "Update completed but produced 0 players. Existing normalized/player data was left unchanged. Check data/raw/*.html and notes in data/last-update.json."
    );
    logWarning("Zero players produced. Existing data preserved.");
    process.exitCode = 1;
    return;
  }

  await writeJson(normalizedPath, rounds);
  await writeJson(statsPath, stats);
  await writeJson(updateMetaPath, {
    generatedAt: new Date().toISOString(),
    rounds: rounds.length,
    players: stats.playerCount,
    events: enabledEvents.map((event) => ({
      id: event.id,
      slug: event.slug,
      name: event.name
    })),
    notes
  });

  console.log(`Scraped ${rounds.length} rounds and generated ${stats.playerCount} player profiles.`);
  logProgress(`Completed in ${elapsedSeconds()}s.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
