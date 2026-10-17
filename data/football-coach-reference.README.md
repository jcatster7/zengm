# Public NFL reference for Football Coach

Generated file: [`../public/files/football-coach-reference.json`](../public/files/football-coach-reference.json). The normal build copies this to `/files/football-coach-reference.json`; consumers load it on demand. The generator never reads or uploads league files or spreadsheets.

## Rebuild

```sh
node tools/football-coach/buildNflverseReference.ts
node tools/football-coach/buildNflverseReference.ts --seasons 2023,2024,2025 --cache /tmp/football-coach-nflverse --out public/files/football-coach-reference.json
```

The default cache is `football-coach-nflverse` inside the operating system's temporary directory, outside Git. Each cached download has URL and SHA-256 metadata; corrupt cache entries cause an explicit error. Remove the affected cache file and its matching `.json` sidecar to download a new source revision. The output includes generation time and actual source-byte hashes. Upstream release URLs are mutable; retain the cached bytes for exact reproducibility. Rebuilding the same cached inputs changes only `generatedAt`.

## Sources and licenses

- Play-by-play: [nflverse-data releases](https://github.com/nflverse/nflverse-data/releases/tag/pbp), `play_by_play_2023.csv.gz`, `2024.csv.gz`, `2025.csv.gz`. [Canonical nflreadr loader](https://github.com/nflverse/nflreadr/blob/main/R/load_pbp.R). [CC BY 4.0](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md).
- Charting: **FTN Data via nflverse**, [public releases](https://github.com/nflverse/nflverse-data/releases/tag/ftn_charting), `ftn_charting_2023.csv`, `2024.csv`, `2025.csv`. [Canonical loader and attribution requirement](https://nflreadr.nflverse.com/reference/load_ftn_charting.html). [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- Player identities: [nflverse players V2](https://github.com/nflverse/nflverse-data/releases/tag/players), `players.csv`. [Canonical identity contract](https://nflreadr.nflverse.com/reference/load_players.html). [CC BY 4.0](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md).

The generated **profiles** adapt PBP and FTN charting and are distributed under **CC BY-SA 4.0**, attributed to **nflverse and FTN Data via nflverse**. The generated player identity subset is attributed to **nflverse**, under **CC BY 4.0**. Changes: rows filtered and joined, broad classes assigned by the definitions below, outcomes aggregated, names/IDs reduced to a recent-player crosswalk. This data license does not change the application code license. Source URLs, license URLs and hashes are embedded in the JSON. No reference-site code, artwork, paid feeds or private APIs are included.

## Inclusion, joins, and denominators

The current output covers completed 2023–2025 seasons, regular season and postseason. It has 103,312 eligible plays: 34,969 in 2023, 34,367 in 2024, and 33,976 in 2025. Every eligible play joined an FTN row. These counts describe this checked-in source revision, not a promise about future upstream updates.

Eligibility requires `play_type` run/pass and finite `yards_gained`. Exclude deleted plays, every play flagged `penalty` (including declined/offsetting cases), kneels, spikes, two-point attempts, and other play types such as `no_play`. There is no late-game-only or team/player skill filter. FTN joins use `(season,nflverse_game_id,nflverse_play_id)` to PBP `(season,game_id,play_id)`. Duplicate eligible identities, missing required headers, invalid seasons and an entirely unmatched season fail the build. Missing individual chart rows do not become inferred flags.

Profile memberships overlap. An RPO screen may also appear in a pass-depth profile. Samples are descriptive and are not independent cohorts. A profile with zero observed examples is omitted, with no substitute estimate.

| Profile ID   | Classification among eligible plays                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `runInside`  | Non-scramble run; `run_location=middle` or `run_gap=guard`                                                                                      |
| `runOutside` | Non-scramble run not classified inside; `run_gap=tackle` or `end`                                                                               |
| `runDraw`    | Non-scramble run whose description contains the whole word `draw`. No examples in this release; profile omitted. Shotgun alone is not evidence. |
| `passShort`  | Non-sack pass, valid `air_yards < 10`                                                                                                           |
| `passMedium` | Non-sack pass, valid `10 <= air_yards < 20`                                                                                                     |
| `passDeep`   | Non-sack pass, valid `air_yards >= 20`                                                                                                          |
| `passScreen` | Pass with FTN `is_screen_pass=TRUE`                                                                                                             |
| `rpo`        | FTN `is_rpo=TRUE`, run or pass                                                                                                                  |
| `trick`      | FTN `is_trick_play=TRUE`, run or pass                                                                                                           |

- `sampleSize`: all qualifying plays in that profile.
- `meanYards`: total PBP `yards_gained` / `sampleSize`, including negative yards, incompletions, and qualifying sacks.
- `completionRate`: `complete_pass` count / `passAttempts`; an attempt requires `pass_attempt=1` and `sack!=1`. Null when there are no throws. Sacks never inflate the throw denominator.
- `turnoverRate`: plays with `interception=1` **or** `fumble_lost=1` / `sampleSize`. This counts an event once per play, not net final possession after multiple turnovers, and excludes turnovers on downs.
- `passRate`: `qb_dropback=1` count / `sampleSize`, including sacks/scrambles.
- `meanAirYards`: average valid PBP `air_yards` on actual throws only; null if none. `airYardsSampleSize` is its denominator.
- `airYardsDistribution`: exact integer yard values and counts on throws with known air yards, including incomplete and intercepted passes. Count total equals `airYardsSampleSize`.
- `rushYardsDistribution`: exact `yards_gained` values/counts where `rush_attempt=1`, including scrambles in RPO/trick profiles. Count total equals `rushSampleSize`.
- Rates/means are rounded to eight decimals; counts and histograms are exact. No fabricated bounds, probabilities, missing values or route-specific statistics.

Depth profiles condition on **observed throws** and cannot estimate the probability of a sack before a throw. Histograms are empirical reference samples, not calibrated native-engine coefficients or a replication of the reference website's hidden model. Native Football GM rules, rosters, injuries and persistence remain authoritative.

## Identity subset

Players are included when `last_season` or `rookie_season` is at least the earliest requested season. The current build contains 4,377 IDs, including recently active players and newer rookies. This keeps the file compact while covering current rosters; older retired players can remain unmatched. `gsisId` is canonical and `pfrId` is an optional crosswalk. `name` comes from V2 `display_name`, `birthYear` from `birth_date`. `team` is the latest published team, **not** a historical team for the profile period. Native Football GM `pid` is unrelated to GSIS; ambiguous name matches must not be silently accepted.

## Tests

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run --project football tools/football-coach/buildNflverseReference.football.test.ts
```

Tests cover numeric play-ID joins, malformed/duplicate inputs, sample exclusions, nullable values, sacks and rate denominators, independent histogram totals, and the generated public artifact's provenance/identity/schema integrity. Test CSV fixtures are deliberately small invented inputs used only to verify code; the published JSON is generated exclusively from the listed public downloads.
