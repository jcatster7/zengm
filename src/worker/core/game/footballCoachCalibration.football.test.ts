import { assert, test, vi } from "vitest";
// @ts-expect-error Node-only diagnostics are outside browser ambient types.
import fs from "node:fs/promises";
// @ts-expect-error Node-only diagnostics are outside browser ambient types.
import { tmpdir } from "node:os";
// @ts-expect-error Node-only diagnostics are outside browser ambient types.
import { gunzipSync } from "node:zlib";
import { csvParseRows } from "d3-dsv";
import leagueFileUpload, {
	CUMULATIVE_OBJECTS,
	decompressStreamIfNecessary,
	parseJSON,
} from "../../api/leagueFileUpload.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { idb } from "../../db/index.ts";
import { g, local } from "../../util/index.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { unwrapGameAttribute } from "../../../common/unwrapGameAttribute.ts";
import { makeSeededRandom } from "../../../common/random.ts";
import type {
	GameAttributesLeagueWithHistory,
	Player,
	Team,
	TeamNum,
	TeamSeasonWithoutKey,
} from "../../../common/types.ts";
import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";
import {
	FOOTBALL_COACH_CALLS,
	type FootballCoachCallId,
} from "../../../common/footballCoachPlaybook.ts";
import createGameAttributes from "../league/createGameAttributes.ts";
import processPlayerNewLeague from "../league/processPlayerNewLeague.ts";
import type { TeamInfo } from "../league/createStream.ts";
import { player, team } from "../index.ts";
import GameSim from "../GameSim.football/index.ts";
import loadTeams from "./loadTeams.ts";

/**
 * Opt-in diagnostic, not an assertion of NFL-calibrated outcomes. Example:
 * FOOTBALL_COACH_CALIBRATION_FILE='/absolute/path/league.json.gz' \
 * FOOTBALL_COACH_CALIBRATION_OUTPUT='/tmp/football-coach-calibration.json' \
 * NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run --project football \
 * src/worker/core/game/footballCoachCalibration.football.test.ts
 *
 * Optional FOOTBALL_COACH_CALIBRATION_GAMES (default 64) and
 * FOOTBALL_COACH_CALIBRATION_CACHE (default OS temp football-coach-nflverse).
 * No downloads, browser, league persistence, or calibration/tuning occur.
 */
const env = (
	globalThis as unknown as {
		process: { env: Record<string, string | undefined> };
	}
).process.env;
const sourcePath = env.FOOTBALL_COACH_CALIBRATION_FILE;

type Export = {
	version: number;
	startingSeason?: number;
	gameAttributes: Partial<GameAttributesLeagueWithHistory>;
	teams: (TeamInfo & { depth?: Team["depth"] })[];
	players: Player[];
	teamSeasons?: TeamSeasonWithoutKey[];
};
type Totals = {
	teamGames: number;
	points: number;
	throws: number;
	completions: number;
	sacks: number;
	interceptions: number;
	rushes: number;
	rushYards: number;
	passYards: number;
};
const empty = (): Totals => ({
	teamGames: 0,
	points: 0,
	throws: 0,
	completions: 0,
	sacks: 0,
	interceptions: 0,
	rushes: 0,
	rushYards: 0,
	passYards: 0,
});
const sum = (rows: Totals[]) => {
	const result = empty();
	for (const row of rows) {
		for (const key of Object.keys(result) as (keyof Totals)[]) {
			result[key] += row[key];
		}
	}
	return result;
};
const metrics = (row: Totals) => ({
	pointsPerTeamGame: row.points / row.teamGames,
	offensivePlaysPerTeamGame:
		(row.throws + row.sacks + row.rushes) / row.teamGames,
	throwsPerTeamGame: row.throws / row.teamGames,
	rushesPerTeamGame: row.rushes / row.teamGames,
	completionRate: row.completions / row.throws,
	sackRatePerPassPlay: row.sacks / (row.throws + row.sacks),
	interceptionRatePerThrow: row.interceptions / row.throws,
	rushYardsPerAttempt: row.rushYards / row.rushes,
	passYardsPerAttempt: row.passYards / row.throws,
	passPlayShare:
		(row.throws + row.sacks) / (row.throws + row.sacks + row.rushes),
});
const summarize = (gameBlocks: Totals[]) => {
	const totals = sum(gameBlocks);
	const values = metrics(totals);
	const samples = Object.fromEntries(
		Object.keys(values).map((key) => [key, [] as number[]]),
	);
	const random = makeSeededRandom(872345);
	for (let repeat = 0; repeat < 1000; repeat += 1) {
		const drawn = Array.from(
			{ length: gameBlocks.length },
			() => gameBlocks[Math.floor(random() * gameBlocks.length)]!,
		);
		for (const [key, value] of Object.entries(metrics(sum(drawn)))) {
			samples[key]!.push(value);
		}
	}
	const intervals = Object.fromEntries(
		Object.entries(samples).map(([key, draws]) => {
			draws.sort((a, b) => a - b);
			return [key, [draws[24], draws[974]]];
		}),
	);
	return {
		gameBlocks: gameBlocks.length,
		totals,
		metrics: values,
		bootstrap95PercentIntervals: intervals,
	};
};
const sha256 = async (input: Uint8Array) =>
	Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(input)),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
const number = (value: string | undefined) =>
	value && value !== "NA" ? Number(value) : undefined;
const isOne = (value: string | undefined) => value === "1";

const observedBaseline = async (
	reference: FootballCoachReference,
	cache: string,
) => {
	const verifiedSources = [];
	const seasons: {
		season: number;
		games: Totals[];
		kneels: number;
		spikes: number;
	}[] = [];
	let referenceEligiblePlays = 0;
	let countedPenaltyPlays = 0;
	for (const source of reference.sources) {
		const name = source.url.split("/").at(-1)!;
		const path = `${cache}/${name}`;
		const bytes: Uint8Array = await fs.readFile(path);
		assert.equal(
			await sha256(bytes),
			source.sha256,
			`Cached source hash: ${name}`,
		);
		const sidecar = JSON.parse(await fs.readFile(`${path}.json`, "utf8"));
		assert.equal(sidecar.url, source.url);
		assert.equal(sidecar.sha256, source.sha256);
		verifiedSources.push({
			...source,
			bytes: bytes.length,
			cacheHashVerified: true,
		});
		const match = /^play_by_play_(\d{4})\.csv\.gz$/.exec(name);
		if (!match) {
			continue;
		}
		const games = new Map<
			string,
			{ teams: [Totals, Totals]; score: [number, number] }
		>();
		const columns = [
			"game_id",
			"season_type",
			"home_team",
			"away_team",
			"posteam",
			"home_score",
			"away_score",
			"play_type",
			"play_deleted",
			"two_point_attempt",
			"pass_attempt",
			"rush_attempt",
			"sack",
			"complete_pass",
			"interception",
			"passing_yards",
			"rushing_yards",
			"lateral_rushing_yards",
			"qb_kneel",
			"qb_spike",
			"penalty",
			"yards_gained",
		];
		let indexes: number[] = [];
		let kneels = 0;
		let spikes = 0;
		csvParseRows(gunzipSync(bytes).toString("utf8"), (cells, index) => {
			if (index === 0) {
				indexes = columns.map((column) => {
					const position = cells.indexOf(column);
					assert.isAtLeast(position, 0, `Missing PBP field ${column}`);
					return position;
				});
				return null;
			}
			const row = Object.fromEntries(
				columns.map((column, i) => [column, cells[indexes[i]!] ?? ""]),
			);
			if (!["REG", "POST"].includes(row.season_type!)) {
				return null;
			}
			const homeScore = number(row.home_score);
			const awayScore = number(row.away_score);
			assert.isTrue(Number.isFinite(homeScore) && Number.isFinite(awayScore));
			let game = games.get(row.game_id!);
			if (!game) {
				game = {
					teams: [
						{ ...empty(), teamGames: 1, points: homeScore! },
						{ ...empty(), teamGames: 1, points: awayScore! },
					],
					score: [homeScore!, awayScore!],
				};
				games.set(row.game_id!, game);
			}
			assert.deepEqual(
				game.score,
				[homeScore, awayScore],
				"Final PBP score must be consistent",
			);
			if (
				!["run", "pass", "qb_kneel", "qb_spike"].includes(row.play_type!) ||
				isOne(row.play_deleted) ||
				isOne(row.two_point_attempt)
			) {
				return null;
			}
			assert.include([row.home_team, row.away_team], row.posteam);
			const stats = game.teams[row.posteam === row.home_team ? 0 : 1];
			const sack = isOne(row.sack);
			const rush = isOne(row.rush_attempt);
			const pass = isOne(row.pass_attempt) && !sack;
			assert.equal(
				Number(sack) + Number(rush) + Number(pass),
				1,
				"Each counted offensive play has one statistical class",
			);
			stats.sacks += Number(sack);
			stats.throws += Number(pass);
			stats.rushes += Number(rush);
			stats.completions += Number(isOne(row.complete_pass));
			stats.interceptions += Number(isOne(row.interception));
			kneels += Number(isOne(row.qb_kneel));
			spikes += Number(isOne(row.qb_spike));
			if (rush) {
				assert.isTrue(
					Number.isFinite(number(row.rushing_yards)),
					"Counted rush must have credited yardage",
				);
				stats.rushYards +=
					number(row.rushing_yards)! + (number(row.lateral_rushing_yards) ?? 0);
			}
			if (isOne(row.complete_pass)) {
				assert.isTrue(
					pass && Number.isFinite(number(row.passing_yards)),
					"Completion must have credited passing yards",
				);
				stats.passYards += number(row.passing_yards)!;
			}
			countedPenaltyPlays += Number(isOne(row.penalty));
			referenceEligiblePlays += Number(
				["run", "pass"].includes(row.play_type!) &&
					!isOne(row.penalty) &&
					!isOne(row.qb_kneel) &&
					!isOne(row.qb_spike) &&
					Number.isFinite(number(row.yards_gained)),
			);
			return null;
		});
		seasons.push({
			season: Number(match[1]),
			games: Array.from(games.values(), (entry) => sum(entry.teams)),
			kneels,
			spikes,
		});
	}
	assert.deepEqual(
		seasons.map((entry) => entry.season).sort(),
		[...reference.seasons].sort(),
	);
	return {
		verifiedSources,
		seasons,
		referenceEligiblePlays,
		countedPenaltyPlays,
	};
};

const parseExport = async (bytes: Uint8Array) => {
	const inspection = await leagueFileUpload.initialCheck(
		{
			file: new File([Uint8Array.from(bytes)], "calibration.json"),
			includePlayersInBasicInfo: false,
		},
		{},
	);
	assert.lengthOf(
		inspection.schemaErrors,
		0,
		"Source must pass native upload inspection",
	);
	const stream = await decompressStreamIfNecessary(
		new Blob([Uint8Array.from(bytes)]).stream(),
	);
	const reader = (stream as ReadableStream<Uint8Array<ArrayBuffer>>)
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(parseJSON())
		.getReader();
	const parsed: Record<string, unknown> = {};
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (CUMULATIVE_OBJECTS.has(value.key)) {
			parsed[value.key] = value.value;
		} else {
			((parsed[value.key] ??= []) as unknown[]).push(value.value);
		}
	}
	return parsed as Export;
};

const normalize = async (parsed: Export) => {
	resetG();
	local.reset();
	const activeTids = parsed.teams
		.filter((entry) => !entry.disabled)
		.map((entry) => entry.tid)
		.sort((a, b) => a - b);
	const season = unwrapGameAttribute(parsed.gameAttributes, "season");
	const attributes = await createGameAttributes({
		gameAttributesInput: structuredClone(parsed.gameAttributes),
		startingSeason: parsed.startingSeason ?? season,
		teamInfos: structuredClone(parsed.teams),
		userTid: unwrapGameAttribute(parsed.gameAttributes, "userTid"),
		version: parsed.version,
	});
	Object.assign(g, attributes);
	const players: Player[] = [];
	const hasRookieContracts = parsed.players.some(
		(entry) => entry.contract?.rookie,
	);
	for (const source of parsed.players) {
		players.push(
			(await processPlayerNewLeague({
				p: structuredClone(source),
				activeTids,
				hasRookieContracts,
				noStartingInjuries: false,
				realPlayerPhotos: undefined,
				scoutingLevel: DEFAULT_LEVEL,
				version: parsed.version,
			})) as Player,
		);
	}
	const teams = structuredClone(parsed.teams).map(team.generate);
	const teamSeasons = teams.map((entry) => ({
		...team.genSeasonRow(entry),
		...structuredClone(
			parsed.teamSeasons?.find(
				(row) => row.tid === entry.tid && row.season === season,
			) ??
				parsed.teams
					.find((row) => row.tid === entry.tid)
					?.seasons?.find((row) => row.season === season),
		),
	}));
	await resetCache({
		players,
		teams,
		teamSeasons,
		teamStats: teams.map((entry) => team.genStatsRow(entry.tid)),
	});
	for (const p of players) {
		await player.updateValues(p);
	}
	for (const entry of teams) {
		if (
			!entry.disabled &&
			!parsed.teams.find((row) => row.tid === entry.tid)?.depth
		) {
			entry.depth = await team.genDepth(
				players.filter((p) => p.tid === entry.tid),
			);
		}
	}
	const loaded = await loadTeams(activeTids, {});
	for (const tid of activeTids) {
		loaded[tid]!.depth = team.getDepthPlayers(
			loaded[tid]!.depth,
			loaded[tid]!.player,
		);
	}
	return { activeTids, loaded, players: players.length, season };
};

const fromNative = (stats: Record<string, number>): Totals => ({
	teamGames: 1,
	points: stats.pts!,
	throws: stats.pss!,
	completions: stats.pssCmp!,
	sacks: stats.pssSk!,
	interceptions: stats.pssInt!,
	rushes: stats.rus!,
	rushYards: stats.rusYds!,
	passYards: stats.pssYds!,
});

test.skipIf(!sourcePath)(
	"diagnoses full games against cached observed NFL baselines",
	async () => {
		const games = Number(env.FOOTBALL_COACH_CALIBRATION_GAMES ?? 64);
		assert.isTrue(Number.isInteger(games) && games >= 1 && games <= 512);
		const cache =
			env.FOOTBALL_COACH_CALIBRATION_CACHE ??
			`${tmpdir()}/football-coach-nflverse`;
		const output =
			env.FOOTBALL_COACH_CALIBRATION_OUTPUT ??
			`${tmpdir()}/football-coach-calibration.json`;
		const referenceBytes = await fs.readFile(
			new URL(
				"../../../../public/files/football-coach-reference.json",
				import.meta.url,
			),
		);
		const reference: FootballCoachReference = JSON.parse(
			referenceBytes.toString("utf8"),
		);
		const observed = await observedBaseline(reference, cache);
		// PII boundary: local source records are read into memory for native import.
		// Only aggregate game statistics and content hashes leave this boundary.
		const bytes: Uint8Array = await fs.readFile(sourcePath!);
		const fileHash = await sha256(bytes);
		const parsed = await parseExport(bytes);
		const originalG = { ...g };
		const originalLocal = { ...local };
		const originalCache = idb.cache;
		const random = vi
			.spyOn(Math, "random")
			.mockImplementation(makeSeededRandom(20261017));
		try {
			const normalized = await normalize(parsed);
			assert.equal(
				normalized.activeTids.length % 2,
				0,
				"Balanced round-robin requires an even team count",
			);
			const schedules: { pair: [number, number]; controlled: TeamNum }[] = [];
			const rotation = [...normalized.activeTids];
			for (let round = 0; schedules.length < games; round += 1) {
				for (
					let i = 0;
					i < rotation.length / 2 && schedules.length < games;
					i += 1
				) {
					const pair: [number, number] = [
						rotation[i]!,
						rotation[rotation.length - 1 - i]!,
					];
					// Play each opponent home and away. Across two rounds, each
					// club is coached once at home and once away, with equal AI exposure.
					const controlled: TeamNum = round % 2 === 0 ? 0 : 1;
					schedules.push({ pair, controlled });
					if (schedules.length < games) {
						schedules.push({ pair: [pair[1], pair[0]], controlled });
					}
				}
				rotation.splice(1, 0, rotation.pop()!);
			}
			const clockChoices: Record<string, number> = {};
			const calls: Record<string, number> = {};
			const defenseChoices: Record<string, number> = {};
			const sampledProfiles = new Set<string>();
			const rows: {
				seed: number;
				teamIds: [number, number];
				controlled: TeamNum;
				automatic: Totals[];
				tactical: Totals[];
			}[] = [];
			const chooseFrom = <T>(
				options: readonly T[],
				policyRandom: () => number,
			) => options[Math.floor(policyRandom() * options.length)]!;
			const profile = (id: string) =>
				reference.profiles.find((entry) => entry.id === id)!;
			const rpoRate =
				profile("rpo").sampleSize / observed.referenceEligiblePlays;
			const trickRate =
				profile("trick").sampleSize / observed.referenceEligiblePlays;
			for (const [index, { pair, controlled }] of schedules.entries()) {
				const seed = 503000 + index;
				const run = async (
					mode: "automatic" | "interactiveAuto" | "tactical",
				) => {
					random.mockImplementation(makeSeededRandom(seed));
					const game = new GameSim({
						gid: index,
						teams: structuredClone(
							pair.map((tid) => normalized.loaded[tid]!),
						) as ConstructorParameters<typeof GameSim>[0]["teams"],
						baseInjuryRate: g.get("injuryRate"),
						doPlayByPlay: true,
						homeCourtFactor: 1,
						allStarGame: false,
						neutralSite: false,
					});
					game.setCoachTeam(controlled);
					if (mode !== "automatic") {
						game.setCoachReference(reference);
					}
					const policyRandom = makeSeededRandom(913000 + index);
					let pauses = 0;
					const choose = (
						snapshot: FootballCoachSnapshot,
					): FootballCoachDecision | undefined => {
						assert.isBelow(++pauses, 2500, "Game must complete");
						if (mode === "interactiveAuto") {
							return undefined;
						}
						if (snapshot.lastCall?.referenceProfile) {
							sampledProfiles.add(snapshot.lastCall.referenceProfile);
						}
						const ownOffense = snapshot.offense === controlled;
						const margin =
							snapshot.teams[controlled].pts -
							snapshot.teams[controlled === 0 ? 1 : 0].pts;
						if (snapshot.stage === "clock") {
							const final = snapshot.quarter >= snapshot.numPeriods;
							if (
								snapshot.canTimeout[controlled] &&
								snapshot.clock < 1 &&
								((ownOffense && margin <= 0) ||
									(!ownOffense && final && margin < 0))
							) {
								clockChoices.timeout = (clockChoices.timeout ?? 0) + 1;
								return { timeout: controlled };
							}
							if (!ownOffense) {
								return {};
							}
							const tempo =
								final && snapshot.clock < 2 && margin > 0
									? "chewClock"
									: snapshot.clock < 2 &&
										  ((final && margin <= 0) || snapshot.quarter === 2)
										? "hurryUp"
										: "normal";
							clockChoices[tempo] = (clockChoices[tempo] ?? 0) + 1;
							return { tempo };
						}
						if (!snapshot.allowedPlays.includes("run")) {
							return undefined;
						}
						if (!ownOffense) {
							const defenseId =
								snapshot.scrimmage >= 95 && snapshot.toGo <= 3
									? "goalLine"
									: snapshot.clock < 0.5 && margin > 3
										? "dime"
										: policyRandom() < 0.15
											? "blitz"
											: snapshot.toGo >= 7
												? "nickel"
												: "base43";
							defenseChoices[defenseId] = (defenseChoices[defenseId] ?? 0) + 1;
							return { defenseId };
						}
						const native = game.getPlayType();
						if (native !== "run" && native !== "pass") {
							return native === "fieldGoalLate" ? undefined : { play: native };
						}
						const category = policyRandom();
						let callId: FootballCoachCallId;
						if (category < trickRate) {
							callId =
								native === "run"
									? "reverse"
									: chooseFrom(
											["fleaFlicker", "halfbackPass"] as const,
											policyRandom,
										);
						} else if (category < trickRate + rpoRate) {
							callId = chooseFrom(
								["zoneBubble", "zoneSlant", "zoneFlat"] as const,
								policyRandom,
							);
						} else if (native === "run") {
							callId =
								snapshot.toGo <= 1 && policyRandom() < 0.25
									? "qbSneak"
									: chooseFrom(
											[
												"insideZone",
												"insideZone",
												"outsideZone",
												"outsideZone",
												"power",
												"counter",
												"draw",
												"toss",
											] as const,
											policyRandom,
										);
						} else {
							const short = profile("passShort").sampleSize;
							const medium = profile("passMedium").sampleSize;
							const deep = profile("passDeep").sampleSize;
							const depthDraw = policyRandom() * (short + medium + deep);
							const depthCalls =
								depthDraw < short
									? (["slant", "hitch", "quickOut", "drag", "stick"] as const)
									: depthDraw < short + medium
										? (["curl", "dig", "seam"] as const)
										: (["corner", "post", "go"] as const);
							callId =
								depthDraw < short &&
								policyRandom() < profile("passScreen").sampleSize / short
									? chooseFrom(["rbScreen", "wrScreen"] as const, policyRandom)
									: chooseFrom(depthCalls, policyRandom);
						}
						assert.isTrue(
							FOOTBALL_COACH_CALLS.some((entry) => entry.id === callId),
						);
						calls[callId] = (calls[callId] ?? 0) + 1;
						return { callId };
					};
					return mode === "automatic"
						? game.run()
						: await game.runInteractive(choose);
				};
				const automatic = await run("automatic");
				assert.deepEqual(
					await run("interactiveAuto"),
					automatic,
					`Exact native parity seed ${seed}`,
				);
				const tactical = await run("tactical");
				const record = {
					seed,
					teamIds: pair,
					controlled,
					automatic: automatic.team.map((entry) => fromNative(entry.stat)),
					tactical: tactical.team.map((entry) => fromNative(entry.stat)),
				};
				for (const entry of [...record.automatic, ...record.tactical]) {
					assert.isTrue(Object.values(entry).every(Number.isFinite));
					assert.isAtMost(
						entry.completions + entry.interceptions,
						entry.throws,
					);
				}
				rows.push(record);
			}
			assert.equal(
				await sha256(await fs.readFile(sourcePath!)),
				fileHash,
				"Local source must remain unchanged",
			);
			assert.isAbove(sampledProfiles.size, 0);
			const teamExposures = normalized.activeTids.map((tid) => {
				const involving = rows.filter((row) => row.teamIds.includes(tid));
				return {
					tid,
					games: involving.length,
					home: involving.filter((row) => row.teamIds[0] === tid).length,
					coachedHome: involving.filter(
						(row) => row.controlled === 0 && row.teamIds[0] === tid,
					).length,
					coachedAway: involving.filter(
						(row) => row.controlled === 1 && row.teamIds[1] === tid,
					).length,
					opponents: [
						...new Set(
							involving.flatMap((row) =>
								row.teamIds.filter((id) => id !== tid),
							),
						),
					],
				};
			});
			if (games % (2 * normalized.activeTids.length) === 0) {
				for (const exposure of teamExposures) {
					assert.equal(
						exposure.games,
						(2 * games) / normalized.activeTids.length,
					);
					assert.equal(exposure.home, games / normalized.activeTids.length);
					assert.equal(
						exposure.coachedHome,
						games / (2 * normalized.activeTids.length),
					);
					assert.equal(exposure.coachedAway, exposure.coachedHome);
				}
			}
			const report = {
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				purpose:
					"Full-game diagnostic; observed NFL data and simulated league games are distinct cohorts, not a fitted or validated replica of the reference website.",
				implementation: await Promise.all(
					[
						[
							"src/worker/core/game/footballCoachCalibration.football.test.ts",
							"./footballCoachCalibration.football.test.ts",
						],
						[
							"src/worker/core/GameSim.football/index.ts",
							"../GameSim.football/index.ts",
						],
						[
							"src/worker/core/GameSim.football/Play.ts",
							"../GameSim.football/Play.ts",
						],
						[
							"src/common/footballCoachPlaybook.ts",
							"../../../common/footballCoachPlaybook.ts",
						],
					].map(async ([path, relative]) => ({
						path,
						sha256: await sha256(
							await fs.readFile(new URL(relative!, import.meta.url)),
						),
					})),
				),
				limitations: [
					"Simulation uses one fixed 2026 Week5 league roster, ratings, depth charts, and injury state; each game starts fresh. This is not a simulation of actual 2025 NFL rosters or results.",
					"The 64-game design covers two opponents per club. Bootstrap intervals resample these games conditional on these fixed rosters, matchups, policy, and engine settings; they do not represent uncertainty across roster releases, policies, or model parameters and do not establish general NFL calibration.",
					"The 2023–2025 observed comparison overlaps the empirical reference's training period. It is descriptive benchmarking, not held-out validation.",
					"Named offensive tactics, defensive choices, personnel, timing, and empirical sampling change together. These comparisons do not isolate the causal effect of any one component.",
					"Call counts record submitted decisions, including calls replayed after pre-snap penalties. Game-stat denominators record credited plays only.",
					"This harness reads and normalizes the native export and runs GameSim in memory. It does not test browser upload, full createStream migrations, or persistence.",
					"The observed play-type filter excludes rare pass-attempt flags on no_play or special-teams rows, including two 2025 rows (intentional grounding and a blocked-field-goal recovery pass). Observed counts are not claimed to reproduce every official season total exactly.",
					"The tactical callback calls native getPlayType(), which consumes native randomness. Its named play, formation, and clock branches also change subsequent random consumption. Shared seeds pair scenarios; only automatic versus undefined-decision interactive-auto is asserted draw-for-draw equal.",
				],
				league: {
					sha256: fileHash,
					version: parsed.version,
					season: normalized.season,
					players: normalized.players,
					activeTeams: normalized.activeTids.length,
					sourceUnchanged: true,
				},
				reference: {
					sha256: await sha256(referenceBytes),
					seasons: reference.seasons,
					verifiedSources: observed.verifiedSources,
					attribution:
						"nflverse (PBP and player identities, CC BY 4.0); FTN Data via nflverse (charting and derived profiles, CC BY-SA 4.0)",
				},
				configuration: {
					gamesPerMode: games,
					exactAutomaticParityGames: games,
					normalizationSeed: 20261017,
					simulationSeeds: [503000, 503000 + games - 1],
					policySeeds: [913000, 913000 + games - 1],
					quarterLength: g.get("quarterLength"),
					numPeriods: g.get("numPeriods"),
					footballOvertime: g.get("footballOvertime", "current"),
					pace: g.get("pace"),
					passYdsFactor: g.get("passYdsFactor"),
					rushYdsFactor: g.get("rushYdsFactor"),
					injuryRate: g.get("injuryRate"),
					teamExposures,
				},
				definitions: {
					points:
						"Final team points including all scoring types; both regulation and any overtime.",
					offensivePlays:
						"Actual throws + sacks + rush attempts; includes spikes and kneels; excludes kicks, conversions, deleted/nullified plays. PBP uses run/pass/qb_kneel/qb_spike play types and statistical attempt flags. Penalties that leave credited statistics stand are included.",
					completion: "Completed throws / actual throws; sacks excluded.",
					sack: "Sacks / (actual throws + sacks); scrambles are rushes, so this is not sack/dropback rate.",
					interception: "Interceptions / actual throws.",
					rushYards:
						"Native rusYds or PBP rushing_yards + lateral_rushing_yards, divided by rush attempts; includes kneels/scrambles.",
					passYards:
						"Gross native pssYds or PBP credited passing_yards on completions, divided by actual throws; sack yards excluded.",
					uncertainty:
						"1000 percentile bootstrap resamples by whole game; deterministic seed872345; 2.5%/97.5% order statistics. Not significance thresholds or calibration acceptance bands.",
				},
				policy: {
					description:
						"Native run/pass/special-play decisions; varied named concepts; pass-depth weighting from observed throw counts, with FTN screen/RPO/trick frequencies as declared sampling choices. This is a diagnostic policy, not inferred NFL coaching behavior. Core run concepts use explicit equal/repeated weights; short-yardage sneak chance25%; situational fronts with15% blitz. Only one club is controlled per game; opponent retains native offense. Normal huddle except final-two-minute urgency/protect-lead handling and late timeouts.",
					clockChoices,
					calls,
					defenseChoices,
					sampledProfiles: [...sampledProfiles].sort(),
					rpoRate,
					trickRate,
				},
				observedNFL: {
					seasons: observed.seasons.map((entry) => ({
						season: entry.season,
						kneels: entry.kneels,
						spikes: entry.spikes,
						...summarize(entry.games),
					})),
					pooled: summarize(observed.seasons.flatMap((entry) => entry.games)),
					countedPenaltyPlays: observed.countedPenaltyPlays,
					referenceEligiblePlays: observed.referenceEligiblePlays,
				},
				simulated: {
					automatic: summarize(rows.map((row) => sum(row.automatic))),
					tacticalBothTeams: summarize(rows.map((row) => sum(row.tactical))),
					tacticalControlledTeam: summarize(
						rows.map((row) => row.tactical[row.controlled]!),
					),
					tacticalOpponent: summarize(
						rows.map((row) => row.tactical[row.controlled === 0 ? 1 : 0]!),
					),
				},
				games: rows,
			};
			await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
			console.info(
				JSON.stringify({
					output,
					gamesPerMode: games,
					exactAutomaticParityGames: games,
					observed2025: report.observedNFL.seasons.find(
						(entry) => entry.season === 2025,
					)?.metrics,
					simulated: Object.fromEntries(
						Object.entries(report.simulated).map(([key, value]) => [
							key,
							value.metrics,
						]),
					),
				}),
			);
		} finally {
			random.mockRestore();
			idb.cache = originalCache;
			for (const key of Object.keys(g)) {
				if (!Object.hasOwn(originalG, key)) {
					delete (g as Record<string, unknown>)[key];
				}
			}
			Object.assign(g, originalG);
			Object.assign(local, originalLocal);
		}
	},
	180000,
);
