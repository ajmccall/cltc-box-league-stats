import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const roundsPath = path.join(repoRoot, "data/normalized/rounds.json");
const statsPath = path.join(repoRoot, "data/player-stats.json");
const configPath = path.join(repoRoot, "config/league-config.json");

function canonicalName(name) {
  return name.trim().replace(/\s+/g, " ");
}

function playerKey(name) {
  return canonicalName(name).toLowerCase();
}

function safeNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundKey(eventId, roundId) {
  return `${eventId}:${roundId}`;
}

function cleanRoundLabel(label, roundId) {
  const fallback = `Round ${roundId}`;
  if (!label) return fallback;
  const trimmed = String(label).trim();
  const cleaned = trimmed.replace(/\s*\|\s*LTA - Tennis for Britain\s*$/i, "").trim();
  return cleaned || trimmed || fallback;
}

function sortTimeline(a, b) {
  if (a.eventId !== b.eventId) return a.eventId - b.eventId;
  return a.roundId - b.roundId;
}

function computeGroupSizes(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const groupNumber = safeNumber(row.groupNumber);
    if (!Number.isFinite(groupNumber)) continue;
    counts.set(groupNumber, (counts.get(groupNumber) || 0) + 1);
  }
  return counts;
}

function timelineQualityScore(entry) {
  let score = 0;
  if (entry.groupNumber != null) score += 100;
  if (entry.position != null) score += 10;
  if (entry.groupSize != null) score += 10;
  if (entry.wins != null) score += 10;
  if (entry.losses != null) score += 10;
  return score;
}

function mergeTimelineEntries(existing, incoming) {
  const existingScore = timelineQualityScore(existing);
  const incomingScore = timelineQualityScore(incoming);
  const primary = incomingScore > existingScore ? incoming : existing;
  const secondary = primary === incoming ? existing : incoming;

  return {
    ...secondary,
    ...primary,
    groupName: primary.groupName ?? secondary.groupName ?? null,
    groupNumber: primary.groupNumber ?? secondary.groupNumber ?? null,
    groupSize: primary.groupSize ?? secondary.groupSize ?? null,
    withdrawn: Boolean(primary.withdrawn || secondary.withdrawn),
    position: primary.position ?? secondary.position ?? null,
    wins: primary.wins ?? secondary.wins ?? 0,
    losses: primary.losses ?? secondary.losses ?? 0
  };
}

function roundActivityTotals(round) {
  let played = 0;
  let wins = 0;
  let losses = 0;
  for (const row of round.players || []) {
    if (Number.isFinite(row.played)) played += row.played;
    if (Number.isFinite(row.wins)) wins += row.wins;
    if (Number.isFinite(row.losses)) losses += row.losses;
  }
  return { played, wins, losses };
}

function normalizeRoundFilters(input = {}) {
  return {
    dropZeroActivityRounds: input.dropZeroActivityRounds ?? false,
    excludeRoundIds: new Set(input.excludeRoundIds || []),
    includeRoundIds: new Set(input.includeRoundIds || [])
  };
}

export function filterRoundsForStats(rounds, roundFilters = {}) {
  const normalized = normalizeRoundFilters(roundFilters);
  const keptRounds = [];
  const excludedRounds = [];

  for (const round of rounds) {
    const roundId = Number.parseInt(String(round.roundId), 10);
    const label = cleanRoundLabel(round.roundLabel, round.roundId);
    const { played, wins, losses } = roundActivityTotals(round);
    const hasAnyActivity = played > 0 || wins > 0 || losses > 0;

    if (normalized.includeRoundIds.has(roundId)) {
      keptRounds.push(round);
      continue;
    }

    if (normalized.excludeRoundIds.has(roundId)) {
      excludedRounds.push({
        eventId: round.eventId,
        roundId,
        roundLabel: label,
        reason: "manual-exclude"
      });
      continue;
    }

    if (normalized.dropZeroActivityRounds && !hasAnyActivity) {
      excludedRounds.push({
        eventId: round.eventId,
        roundId,
        roundLabel: label,
        reason: "zero-activity"
      });
      continue;
    }

    keptRounds.push(round);
  }

  return { keptRounds, excludedRounds };
}

function buildRoundTopGroupMap(rounds) {
  const topGroupByRound = new Map();
  for (const round of rounds) {
    let topGroup = null;
    for (const row of round.players || []) {
      const groupNumber = safeNumber(row.groupNumber);
      if (!Number.isFinite(groupNumber)) continue;
      if (!Number.isFinite(topGroup) || groupNumber < topGroup) {
        topGroup = groupNumber;
      }
    }
    topGroupByRound.set(roundKey(round.eventId, round.roundId), topGroup);
  }
  return topGroupByRound;
}

function getSeasonResult(entry, topGroupNumber) {
  if (entry.withdrawn) {
    return {
      code: "withdrawn",
      label: "🚫 Withdrawn",
      className: "result-withdrawn"
    };
  }

  if (entry.position === 1 && Number.isFinite(entry.groupNumber)) {
    if (Number.isFinite(topGroupNumber) && entry.groupNumber === topGroupNumber) {
      return {
        code: "league-champion",
        label: "🏆 League Champion",
        className: "result-overall-champion"
      };
    }
    return {
      code: "box-champ",
      label: "🥇 Box Champ",
      className: "result-box-champ"
    };
  }

  switch (entry.transition) {
    case "promotion":
      return { code: "promotion", label: "⬆️ Promoted", className: "result-promotion" };
    case "relegation":
      return { code: "relegation", label: "⬇️ Relegated", className: "result-relegation" };
    case "stayed":
      return { code: "stayed", label: "➡️ Stayed", className: "result-stayed" };
    default:
      return { code: "none", label: "-", className: "result-none" };
  }
}

export function buildPlayerStats(rounds, options = {}) {
  const { roundFilters = {} } = options;
  const { keptRounds, excludedRounds } = filterRoundsForStats(rounds, roundFilters);
  const topGroupByRound = buildRoundTopGroupMap(keptRounds);
  const players = new Map();

  for (const round of keptRounds) {
    const eventName = round.eventName || `Event ${round.eventId}`;
    const roundLabel = cleanRoundLabel(round.roundLabel, round.roundId);
    const groupSizes = computeGroupSizes(round.players || []);

    for (const row of round.players || []) {
      if (!row.name) continue;
      const name = canonicalName(row.name);
      const key = playerKey(name);

      if (!players.has(key)) {
        players.set(key, {
          id: key.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
          name,
          timelineMap: new Map()
        });
      }

      const markerWins = (row.markers || []).filter((m) => m === "win").length;
      const markerLosses = (row.markers || []).filter((m) => m === "loss").length;
      const outcomeWins = Number.isFinite(row.wins) ? row.wins : markerWins;
      const outcomeLosses = Number.isFinite(row.losses) ? row.losses : markerLosses;

      const player = players.get(key);
      const timelineEntry = {
        eventId: round.eventId,
        eventName,
        roundId: round.roundId,
        roundLabel,
        roundStart: round.roundStart || null,
        roundEnd: round.roundEnd || null,
        groupName: row.groupName || null,
        groupNumber: safeNumber(row.groupNumber),
        groupSize: groupSizes.get(safeNumber(row.groupNumber)) ?? null,
        withdrawn: Boolean(row.withdrawn),
        position: safeNumber(row.position),
        wins: outcomeWins,
        losses: outcomeLosses,
        sourceUrl: round.url
      };
      const timelineKey = roundKey(round.eventId, round.roundId);
      const existingEntry = player.timelineMap.get(timelineKey);
      player.timelineMap.set(
        timelineKey,
        existingEntry ? mergeTimelineEntries(existingEntry, timelineEntry) : timelineEntry
      );
    }
  }

  const outputPlayers = [];

  for (const player of players.values()) {
    player.timeline = [...player.timelineMap.values()];
    player.totalWins = player.timeline.reduce((sum, entry) => sum + (entry.wins || 0), 0);
    player.totalLosses = player.timeline.reduce((sum, entry) => sum + (entry.losses || 0), 0);
    player.timeline.sort(sortTimeline);

    let promotions = 0;
    let relegations = 0;
    let stayed = 0;

    for (let i = 0; i < player.timeline.length; i += 1) {
      const current = player.timeline[i];
      const next = player.timeline[i + 1];
      current.transition = null;

      if (!next || next.eventId !== current.eventId) {
        continue;
      }

      if (current.withdrawn) {
        continue;
      }

      if (next.groupNumber == null || current.groupNumber == null) {
        continue;
      }

      if (next.groupNumber < current.groupNumber) {
        current.transition = "promotion";
        promotions += 1;
      } else if (next.groupNumber > current.groupNumber) {
        current.transition = "relegation";
        relegations += 1;
      } else {
        current.transition = "stayed";
        stayed += 1;
      }
    }

    for (const current of player.timeline) {
      const topGroupNumber = topGroupByRound.get(roundKey(current.eventId, current.roundId));
      const result = getSeasonResult(current, topGroupNumber);
      current.resultCode = result.code;
      current.resultLabel = result.label;
      current.resultClass = result.className;
    }

    const totalGames = player.totalWins + player.totalLosses;
    outputPlayers.push({
      id: player.id,
      name: player.name,
      totalRounds: player.timeline.length,
      totalWins: player.totalWins,
      totalLosses: player.totalLosses,
      winRate: totalGames > 0 ? Number((player.totalWins / totalGames).toFixed(3)) : null,
      promotions,
      relegations,
      stayed,
      timeline: player.timeline
    });
  }

  outputPlayers.sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    includedRoundCount: keptRounds.length,
    excludedRoundCount: excludedRounds.length,
    excludedRounds,
    playerCount: outputPlayers.length,
    players: outputPlayers
  };
}

async function main() {
  const roundsRaw = await fs.readFile(roundsPath, "utf8");
  const rounds = JSON.parse(roundsRaw);
  let config = {};
  try {
    const configRaw = await fs.readFile(configPath, "utf8");
    config = JSON.parse(configRaw);
  } catch {
    config = {};
  }
  const stats = buildPlayerStats(rounds, {
    roundFilters: config.roundFilters || {}
  });

  await fs.mkdir(path.dirname(statsPath), { recursive: true });
  await fs.writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");

  console.log(
    `Built ${stats.playerCount} player summaries at ${statsPath} (${stats.includedRoundCount} rounds included, ${stats.excludedRoundCount} excluded).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
