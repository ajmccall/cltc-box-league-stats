export function safeNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function canonicalName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export function identityKey(playerId, name) {
  const id = safeNumber(playerId);
  if (Number.isFinite(id)) return `id:${id}`;
  const normalized = canonicalName(name).toLowerCase();
  return normalized ? `name:${normalized}` : null;
}

export function isLikelyOpponentName(name) {
  const normalized = String(name || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\d/.test(normalized)) return false;
  if (!/\s/.test(normalized)) return false;
  if (/^([WLT]\s+)+[WLT]$/i.test(normalized)) return false;
  if (/player\s+pl\s+w\s+l\s+pts\s+history/i.test(normalized)) return false;

  const letters = normalized.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4;
}

export function cleanRoundLabel(label, roundId = null) {
  if (!label && roundId == null) return "-";
  const fallback = roundId == null ? "-" : `Round ${roundId}`;
  const trimmed = String(label || "").trim();
  if (!trimmed) return fallback;
  const cleaned = trimmed
    .replace(/\s*\|\s*LTA - Tennis for Britain\s*$/i, "")
    .replace(/\s*\|\s*CLTC - Singles League\s*$/i, "")
    .trim();
  return cleaned || trimmed || fallback;
}

export function computeBestPositionFromTimeline(timeline) {
  let best = null;

  for (const entry of timeline || []) {
    if (!Number.isFinite(entry.groupNumber) || !Number.isFinite(entry.position)) continue;

    if (!best) {
      best = entry;
      continue;
    }

    if (entry.groupNumber < best.groupNumber) {
      best = entry;
      continue;
    }

    if (entry.groupNumber === best.groupNumber && entry.position < best.position) {
      best = entry;
    }
  }

  if (!best) return null;
  return {
    groupNumber: best.groupNumber,
    position: best.position,
    roundId: best.roundId,
    roundLabel: best.roundLabel,
    roundStart: best.roundStart || null,
    roundEnd: best.roundEnd || null,
    eventId: best.eventId ?? null,
    eventName: best.eventName ?? null
  };
}

export function aggregateHeadToHeadAndPoints(timeline, selfIdentityKey, matchScoreLookup) {
  const opponents = new Map();
  let tennisPointsFor = 0;
  let tennisPointsAgainst = 0;
  let hasAnyTennisPoints = false;

  for (const entry of timeline || []) {
    let entryMatchPointsFor = 0;
    let entryMatchPointsAgainst = 0;
    let entryHasMatchPoints = false;

    for (const matchup of entry.matchups || []) {
      const pointsFor = safeNumber(matchup.pointsFor);
      const opponentName = String(matchup.opponentName || "").trim();
      const opponentId = safeNumber(matchup.opponentId);
      if (!Number.isFinite(opponentId) && !isLikelyOpponentName(opponentName)) {
        continue;
      }

      const opponentKey = identityKey(opponentId, opponentName);
      let pointsAgainst = safeNumber(matchup.pointsAgainst);
      if (
        !Number.isFinite(pointsAgainst) &&
        Number.isFinite(pointsFor) &&
        selfIdentityKey &&
        opponentKey &&
        matchScoreLookup
      ) {
        const reverse = safeNumber(
          matchScoreLookup.get(`${entry.eventId}:${entry.roundId}:${opponentKey}:${selfIdentityKey}`)
        );
        if (Number.isFinite(reverse)) pointsAgainst = reverse;
      }

      if (Number.isFinite(pointsFor) && Number.isFinite(pointsAgainst)) {
        entryMatchPointsFor += pointsFor;
        entryMatchPointsAgainst += pointsAgainst;
        entryHasMatchPoints = true;
      }

      const key = identityKey(opponentId, opponentName);
      if (!key) continue;

      if (!opponents.has(key)) {
        opponents.set(key, {
          opponentId: Number.isFinite(opponentId) ? opponentId : null,
          opponentName: opponentName || `Player ${opponentId}`,
          played: 0,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0
        });
      }

      const aggregate = opponents.get(key);
      aggregate.played += 1;
      if (matchup.outcome === "win") aggregate.wins += 1;
      if (matchup.outcome === "loss") aggregate.losses += 1;
      if (Number.isFinite(pointsFor) && Number.isFinite(pointsAgainst)) {
        aggregate.pointsFor += pointsFor;
        aggregate.pointsAgainst += pointsAgainst;
      }
    }

    const roundPointsFor = safeNumber(entry.leaguePoints);
    if (Number.isFinite(roundPointsFor)) {
      tennisPointsFor += roundPointsFor;
      hasAnyTennisPoints = true;
    } else if (entryHasMatchPoints) {
      tennisPointsFor += entryMatchPointsFor;
      hasAnyTennisPoints = true;
    }

    const roundPointsAgainst = safeNumber(entry.leaguePointsAgainst);
    if (Number.isFinite(roundPointsAgainst)) {
      tennisPointsAgainst += roundPointsAgainst;
      hasAnyTennisPoints = true;
    } else if (entryHasMatchPoints) {
      tennisPointsAgainst += entryMatchPointsAgainst;
      hasAnyTennisPoints = true;
    }
  }

  const topOpponents = [...opponents.values()]
    .sort((a, b) => {
      if (b.played !== a.played) return b.played - a.played;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.opponentName.localeCompare(b.opponentName);
    })
    .slice(0, 3);

  return {
    topOpponents,
    tennisPointsFor: hasAnyTennisPoints ? tennisPointsFor : null,
    tennisPointsAgainst: hasAnyTennisPoints ? tennisPointsAgainst : null
  };
}
