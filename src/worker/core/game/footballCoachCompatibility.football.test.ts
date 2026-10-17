import { assert, describe, test, vi } from "vitest";
// @ts-expect-error Test-only Node module is outside the browser project's ambient types.
import fs from "node:fs/promises";
import leagueFileUpload, {
	CUMULATIVE_OBJECTS,
	decompressStreamIfNecessary,
	parseJSON,
} from "../../api/leagueFileUpload.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { idb } from "../../db/index.ts";
import { g, helpers, local } from "../../util/index.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { LEAGUE_DATABASE_VERSION, PHASE } from "../../../common/constants.ts";
import { unwrapGameAttribute } from "../../../common/unwrapGameAttribute.ts";
import type {
	GameAttributesLeagueWithHistory,
	Player,
	Team,
	TeamNum,
	TeamSeasonWithoutKey,
} from "../../../common/types.ts";
import type { FootballCoachSnapshot } from "../../../common/footballCoach.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";
import type { PlayerGameSim } from "../GameSim.football/types.ts";
import {
	FOOTBALL_COACH_CALLS,
	FOOTBALL_COACH_DEFENSES,
} from "../../../common/footballCoachPlaybook.ts";
import createGameAttributes from "../league/createGameAttributes.ts";
import processPlayerNewLeague from "../league/processPlayerNewLeague.ts";
import type { TeamInfo } from "../league/createStream.ts";
import { player, team } from "../index.ts";
import GameSim from "../GameSim.football/index.ts";
import loadTeams from "./loadTeams.ts";

/**
 * Opt-in, read-only compatibility runs against actual local exports. No user
 * exports are copied into this repository. Pass a JSON array of file paths:
 *
 * FOOTBALL_COACH_COMPATIBILITY_FILES='["/absolute/path/league.json.gz"]' \
 * NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run \
 * --project football src/worker/core/game/footballCoachCompatibility.football.test.ts
 *
 * This exercises native decompression/parsing, game-attribute/player import
 * normalization, player values, depth charts, cache loading, and full games.
 * The cache is isolated and in memory. This is not a browser-upload or full
 * createStream database-migration/persistence test.
 */
const environment = (
	globalThis as unknown as {
		process: { env: Record<string, string | undefined> };
	}
).process.env;
const configured = environment.FOOTBALL_COACH_COMPATIBILITY_FILES;
const paths: unknown = configured === undefined ? [] : JSON.parse(configured);
if (
	!Array.isArray(paths) ||
	!paths.every((path) => typeof path === "string" && path.length > 0)
) {
	throw new Error(
		"FOOTBALL_COACH_COMPATIBILITY_FILES must be a JSON array of local file paths.",
	);
}
const files = paths as string[];

type ParsedExport = {
	version: number;
	startingSeason?: number;
	gameAttributes: Partial<GameAttributesLeagueWithHistory>;
	teams: (TeamInfo & { depth?: Team["depth"] })[];
	players: Player[];
	teamSeasons?: TeamSeasonWithoutKey[];
};

const uploadChecks = new WeakMap<
	ParsedExport,
	{ schemaErrorCount: number; schemaErrorKinds: string[] }
>();

const referencePromise: Promise<FootballCoachReference> = fs
	.readFile(
		new URL(
			"../../../../public/files/football-coach-reference.json",
			import.meta.url,
		),
		"utf8",
	)
	.then(JSON.parse);

const digest = async (input: Uint8Array | string) => {
	const bytes =
		typeof input === "string"
			? new TextEncoder().encode(input)
			: Uint8Array.from(input);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};

const readNativeExport = async (bytes: Uint8Array) => {
	const upload = await leagueFileUpload.initialCheck(
		{
			file: new File([Uint8Array.from(bytes)], "compatibility.json"),
			includePlayersInBasicInfo: false,
		},
		{},
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
	assert.isArray(parsed.teams, "Export must contain teams");
	assert.isArray(parsed.players, "Export must contain players");
	assert.isNumber(
		parsed.version,
		"Export must declare its native schema version",
	);
	const result = parsed as ParsedExport;
	assert.equal(upload.basicInfo.version, result.version);
	assert.equal(upload.basicInfo.teams?.length, result.teams.length);
	uploadChecks.set(result, {
		schemaErrorCount: upload.schemaErrors.length,
		// Keep diagnostics, never the verbose AJV data containing player records.
		schemaErrorKinds: [
			...new Set(
				upload.schemaErrors.map((error) =>
					typeof error === "string"
						? error
						: `${error.instancePath}: ${error.message}`,
				),
			),
		],
	});
	return result;
};

const finiteStats = (value: unknown, path = "stats") => {
	if (typeof value === "number") {
		assert.isTrue(Number.isFinite(value), `${path} must be finite`);
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			finiteStats(child, `${path}.${key}`);
		}
	}
};

const validateNativeExport = async (
	parsed: ParsedExport,
	label: string,
	fileHash?: string,
) => {
	const reference = await referencePromise;
	const originalHash = await digest(JSON.stringify(parsed));
	const originalG = { ...g };
	const originalLocal = { ...local };
	const originalCache = idb.cache;
	const random = vi.spyOn(Math, "random");
	const seed = (initial: number) => {
		let state = initial;
		random.mockImplementation(() => {
			state = (1664525 * state + 1013904223) >>> 0;
			return state / 2 ** 32;
		});
	};
	try {
		resetG();
		local.reset();
		seed(987654321);
		const active = parsed.teams.filter((entry) => !entry.disabled);
		const activeTids = active.map((entry) => entry.tid);
		const selectedTid = unwrapGameAttribute(parsed.gameAttributes, "userTid");
		assert.include(activeTids, selectedTid, "Selected team must be active");
		const season = unwrapGameAttribute(parsed.gameAttributes, "season");
		assert.isTrue(Number.isInteger(season));
		const attributes = await createGameAttributes({
			gameAttributesInput: structuredClone(parsed.gameAttributes),
			startingSeason: parsed.startingSeason ?? season,
			teamInfos: structuredClone(parsed.teams),
			userTid: selectedTid,
			version: parsed.version,
		});
		Object.assign(g, attributes);
		assert.equal(g.get("userTid"), selectedTid);
		assert.deepEqual(g.get("userTids"), attributes.userTids);
		const importedPlayers: Player[] = [];
		const hasRookieContracts = parsed.players.some((p) => p.contract?.rookie);
		for (const source of parsed.players) {
			const normalized = await processPlayerNewLeague({
				p: structuredClone(source),
				activeTids,
				hasRookieContracts,
				noStartingInjuries: false,
				realPlayerPhotos: undefined,
				scoutingLevel: DEFAULT_LEVEL,
				version: parsed.version,
			});
			assert.isTrue(Number.isInteger((normalized as Player).pid));
			importedPlayers.push(normalized as Player);
		}
		const importedTeams = structuredClone(parsed.teams).map(team.generate);
		const teamSeasons = importedTeams.map((entry) => {
			const sourceTeam = parsed.teams.find((t) => t.tid === entry.tid)!;
			const sourceSeason =
				parsed.teamSeasons?.find(
					(row) => row.tid === entry.tid && row.season === season,
				) ?? sourceTeam.seasons?.find((row) => row.season === season);
			return {
				...team.genSeasonRow(entry),
				...structuredClone(sourceSeason),
			};
		});
		await resetCache({
			players: importedPlayers,
			teams: importedTeams,
			teamSeasons,
			teamStats: importedTeams.map((entry) => team.genStatsRow(entry.tid)),
		});
		// Native post-import player values use the whole imported population.
		for (const p of importedPlayers) {
			await player.updateValues(p);
		}
		for (const entry of importedTeams) {
			if (
				!entry.disabled &&
				!parsed.teams.find((t) => t.tid === entry.tid)?.depth
			) {
				entry.depth = await team.genDepth(
					importedPlayers.filter((p) => p.tid === entry.tid),
				);
			}
		}
		const unavailableCounts = new Map(
			activeTids.map((tid) => [
				tid,
				importedPlayers.filter(
					(p) => p.tid === tid && p.injury.gamesRemaining > 0,
				).length,
			]),
		);
		const opponent = [...active]
			.filter((entry) => entry.tid !== selectedTid)
			.sort(
				(a, b) => unavailableCounts.get(b.tid)! - unavailableCounts.get(a.tid)!,
			)[0]!;
		const loaded = await loadTeams(activeTids, {});
		for (const tid of activeTids) {
			const entry = loaded[tid]!;
			assert.equal(entry.id, tid);
			assert.equal(
				entry.player.length,
				importedPlayers.filter((p) => p.tid === tid).length,
			);
			entry.depth = team.getDepthPlayers(entry.depth, entry.player);
			for (const p of entry.player) {
				finiteStats(p.compositeRating, `Player ${p.id} composite ratings`);
				assert.isTrue(Number.isFinite(p.valueNoPot));
			}
		}
		const summaries: Record<string, unknown>[] = [];
		const runGame = async (
			mode: "automatic" | "interactiveAuto" | "coach",
			controlled: TeamNum,
		) => {
			seed(123456789 + (mode === "coach" ? controlled + 1 : 0));
			const pair =
				controlled === 0
					? [loaded[selectedTid]!, loaded[opponent.tid]!]
					: [loaded[opponent.tid]!, loaded[selectedTid]!];
			const game = new GameSim({
				gid: 1,
				teams: structuredClone(pair) as ConstructorParameters<
					typeof GameSim
				>[0]["teams"],
				baseInjuryRate: g.get("injuryRate"),
				doPlayByPlay: true,
				homeCourtFactor: 1,
				allStarGame: false,
				neutralSite: false,
			});
			game.setCoachTeam(controlled);
			if (mode === "coach") {
				game.setCoachReference(reference);
			}
			assert.equal(game.team[controlled].id, selectedTid);
			const unavailable = new Set(
				game.team.flatMap((t) =>
					t.player.filter((p) => p.injured).map((p) => p.id),
				),
			);
			let offensiveCalls = 0;
			let defensiveCalls = 0;
			let clockChoices = 0;
			let snapshots = 0;
			const referenceProfiles = new Set<string>();
			const ownershipRejections = new Set<string>();
			const checkSnapshot = (snapshot: FootballCoachSnapshot) => {
				snapshots += 1;
				assert.isBelow(snapshots, 2000, "Game must make progress");
				assert.equal(snapshot.controlledTeam, controlled);
				assert.equal(snapshot.teams[controlled].id, selectedTid);
				assert.equal(snapshot.numPeriods, g.get("numPeriods"));
				assert.equal(snapshot.boxScore?.season, season);
				if (snapshot.lastCall?.referenceProfile) {
					referenceProfiles.add(snapshot.lastCall.referenceProfile);
					assert.isAbove(snapshot.lastCall.referenceSampleSize!, 0);
				}
				const other: TeamNum = controlled === 0 ? 1 : 0;
				if (snapshot.stage === "clock" && !ownershipRejections.has("timeout")) {
					assert.throws(
						() => game.validateCoachDecision({ timeout: other }, snapshot),
						/own team/,
					);
					ownershipRejections.add("timeout");
				}
				if (
					snapshot.stage === "play" &&
					snapshot.allowedPlays.includes("run")
				) {
					if (
						snapshot.offense === controlled &&
						!ownershipRejections.has("defense")
					) {
						assert.throws(
							() =>
								game.validateCoachDecision(
									{ defenseId: FOOTBALL_COACH_DEFENSES[0]!.id },
									snapshot,
								),
							/own team/,
						);
						ownershipRejections.add("defense");
					} else if (
						snapshot.offense !== controlled &&
						!ownershipRejections.has("offense")
					) {
						assert.throws(
							() =>
								game.validateCoachDecision(
									{ callId: FOOTBALL_COACH_CALLS[0]!.id },
									snapshot,
								),
							/own team/,
						);
						ownershipRejections.add("offense");
					}
				}
				finiteStats([
					snapshot.clock,
					snapshot.down,
					snapshot.toGo,
					snapshot.scrimmage,
					snapshot.timeouts,
				]);
				assert.isAtLeast(snapshot.clock, 0);
				for (const t of [0, 1] as const) {
					const owned = new Set(game.team[t].player.map((p) => p.id));
					assert.isTrue(
						snapshot.playersOnField[t].every((p) => owned.has(p.id)),
					);
					assert.equal(
						new Set(snapshot.playersOnField[t].map((p) => p.id)).size,
						snapshot.playersOnField[t].length,
					);
					finiteStats(snapshot.boxScore?.teams[t].stat);
					for (const p of snapshot.boxScore?.teams[t].players ?? []) {
						assert.isTrue(owned.has(p.id));
						finiteStats(p.stat, `Live player ${p.id}`);
					}
				}
				for (const p of [
					...(snapshot.eligibleReceivers ?? []),
					...(snapshot.eligibleRushers ?? []),
				]) {
					assert.isFalse(p.injured);
					assert.isFalse(unavailable.has(p.id));
					assert.isTrue(
						game.team[snapshot.offense].player.some(
							(entry) => entry.id === p.id,
						),
					);
				}
			};
			const result =
				mode === "automatic"
					? game.run()
					: await game.runInteractive((snapshot) => {
							checkSnapshot(snapshot);
							if (mode === "interactiveAuto") {
								return undefined;
							}
							if (snapshot.stage === "clock") {
								clockChoices += 1;
								if (snapshot.clock < 1 && snapshot.canTimeout[controlled]) {
									return { timeout: controlled };
								}
								return snapshot.offense === controlled
									? { tempo: "hurryUp" }
									: {};
							}
							if (!snapshot.allowedPlays.includes("run")) {
								return undefined;
							}
							if (snapshot.offense === controlled) {
								return {
									callId:
										FOOTBALL_COACH_CALLS[
											offensiveCalls++ % FOOTBALL_COACH_CALLS.length
										]!.id,
								};
							}
							return {
								defenseId:
									FOOTBALL_COACH_DEFENSES[
										defensiveCalls++ % FOOTBALL_COACH_DEFENSES.length
									]!.id,
							};
						});
			assert.equal(result.playByPlay?.at(-1)?.type, "gameOver");
			for (const entry of result.team) {
				finiteStats(entry.stat);
				assert.isAbove(entry.stat.pss + entry.stat.rus, 0);
				const sourceRoster = new Set(
					importedPlayers.filter((p) => p.tid === entry.id).map((p) => p.pid),
				);
				for (const p of entry.player) {
					assert.isTrue(sourceRoster.has(p.id));
					finiteStats(p.stat, `Final player ${p.id}`);
					if (unavailable.has(p.id)) {
						assert.equal(
							p.stat.gp,
							0,
							"Initially unavailable players must not participate",
						);
					}
				}
			}
			if (mode === "coach") {
				assert.isAbove(offensiveCalls, 0);
				assert.isAbove(defensiveCalls, 0);
				assert.isAbove(clockChoices, 0);
				assert.isAbove(
					referenceProfiles.size,
					0,
					"Coached games must sample the bundled empirical reference",
				);
			}
			if (mode !== "automatic") {
				assert.deepEqual([...ownershipRejections].sort(), [
					"defense",
					"offense",
					"timeout",
				]);
			}
			summaries.push({
				mode,
				controlled,
				selectedTid,
				opponentTid: opponent.tid,
				score: result.team.map((t) => t.stat.pts),
				offensiveCalls,
				defensiveCalls,
				clockChoices,
				snapshots,
				referenceProfiles: [...referenceProfiles].sort(),
				periodsPlayed: result.team[0].stat.ptsQtrs.length,
				ownershipRejections: [...ownershipRejections].sort(),
				initiallyUnavailable: unavailable.size,
			});
			return result;
		};
		const automatic = await runGame("automatic", 0);
		const interactiveAuto = await runGame("interactiveAuto", 0);
		assert.deepEqual(
			interactiveAuto,
			automatic,
			"Undefined interactive decisions must preserve exact automatic native results",
		);
		await runGame("coach", 0);
		await runGame("coach", 1);
		assert.equal(await digest(JSON.stringify(parsed)), originalHash);
		const statSeasons = parsed.players
			.flatMap((p) => p.stats?.map((row) => row.season) ?? [])
			.filter(Number.isFinite);
		const report = {
			file: label,
			sha256: fileHash,
			version: parsed.version,
			uploadInspection: uploadChecks.get(parsed),
			season,
			players: importedPlayers.length,
			activeTeams: active.length,
			teamsLoadedForSimulation: Object.keys(loaded).length,
			loadedTeamIds: activeTids,
			configuration: {
				startingSeason: g.get("startingSeason"),
				season: g.get("season"),
				numPeriods: g.get("numPeriods"),
				quarterLength: g.get("quarterLength"),
				maxOvertimes: g.get("maxOvertimes", "current"),
				footballOvertime: g.get("footballOvertime", "current"),
			},
			injuryEligibility: Object.values(loaded).flatMap((entry) =>
				entry!.player
					.filter((p: PlayerGameSim) => p.injury.gamesRemaining > 0)
					.map((p: PlayerGameSim) => ({
						tid: entry!.id,
						pid: p.id,
						gamesRemaining: p.injury.gamesRemaining,
						injured: p.injured,
						playingThrough: p.injury.playingThrough,
					})),
			),
			disabledTeams: parsed.teams.length - active.length,
			injuredPlayers: parsed.players.filter((p) => p.injury?.gamesRemaining > 0)
				.length,
			teamsWithDepth: parsed.teams.filter((t) => t.depth !== undefined).length,
			statSeasons: statSeasons.length
				? [Math.min(...statSeasons), Math.max(...statSeasons)]
				: [],
			selectedTid,
			userTids: g.get("userTids"),
			sourceUnchanged: true,
			exactAutomaticParity: true,
			games: summaries,
		};
		// Summaries deliberately omit per-player eligibility records from stdout.
		console.info(JSON.stringify({ ...report, injuryEligibility: undefined }));
		return report;
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
};

describe.skipIf(files.length === 0)(
	"local export coaching compatibility",
	() => {
		test.each(files.length > 0 ? files : ["No local export paths configured"])(
			"native import/load and games: %s",
			async (path) => {
				// PII processing boundary: league rosters stay local; reports contain
				// aggregate counts, game results, file names, and hashes, not player records.
				const bytes: Uint8Array = await fs.readFile(path);
				const fileHash = await digest(bytes);
				await validateNativeExport(
					await readNativeExport(bytes),
					path.split("/").at(-1)!,
					fileHash,
				);
				assert.equal(await digest(await fs.readFile(path)), fileHash);
			},
			180_000,
		);
	},
);

type GeneratedCase = {
	name: string;
	season: number;
	numTeams: number;
	activeTids: number[];
	selectedTid: number;
	numPeriods: number;
	quarterLength: number;
	startingInjuries: boolean;
};

const generatedCases: GeneratedCase[] = [
	{
		name: "historical start in 1965 with fictional native-generated players",
		season: 1965,
		numTeams: 4,
		activeTids: [0, 1, 2, 3],
		selectedTid: 3,
		numPeriods: 4,
		quarterLength: 15,
		startingInjuries: false,
	},
	{
		name: "custom clubs with active IDs 2 and 5 and disabled historical slots",
		season: 2034,
		numTeams: 6,
		activeTids: [2, 5],
		selectedTid: 5,
		numPeriods: 4,
		quarterLength: 15,
		startingInjuries: false,
	},
	{
		name: "two seven-minute periods and user/AI play-through injury policies",
		season: 2041,
		numTeams: 2,
		activeTids: [0, 1],
		selectedTid: 1,
		numPeriods: 2,
		quarterLength: 7,
		startingInjuries: true,
	},
];

// Generated fixtures are fictional software-test data, not NFL evidence or user exports.
const makeGeneratedExport = async (
	scenario: GeneratedCase,
): Promise<ParsedExport> => {
	const originalG = { ...g };
	const originalLocal = { ...local };
	const random = vi.spyOn(Math, "random");
	let state = 612356721;
	random.mockImplementation(() => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 2 ** 32;
	});
	try {
		resetG();
		local.reset();
		g.setWithoutSavingToDB("season", scenario.season);
		g.setWithoutSavingToDB("startingSeason", scenario.season);
		const teams = helpers
			.getTeamsDefault()
			.slice(0, scenario.numTeams)
			.map((source, tid) => ({
				...source,
				tid,
				cid: 0,
				did: 0,
				region: `Fixture Region ${tid}`,
				name: `Fictional Club ${tid}`,
				abbrev: `FX${tid}`,
				disabled: !scenario.activeTids.includes(tid),
				playThroughInjuries: [2, 2] as [number, number],
			}));
		const players = scenario.activeTids
			.flatMap((tid) =>
				Array.from({ length: 50 }, (_, index) => {
					const generated = player.generate(
						tid,
						25 + (index % 9),
						scenario.season - 6,
						true,
						DEFAULT_LEVEL,
					);
					const pid = 10_000 + tid * 1000 + index * 3;
					generated.firstName = "Fictional";
					generated.lastName = `Fixture ${pid}`;
					if (scenario.startingInjuries && index < 2) {
						generated.injury = {
							type: "Generated test injury",
							gamesRemaining: index === 0 ? 2 : 9,
						};
					}
					return { ...generated, pid } as Player;
				}),
			)
			.reverse();
		const source: ParsedExport = {
			version: LEAGUE_DATABASE_VERSION,
			startingSeason: scenario.season,
			gameAttributes: {
				season: scenario.season,
				startingSeason: scenario.season,
				phase: PHASE.REGULAR_SEASON,
				userTid: [{ start: -Infinity, value: scenario.selectedTid }],
				userTids: scenario.startingInjuries
					? [scenario.selectedTid]
					: scenario.activeTids,
				confs: [
					{ start: -Infinity, value: [{ cid: 0, name: "Fixture Conference" }] },
				],
				divs: [
					{
						start: -Infinity,
						value: [{ did: 0, cid: 0, name: "Fixture Division" }],
					},
				],
				numGamesPlayoffSeries: [{ start: -Infinity, value: [1] }],
				numPlayoffByes: [{ start: -Infinity, value: 0 }],
				playoffsByConf: false,
				numPeriods: scenario.numPeriods,
				quarterLength: scenario.quarterLength,
				maxOvertimes: [{ start: -Infinity, value: 0 }],
				footballOvertime: "suddenDeath",
				injuryRate: 0,
			},
			teams,
			players,
		};
		// Round-trip a real JSON byte stream so historical dates and wrapped null
		// starts follow the same parser and normalizer as an uploaded export.
		return await readNativeExport(
			new TextEncoder().encode(JSON.stringify(source)),
		);
	} finally {
		random.mockRestore();
		for (const key of Object.keys(g)) {
			if (!Object.hasOwn(originalG, key)) {
				delete (g as Record<string, unknown>)[key];
			}
		}
		Object.assign(g, originalG);
		Object.assign(local, originalLocal);
	}
};

describe("generated native league edge cases", () => {
	test.each(generatedCases)(
		"$name",
		async (scenario) => {
			const source = await makeGeneratedExport(scenario);
			assert.isTrue(source.players.every((p) => p.born.year < scenario.season));
			assert.isTrue(
				source.players.every((p) =>
					p.ratings.every((row) => row.season === scenario.season),
				),
			);
			const report = await validateNativeExport(
				source,
				`GENERATED: ${scenario.name}`,
			);
			assert.equal(report.version, LEAGUE_DATABASE_VERSION);
			assert.equal(report.configuration.startingSeason, scenario.season);
			assert.equal(report.configuration.season, scenario.season);
			assert.equal(report.configuration.numPeriods, scenario.numPeriods);
			assert.equal(report.configuration.quarterLength, scenario.quarterLength);
			assert.equal(report.configuration.maxOvertimes, 0);
			assert.equal(report.configuration.footballOvertime, "suddenDeath");
			assert.deepEqual(report.loadedTeamIds, scenario.activeTids);
			assert.equal(
				report.disabledTeams,
				scenario.numTeams - scenario.activeTids.length,
			);
			assert.equal(report.selectedTid, scenario.selectedTid);
			assert.equal(report.players, scenario.activeTids.length * 50);
			assert.equal(report.games.length, 4);
			assert.equal(report.uploadInspection?.schemaErrorCount, 0);
			assert.isTrue(
				report.games.every(
					(game) => game.periodsPlayed === scenario.numPeriods,
				),
			);
			if (scenario.startingInjuries) {
				assert.equal(report.injuredPlayers, 4);
				assert.lengthOf(report.injuryEligibility, 4);
				for (const injured of report.injuryEligibility) {
					const permitted =
						injured.tid === scenario.selectedTid &&
						injured.gamesRemaining === 2;
					assert.equal(injured.playingThrough, permitted);
					assert.equal(injured.injured, !permitted);
				}
			}
		},
		60_000,
	);
});
