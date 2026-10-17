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

## Acceptance and compatibility follow-up

- [x] Verify a complete coached game in Chrome: club ownership, possession changes, timeouts, live tables, and saved results after reopening.
- [x] Verify overtime in Chrome and durable database reopening through native integration tests.
- [x] Run four representative local league exports through native import components, team loading, and complete game simulation.
- [x] Identify the requested data source: the Week 5 v25 native league export.
- [ ] Finish the Week 5 export's browser import and full-game acceptance test.
- [x] Compare observable reference behavior and empirical rushing distributions; document remaining fidelity gaps.

### Remaining verification work

- [x] Exercise the Week 5 export through the complete native league-creation,
      coached-game, save, and database-reopen path in an isolated test database.
- [x] Measure complete-game output against observed NFL aggregates, separating
      real observations from simulation results and checking clock policy.
- [ ] Finish the separate browser-file acceptance check once Chrome file access
      is enabled; the extension still rejected file selection on recheck.

The Week 5 file is identified below. Chrome's extension currently requires
"Allow access to file URLs" before its file chooser can select the local export.
The completed Chrome games use a separate generated test league; they do not
establish that the Week 5 browser import has passed.

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
Injuries sustained during play remain undiagnosed until native saving completes;
the final live tables then show the same diagnosis as the saved box score.

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
synchronize workbook formulas. Historical samples apply by play type to matched
and unmatched players alike. Identity links do not select player-specific
probabilities. The Data panel now states this explicitly.
Justin identified the requested data source as
`2026 Week 5 NFL Real Players - Postgame v25.0.json.gz`, rather than a spreadsheet.
Use the native custom-league importer for its rosters, ratings, depth charts,
injuries, and league configuration. The inspected file contains 4,128 players,
57 team records (32 active), and 327 injury entries. Its current season is 2026;
the release name does not mean real Week 5 results have been imported.
The read-only source's SHA-256 is
`dc751cbfea499fdade9699168d9f6b6c85b7c120dd7abe13c35ced007703d329`.
See
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
localStorage implementation. The latest three-project Node suite passed 777
tests with 15 skipped (including opt-in local-export and diagnostic tests when
no paths are provided), across 74 passing files and four skipped files.
Full lint, TypeScript, and production build `2026.10.17.0868` passed.
This is not a claim of perfect
compatibility with every league export.

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

Two additional full-game tests coach home and away independently through the
normal game/save pipeline. They flush real native Cache transactions into
isolated fake-indexeddb databases, close the league, clear globals, reconnect,
and reload the native Game Log. They compare the entire saved game, all 200
player records, team stats, standings, and schedule before and after reconnect.
The isolated database implementation is distinct from the Chrome evidence below.

### Chrome acceptance

In the isolated generated league **Coaching verification — generated roster**,
a full four-quarter home game finished ATL 31–SF 21. Only SF offense, defense,
and timeouts were controllable. A timeout reduced SF's count while leaving
Atlanta's unchanged; punts and turnovers switched to SF defensive controls.
All eight native player-stat categories remained available below the field.
After switching leagues, reloading Chrome, and reopening the saved box score,
all displayed cells across 69 player rows and the scoring summary matched the
final live tables. Comparisons use player identity within each category because
rows tied on the sorted statistic can change order after saving.

A second game placed SF away at SEA with one-minute regulation and overtime
periods. It reached OT1, reset each team's timeouts to two, retained SF-only
controls, allowed the opponent's own timeout decisions, and saved a 0–0 final.
The test league's period lengths were restored to 15/10 minutes and checked
after reload. Chrome reported no warning/error console entries. These browser
runs used build `2026.10.16.1358`, before the empirical rushing correction below;
they establish the existing controls and persistence behavior.

On build `2026.10.17.0868`, a third game in that same generated league finished
automatically at SF 17–CHA 20 and reported its statistics saved. Chrome displayed
the corrected Data-tab explanation. A newly injured player's final live receiving
and blocking rows, including the finalized injury duration, matched the saved
Game Log rows exactly. No console warnings or errors were recorded. This smoke
check verifies the new presentation changes; it is separate from the full manual
control and overtime acceptance runs above.

### Local-export compatibility

`footballCoachCompatibility.football.test.ts` accepts a JSON array of absolute
paths in `FOOTBALL_COACH_COMPATIBILITY_FILES`. It reads and hashes each export,
uses the native initial upload/schema inspection, gzip/stream parsing,
game-attribute and player normalization, native depth loading, and complete
automatic and home/away tactical simulations. Tactical games load the bundled
reference and assert that empirical profiles are actually sampled.
It checks exact seeded automatic-versus-interactive-auto parity, ownership,
finite statistics, unavailable injured players, and unchanged source hashes.
No user export data is copied into the repository.

The four inspected files cover the v3 recalibrated roster, v12 historical leader
records, a position-locked roster, and Week 5 v25. Together they normalize 13,548
players and load 128 active teams. All four had zero upload schema errors.
Sixteen full games passed. The Week 5 matchup
included 17 unavailable injured players; none participated. All four exports
are version 72 with current season 2026; historical player records alone do not
establish compatibility with a historical starting season.

Three separate generated fixtures add a real 1965 starting/current season,
fictional custom clubs with only IDs 2 and 5 active among six valid team slots,
and two seven-minute periods with user/AI play-through injury policies. Their
400 fictional players, eight team loads, and twelve complete games also passed,
with zero upload schema errors. These are software fixtures, not real historical
rosters or evidence of era-authentic rules. All seven scenarios preserve exact
automatic-versus-interactive-auto results. The harness tests native import
components, not the complete browser upload/database migration.

### Full Week 5 import and persistence

`footballCoachFullImport.football.test.ts` accepts one absolute export path in
`FOOTBALL_COACH_FULL_IMPORT_FILE`. Unlike the component compatibility harness,
it runs the native upload inspection, `createLeague`/`createStream`, production
coaching APIs, native save pipeline, and a database disconnect/reopen. It uses
a fresh isolated fake-indexeddb factory; it does not access browser databases.

The Week 5 v25 export migrated from file version 72 into database version 74.
It preserved all 4,128 player identities and club assignments, 57 clubs,
327 starting injuries, 273 scheduled games, and the checked league settings.
The selected club (31) coached an away game against club 28. All 16 unavailable
matchup players stayed out, and eight empirical play profiles were exercised.
The test compared 6,156 raw counters across 81 saved participants, verified
25 nonparticipants had zero counters, and matched final live injury metadata to
saved diagnoses. Exactly one game was saved and removed from the schedule.

After closing and reconnecting, the saved game and every player, team, team-stat,
team-season, schedule, and game-attribute record matched their pre-close values.
The native Game Log reopened the result, and repeated completion did not create
a duplicate. Upload inspection found zero schema errors; the source hash was
unchanged. This establishes the native worker/database path, while the separate
Chrome file-chooser and browser-storage acceptance check remains pending.

### Reference comparison and rushing correction

The rendered [reference game](https://nfl2mindrill.com/) was inspected in Chrome,
including its Run/Pass/RPO/Trick categories and passing panel. Both applications
use a vertical field beside a playbook, personnel selection, roster markers,
and play-by-play. The fork retains Football GM's navigation and native stat
tables. The reference additionally exposes receiver-specific route/target
choices with projected catch rates, play-action/rollout toggles, out-of-bounds
intent, field zoom, and animation speed. The fork's selected-target route and
schematic formation do not reproduce that entire interaction or hidden model.
There is no verified pixel or probability parity.

Validation found that the native extra breakaway and negative-yard corrections
were being applied on top of measured rushing outcomes, even though those
observed distributions already contain long gains and tackles for loss. Those
two corrections now apply only to the native fallback. Matchup effects, league
yardage factors, field limits, penalties, and fumbles still apply normally.
Nine regression tests verify every observed yard value at a neutral matchup,
50,000 weighted samples against the source mean/loss/20-yard rates, and unchanged
seeded native fallbacks. This verifies sampling integrity, not held-out
full-game NFL calibration or equivalence to the reference's proprietary engine.

### Whole-game realism diagnostic

The opt-in `footballCoachCalibration.football.test.ts` produced
[the complete comparison report](data/football-coach-calibration.json) from the
unchanged Week 5 file and hash-verified cached nflverse/FTN sources. Its 64 matchups
give each active club four appearances against two opponents, two home games,
one coached home game, and one coached away game. Each matchup runs in native
automatic, interactive automatic, and tactical modes (192 complete games).
All 64 automatic/interactive-automatic pairs were exactly equal.

The declared tactical policy uses varied concepts, native run/pass decisions,
normal huddling, situational late-game tempo, and only the selected club's
offense, defense, and timeouts. The report includes its seeds, call counts,
denominators, full game aggregates, and bootstrap intervals. Actual NFL totals
include kneels and spikes; throws exclude sacks and conversions. Real observations
and simulation outputs are separate cohorts throughout.

| Metric                          | Observed NFL 2025 | Native automatic | Coached team | Coached opponent |
| ------------------------------- | ----------------: | ---------------: | -----------: | ---------------: |
| Points per team game            |             22.98 |            24.59 |        24.53 |            21.00 |
| Offensive plays per team game   |             61.46 |            61.77 |        63.39 |            59.72 |
| Completion rate                 |            63.97% |           61.83% |       67.93% |           57.98% |
| Sack rate per pass play         |             6.86% |            7.12% |        5.30% |            6.84% |
| Interceptions per throw         |             2.21% |            2.39% |        2.80% |            3.42% |
| Rushing yards per attempt       |              4.34 |             4.86 |         4.32 |             4.78 |
| Gross passing yards per attempt |              7.00 |             7.09 |         7.57 |             6.64 |

Play volume and coached rushing averages are close in this sample. Passing
efficiency and interception rates remain uneven between coached clubs and their
opponents, so this does not establish NFL calibration. The fixed 2026 roster,
limited opponent set, and declared policy differ from the observed 2025 schedule;
bootstrap intervals describe these sampled games, not all possible leagues or
coaching strategies. The historical seasons also supply the empirical profiles,
so this is not held-out validation. No engine coefficients were fitted to these
results. Further passing/defensive balance work should use separate validation
games and examine the underlying interactions before changing probabilities.

## Scope and license

This is a source-level Football GM integration inspired by play-calling games.
It does not contain the proprietary Two-Minute Drill engine, its assets, or an
exact reconstruction of its probabilities. Tactical route/personnel/defense
controls extend the native simulation; direct player movement is not implemented.
Custom league shootouts remain automatic and their scores are displayed.

The existing [license](LICENSE.md) permits private local play and source sharing.
It prohibits publishing a playable fork for other users. Keep this application
bound to localhost and preserve the license when sharing source.
