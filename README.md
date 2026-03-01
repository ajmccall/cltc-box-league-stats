# Tennis Tracker (Static)

Static player stats site for your CLTC box leagues. No database or backend.

## What this includes

- `index.html` static UI (search player, view W/L and movement over rounds)
- `scripts/update-data.mjs` crawler + normalizer
- `scripts/build-stats.mjs` player summary generator
- Local JSON data files under `data/`

## Data model (files)

- `data/normalized/rounds.json`: normalized round snapshots
- `data/player-stats.json`: precomputed per-player stats consumed by the UI
- `data/raw/`: optional raw HTML snapshots for debugging parser changes
- `data/last-update.json`: scrape metadata and notes (created by `update-data`)

## Configure leagues

Edit `config/league-config.json`:

- `events[].enabled`: choose Open only (`event 1`) or include Women (`event 4`)
- `events[].seedRoundIds`: known round ids to bootstrap discovery
- `scan.*`: fallback behavior when rounds are missing/cancelled
- `roundFilters.dropZeroActivityRounds`: automatically exclude rounds where no matches were played
- `roundFilters.excludeRoundIds`: manual round ids to always remove from player stats
- `roundFilters.includeRoundIds`: manual round ids to force-include even if they match other filters

Notes based on your setup:

- Round ids are global and not aligned across event types.
- Cancelled/admin rounds can exist and have no usable results.

## Commands

```bash
npm run build-stats
npm run update-data
npm run serve
```

Open: `http://localhost:8000`

## GitHub Pages deploy

1. Push this repo to GitHub.
2. In repo settings, enable Pages from your default branch root (or `/docs` if you later move files).
3. Run `npm run update-data` locally whenever you want fresh data, then commit updated `data/*` files.

## Practical caveat

The parser is heuristic because the source HTML structure can change. If LTA changes markup, use saved `data/raw/*.html` to tune parsing rules inside `scripts/update-data.mjs`.
