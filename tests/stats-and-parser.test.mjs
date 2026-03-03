import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlayerStats } from "../scripts/build-stats.mjs";
import { extractMatchupsFromPlayerPage, parsePlayersFromHtml } from "../scripts/update-data.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

async function readFixture(name) {
  return fs.readFile(path.join(fixturesDir, name), "utf8");
}

test("extractMatchupsFromPlayerPage parses per-match points and outcomes", async () => {
  const html = await readFixture("player-page-sample.html");
  const matchups = extractMatchupsFromPlayerPage(html, "Stefano Capece", 136);

  assert.equal(matchups.length, 2);

  assert.deepEqual(matchups[0], {
    opponentId: 135,
    opponentName: "peter orourke",
    outcome: "win",
    pointsFor: 9,
    pointsAgainst: 6,
    scoreText: "9-6"
  });

  assert.deepEqual(matchups[1], {
    opponentId: 200,
    opponentName: "Clarice Williamson",
    outcome: "win",
    pointsFor: 11,
    pointsAgainst: 4,
    scoreText: "11-4"
  });
});

test("parsePlayersFromHtml parses table rows with match opponent scores", async () => {
  const html = await readFixture("round-table-sample.html");
  const players = parsePlayersFromHtml(html, { groupNumber: 5, groupName: "Group 5" });

  assert.equal(players.length, 1);
  const player = players[0];
  assert.equal(player.name, "peter orourke");
  assert.equal(player.playerId, 135);
  assert.equal(player.groupNumber, 5);
  assert.equal(player.position, 1);
  assert.equal(player.points, 24);
  assert.equal(player.wins, 1);
  assert.equal(player.losses, 2);
  assert.equal(player.matchups.length, 1);
  assert.deepEqual(player.matchups[0], {
    opponentId: 136,
    opponentName: "Stefano Capece",
    outcome: "loss",
    pointsFor: 6,
    pointsAgainst: 9,
    scoreText: "6-9"
  });
});

test("buildPlayerStats backfills points-against from reverse match entry", async () => {
  const fixture = await readFixture("rounds-reverse-points.json");
  const rounds = JSON.parse(fixture);
  const stats = buildPlayerStats(rounds, { roundFilters: {} });

  const alice = stats.players.find((p) => p.name === "Alice Example");
  const bob = stats.players.find((p) => p.name === "Bob Example");

  assert.ok(alice);
  assert.ok(bob);

  assert.equal(alice.tennisPointsFor, 9);
  assert.equal(alice.tennisPointsAgainst, 6);
  assert.equal(alice.topOpponents.length, 1);
  assert.equal(alice.topOpponents[0].pointsFor, 9);
  assert.equal(alice.topOpponents[0].pointsAgainst, 6);

  assert.equal(bob.tennisPointsFor, 6);
  assert.equal(bob.tennisPointsAgainst, 9);
  assert.equal(bob.topOpponents.length, 1);
  assert.equal(bob.topOpponents[0].pointsFor, 6);
  assert.equal(bob.topOpponents[0].pointsAgainst, 9);
});
