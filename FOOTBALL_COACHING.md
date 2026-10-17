# Native Football GM play calling

Implemented on `feat/football-interactive-sim`, based on the official
`zengm-games/zengm` GitHub source at `83061b3ac545fa1e2fe324587a1330334e5bfabb`.

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

In **Weekly Schedule**, **Sim game** now opens play calling. **Quick sim** retains
automatic simulation; **Watch game** retains the original replay. All-star games
continue to use the native automatic simulation.

## Controls and saving

Call plays for both teams using the simulator's supported choices: run, pass,
kneel, punt, field goal, kickoff, onside kick, extra point, and two-point conversion.
Available calls follow the current game situation and league settings. Manage
tempo and either team's timeout after a running-clock play, before runoff occurs.
Manual kneels allow defensive timeouts before their runoff, including late games.

The screen displays native scores, field position, recent play-by-play, and
personnel from the previous snap. Jump to the final two minutes or finish
automatically at any time a decision is pending. The weekly schedule provides a
resume link if you navigate away. The top Play menu's **Finish coached game**
also finishes and saves the game.

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

## Verification

```sh
node --run lint
node --run pre-test
pnpm exec vitest run --project football --project basketball --project baseball
SPORT=football node --run build
```

On the development machine's Node 25 runtime, tests were run with
`NODE_OPTIONS=--no-experimental-webstorage` to disable its incompatible native
localStorage implementation. All 563 runnable Node tests passed; 12 upstream
tests were skipped. Browser tests were not run: browser automation was blocked
by approval verification. The interface still needs a manual browser acceptance
pass; this is not a claim of perfect compatibility with every league export.

New coverage checks exact seeded automatic/native result parity, paused decisions,
legal calls, overtime, zero-second conversions, timeouts, manual kneels, detached
snapshots, stale/double submissions, and two-minute jumping. A real native pipeline
test checks one box score, player/team statistics, the correct schedule removal,
and a league close that waits for the persistence boundary. The supplied league
export was also validated read-only against the current native football schema.

## Scope and license

This is a source-level Football GM integration inspired by play-calling games.
It does not contain the proprietary Two-Minute Drill engine, its assets, or an
exact reconstruction of its probabilities. Native Football GM does not implement
route-level selection, defensive formations selected by a human, or direct player
movement; those controls are not invented here. Custom league shootouts remain
automatic and their scores are displayed.

The existing [license](LICENSE.md) permits private local play and source sharing.
It prohibits publishing a playable fork for other users. Keep this application
bound to localhost and preserve the license when sharing source.
