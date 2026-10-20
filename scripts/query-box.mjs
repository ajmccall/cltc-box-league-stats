import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const eventArg = valueFor("--event", "open").toLowerCase();
const eventId = eventArg === "open" ? 1 : eventArg === "women" || eventArg === "women's" ? 4 : Number(eventArg);
const groupNumber = Number(valueFor("--box", "1"));
if (!Number.isInteger(eventId) || !Number.isInteger(groupNumber) || groupNumber < 1) {
  throw new Error("Usage: npm run query-box -- --event open|women --box NUMBER");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [rounds, metadata] = await Promise.all([
  readFile(path.join(root, "data", "normalized", "rounds.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "data", "last-update.json"), "utf8").then(JSON.parse)
]);
const round = rounds.filter((item) => item.eventId === eventId).sort((a, b) => b.roundId - a.roundId)[0];
if (!round) throw new Error(`No stored rounds for event ${eventId}`);
const players = round.players.filter((player) => player.groupNumber === groupNumber)
  .sort((a, b) => a.position - b.position || b.points - a.points || a.name.localeCompare(b.name));
if (players.length === 0) throw new Error(`No Box League ${groupNumber} in ${round.eventName}`);

const uniqueMatches = new Map();
for (const player of players) {
  for (const match of player.matchups || []) {
    const ids = [String(player.playerId), String(match.opponentId)].sort();
    const key = ids.join(":");
    if (!uniqueMatches.has(key)) uniqueMatches.set(key, {
      player: player.name, opponent: match.opponentName, score: match.scoreText, winner: match.outcome === "win" ? player.name : match.opponentName
    });
  }
}

console.log(JSON.stringify({
  sourceGeneratedAt: metadata.generatedAt,
  event: round.eventName,
  round: { id: round.roundId, label: round.roundLabel, start: round.roundStart, end: round.roundEnd },
  box: groupNumber,
  playerCount: players.length,
  gamesPlayed: uniqueMatches.size,
  gamesPossible: (players.length * (players.length - 1)) / 2,
  standings: players.map(({ position, name, played, wins, losses, points, withdrawn }) => ({ position, name, played, wins, losses, points, withdrawn })),
  results: [...uniqueMatches.values()].sort((a, b) => a.player.localeCompare(b.player))
}, null, 2));
