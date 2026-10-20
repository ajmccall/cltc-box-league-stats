import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const rounds = JSON.parse(await readFile(path.join(dataDir, "normalized", "rounds.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(dataDir, "last-update.json"), "utf8"));
const generatedAt = new Date(metadata.generatedAt);
if (Number.isNaN(generatedAt.getTime())) throw new Error("last-update.json has no valid generatedAt timestamp");

const currentByEvent = new Map();
for (const round of rounds) {
  const previous = currentByEvent.get(round.eventId);
  if (!previous || round.roundId > previous.roundId) currentByEvent.set(round.eventId, round);
}

const snapshot = {
  generatedAt: metadata.generatedAt,
  capturedAt: new Date().toISOString(),
  events: [...currentByEvent.values()].map((round) => ({
    eventId: round.eventId,
    eventName: round.eventName,
    roundId: round.roundId,
    roundLabel: round.roundLabel,
    roundStart: round.roundStart,
    roundEnd: round.roundEnd,
    players: round.players.map(({ name, playerId, groupNumber, groupName, position, played, wins, losses, points, withdrawn, matchups }) => ({
      name, playerId, groupNumber, groupName, position, played, wins, losses, points, withdrawn,
      matchups: (matchups || []).map(({ opponentId, opponentName, outcome, pointsFor, pointsAgainst, scoreText }) =>
        ({ opponentId, opponentName, outcome, pointsFor, pointsAgainst, scoreText }))
    }))
  }))
};

const date = metadata.generatedAt.slice(0, 10);
const snapshotDir = path.join(dataDir, "snapshots");
await mkdir(snapshotDir, { recursive: true });
await writeFile(path.join(snapshotDir, `${date}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Archived current box state to data/snapshots/${date}.json`);
