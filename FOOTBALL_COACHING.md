# Native Football GM play calling

Implemented on `feat/football-interactive-sim`, based on the official
`zengm-games/zengm` GitHub source at `83061b3ac545fa1e2fe324587a1330334e5bfabb`.

## Expansion checklist

- [x] Inspect the reference's documented controls and public data provenance.
- [x] Add 27 tactical calls, route/target choices, defensive packages, and spikes.
- [x] Replace the simple in-game panel with a field, playbook, personnel, and data workspace.
- [x] Connect verified nflverse identities and empirical play profiles to league data.
- [x] Validate spreadsheet-to-roster matching without guessing ambiguous identities.
- [x] Test native simulation/save compatibility and build the expanded source.

## Live box score follow-up

- [x] Include detached cumulative player statistics in live coaching snapshots.
- [x] Show the usual Football GM stat tables below coaching controls during and after games.
- [x] Verify stat updates and native saving, rebuild locally, and publish source changes.

The exact spreadsheet is awaiting identification. The reference site's live
assets are blocked by the network security filter, so visual work uses its
documented interaction model rather than claiming verified pixel parity.

## Run privately

Use the Node and pnpm versions specified in `package.json` (Node 24 and pnpm 11).

```sh
pnpm install
SPORT=football node --run build
node --run preview
```

Open the localhost address printed by the server. Create a league and choose
**Custom (from league file)** to import an existing Football GM `.json` or
`.json.gz` export using the original importer. The local origin has its own
database; it cannot access a league stored at `play.football-gm.com` automatically.

In **Weekly Schedule**, **Sim game** opens play calling for your selected team.
Other matchups and all-star games simulate automatically. **Quick sim** retains
automatic simulation; **Watch game** retains the original replay.

## Controls and saving

Coaching belongs only to the league's selected club, captured when the game
starts. On your possessions, choose an offensive play and its eligible target,
route, or carrier. On the opponent's possessions, choose your defensive package;
the computer chooses the opponent's play. Only your team's timeouts are available.
The worker and native simulator enforce ownership independently of the UI.
Spectator leagues and unrelated matchups cannot start a coached game.

The playbook has eight running calls, thirteen passing calls, three RPOs, and
three trick plays. Four personnel groups (11, 12, 21, 13) change the actual native
lineup. Six defensive packages change personnel, rushers, and coverage. RPOs
read the front and ratings; halfback passes use the back's passing ratings and
credit his native passing statistics. Selected healthy reserves enter the lineup.
Routes affect target depth and time in the pocket. These are explicit game-design
rules for this fork, not recovered proprietary coefficients.

Kneel, spike, punt, field goal, kickoff, onside kick, extra point, and two-point
conversion follow native game situations. Manage offensive tempo and your timeout
after a running-clock play, before runoff. The opponent retains automatic timeouts;
defending a late AI kneel still gives you a timeout window.

The screen displays native scores, field position, recent play-by-play, and
roster-backed formation previews. The field is schematic, not tracking footage.
Jump to the final two minutes or finish
automatically at any time a decision is pending. The weekly schedule provides a
resume link if you navigate away. The top Play menu's **Finish coached game**
also finishes and saves the game.

Scroll below the coaching workspace for the ordinary Football GM scoring summary
and passing, rushing, receiving, blocking, kicking, punting, returns, and defense
tables for both teams. They use the native table renderer and cumulative game
statistics, updating after every play and remaining visible after the final.
Player links, injuries, jersey numbers, derived averages, and column sorting
retain their usual behavior. The capped recent-play log is not used for totals.

The worker owns one native simulator and accepts only validated decisions with
session/revision tokens. The normal Football GM pipeline saves player and team
statistics, injuries, the box score, standings, and the schedule. League switching
waits for that pipeline to finish. A failed save is reported and blocks further
simulation in that worker, because some native writes may already have occurred.
After such an error, reload and restore a known-good league export before playing
again. Errors before saving starts can be retried normally.

An unfinished game is held in worker memory. Closing all app tabs or terminating
the browser can lose the in-progress simulation. Finish the game before doing so.
Results are final only when the screen says they are saved.

## NFL reference and spreadsheet bridge

The bundled public reference covers 103,312 eligible NFL plays from 2023–2025
and 4,377 recent player identities. Tactical throws and runs can sample observed
air-yard and rushing-yard distributions while retaining native player ratings,
coverage, blocking, penalties, injuries, and statistics. Missing profiles fall
back to native distributions. Automatic simulation retains its original seeded
behavior. There is no live 2026 feed or claimed recreation of the other site's
hidden prediction model.

The **Data** tab shows provenance, sample denominators, and unique roster matches.
Export a player-link CSV template or import a CSV/TSV with Football GM `pid`,
player name, and NFL `gsis_id` or `pfr_id`. Preview identifies conflicts,
duplicates, ambiguity, and missing players. Only verified rows can be saved;
the worker revalidates them. Links are stored locally per league and imports
are serialized in an IndexedDB transaction. Player names and league files are
not uploaded to the reference site or a matching service.

This bridge joins player identities; it does not overwrite league ratings or
synchronize workbook formulas. The particular spreadsheet still needs its name
or link before a direct connection can be configured. See
[public data provenance and licenses](data/football-coach-reference.README.md).

## Verification

```sh
node --run lint
node --run pre-test
pnpm exec vitest run --project football --project basketball --project baseball
SPORT=football node --run build
```

On the development machine's Node 25 runtime, tests were run with
`NODE_OPTIONS=--no-experimental-webstorage` to disable its incompatible native
localStorage implementation. All 763 runnable Node tests passed; 12 upstream
tests were skipped. Full lint, TypeScript, and the production build passed.
The local server was checked against the built page, assets, and reference JSON.
Browser tests were not run: browser automation was blocked
by approval verification. The interface still needs a manual browser acceptance
pass; this is not a claim of perfect compatibility with every league export.

Coverage checks exact seeded automatic/native result parity, every tactical call,
formations, target/carrier selection, halfback passing stats, routes, defensive
assignments, spikes, ownership for home and away teams, opponent AI timeouts,
overtime, zero-second conversions, detached snapshots, stale/double submissions,
and two-minute jumping. Data tests cover source joins, empirical denominators,
CSV identities, malformed input, and duplicate/conflicting identifiers. Field
render tests check real roster markers and hidden ratings. A real native pipeline
test checks one box score, player/team statistics, the correct schedule removal,
and a league close that waits for the persistence boundary. The supplied league
export was also validated read-only against the current native football schema.
Live box-score tests render the native categories and calculated columns, check
updates without recent play events, preserve the final tables, and compare every
saved raw player statistic and team total with the final live snapshot.

## Scope and license

This is a source-level Football GM integration inspired by play-calling games.
It does not contain the proprietary Two-Minute Drill engine, its assets, or an
exact reconstruction of its probabilities. Tactical route/personnel/defense
controls extend the native simulation; direct player movement is not implemented.
The reference site's live assets were blocked by the network security filter,
so exact visual parity could not be verified. Custom league shootouts remain
automatic and their scores are displayed.

The existing [license](LICENSE.md) permits private local play and source sharing.
It prohibits publishing a playable fork for other users. Keep this application
bound to localhost and preserve the license when sharing source.
