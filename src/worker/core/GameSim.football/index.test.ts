import { assert, beforeAll, expect, test, vi } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import Play from "./Play.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { range } from "../../../common/utils.ts";
import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import {
	FOOTBALL_COACH_CALLS,
	FOOTBALL_COACH_DEFENSES,
	FOOTBALL_COACH_PERSONNEL,
	validateFootballCoachDecision,
} from "../../../common/footballCoachPlaybook.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";
import { processStats } from "../../../common/processPlayerStats.football.ts";
import type { PlayerStatsToProcess } from "../../../common/types.ts";

export const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	await resetCache({
		players: [
			...range(50).map(() => player.generate(0, 25, 2010, true, DEFAULT_LEVEL)),
			...range(50).map(() => player.generate(1, 25, 2010, true, DEFAULT_LEVEL)),
		],
		teams: teamsDefault.map(team.generate),
		teamSeasons: teamsDefault.map((t) => team.genSeasonRow(t)),
		teamStats: teamsDefault.map((t) => team.genStatsRow(t.tid)),
	});
};

export const initGameSim = async () => {
	const teams = await loadTeams([0, 1], {});
	for (const t of [teams[0], teams[1]]) {
		if (t.depth !== undefined) {
			t.depth = team.getDepthPlayers(t.depth, t.player);
		}
	}
	return new GameSim({
		gid: 0,
		teams: [teams[0], teams[1]],
		baseInjuryRate: g.get("injuryRate"),
		doPlayByPlay: false,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: false,
	});
};

beforeAll(async () => {
	await genTwoTeams();
});

const mockSeededRandom = () => {
	let seed = 123456789;
	return vi.spyOn(Math, "random").mockImplementation(() => {
		seed = (1664525 * seed + 1013904223) >>> 0;
		return seed / 2 ** 32;
	});
};

const initCoachScrimmage = async () => {
	const game = await initGameSim();
	// Random roster generation can omit a natural RB or WR entirely. These
	// tactical fixtures require both roles; preserve generated ratings and depth.
	for (const t of game.team) {
		for (const pos of ["RB", "WR"] as const) {
			if (!t.player.some((p) => p.pos === pos)) {
				const otherPos = pos === "RB" ? "WR" : "RB";
				const replacement =
					t.depth[pos].find((p) => p.pos !== otherPos) ?? t.depth[pos][0]!;
				replacement.pos = pos;
			}
		}
	}
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.clock = 10;
	game.scrimmage = 30;
	game.playByPlay.active = true;
	game.baseInjuryRate = 0;
	game.setCoachTeam(0);
	game.checkPenalties = () => false;
	game.probFumble = () => 0;
	game.probSack = () => 0;
	game.probScramble = () => 0;
	game.probInt = () => 0;
	game.probComplete = () => 1;
	return game;
};

const playOneCoachSnap = async (
	game: GameSim,
	decision: FootballCoachDecision,
) => {
	let submitted = false;
	const random = mockSeededRandom();
	try {
		await expect(
			game.runInteractive((snapshot) => {
				if (snapshot.stage === "clock") {
					return {};
				}
				if (submitted) {
					throw new Error("one coached snap complete");
				}
				submitted = true;
				return decision;
			}),
		).rejects.toThrow("one coached snap complete");
		return game.getCoachSnapshot("play");
	} finally {
		random.mockRestore();
	}
};

test.each(FOOTBALL_COACH_CALLS)(
	"$name resolves through native plays and statistics",
	async (call) => {
		const game = await initCoachScrimmage();
		const snapshot = await playOneCoachSnap(game, { callId: call.id });
		assert.equal(snapshot.lastCall?.callId, call.id);
		assert.equal(game.team[0].stat.pss + game.team[0].stat.rus, 1);
		for (const t of [0, 1] as const) {
			assert.equal(snapshot.playersOnField[t].length, 11);
			assert.equal(
				new Set(snapshot.playersOnField[t].map((p) => p.id)).size,
				11,
			);
		}
		for (const [position, count] of Object.entries(
			FOOTBALL_COACH_PERSONNEL[call.formation].positions,
		)) {
			assert.lengthOf(game.playersOnField[0][position as "QB"]!, count);
		}
		assert.isTrue(
			snapshot.events.some(
				(event) => event.type === "run" || event.type === "passComplete",
			),
		);
	},
);

test("formation previews are detached, unique, and consume no simulation randomness", async () => {
	const game = await initCoachScrimmage();
	const random = vi.spyOn(Math, "random");
	try {
		const snapshot = game.getCoachSnapshot("play");
		assert.equal(random.mock.calls.length, 0);
		for (const lineup of [
			...Object.values(snapshot.lineups!.offense),
			...Object.values(snapshot.lineups!.defense),
		]) {
			assert.equal(lineup.length, 11);
			assert.equal(new Set(lineup.map((p) => p.id)).size, 11);
		}
		snapshot.lineups!.offense["11"][0]!.name = "changed";
		assert.notEqual(
			game.getCoachSnapshot("play").lineups!.offense["11"][0]!.name,
			"changed",
		);
	} finally {
		random.mockRestore();
	}
});

test("a selected bench receiver is pinned into the formation and receives the native target", async () => {
	const game = await initCoachScrimmage();
	const target = game
		.getCoachSnapshot("play")
		.eligibleReceivers!.filter((p) => p.pos === "WR")
		.at(-1)!;
	const snapshot = await playOneCoachSnap(game, {
		callId: "slant",
		targetPid: target.id,
	});
	const actual = game.team[0].player.find((p) => p.id === target.id)!;
	assert.equal(actual.stat.tgt, 1);
	assert.equal(actual.stat.rec, 1);
	assert.equal(
		game.team[0].player
			.filter((p) => p.id !== target.id)
			.reduce((sum, p) => sum + p.stat.tgt, 0),
		0,
	);
	assert.include(
		snapshot.playersOnField[0].map((p) => p.id),
		target.id,
	);
	assert.equal(snapshot.lastCall?.targetPid, target.id);
});

test("a selected running back gets the native carry and rushing yardage", async () => {
	const game = await initCoachScrimmage();
	const runner = game
		.getCoachSnapshot("play")
		.eligibleRushers!.filter((p) => p.pos === "RB")
		.at(-1)!;
	const snapshot = await playOneCoachSnap(game, {
		callId: "insideZone",
		runnerPid: runner.id,
	});
	const actual = game.team[0].player.find((p) => p.id === runner.id)!;
	assert.equal(actual.stat.rus, 1);
	assert.equal(actual.stat.rusYds, game.team[0].stat.rusYds);
	assert.equal(snapshot.lastCall?.runnerPid, runner.id);
});

test("halfback pass assigns pass statistics to the actual running back passer", async () => {
	const game = await initCoachScrimmage();
	const snapshot = await playOneCoachSnap(game, { callId: "halfbackPass" });
	const passer = game.team[0].player.find(
		(p) => p.id === snapshot.lastCall!.passerPid,
	)!;
	assert.include(game.playersOnField[0].RB!, passer);
	assert.equal(passer.stat.pss, 1);
	assert.equal(passer.stat.pssCmp, 1);
	assert.equal(game.playersOnField[0].QB![0]!.stat.pss, 0);
	assert.equal(passer.stat.pba, 0);
});

test("route depth changes yards, completion difficulty, and protection exposure", async () => {
	const results: { yds: number; sack: number; complete: number }[] = [];
	for (const route of ["hitch", "go"] as const) {
		const game = await initCoachScrimmage();
		const snapshot = await playOneCoachSnap(game, { callId: "slant", route });
		const qb = game.team[0].player.find(
			(p) => p.id === snapshot.lastCall!.passerPid,
		)!;
		const target = game.team[0].player.find(
			(p) => p.id === snapshot.lastCall!.targetPid,
		)!;
		const defender = game.playersOnField[1].CB![0]!;
		results.push({
			yds: game.team[0].stat.pssYds,
			sack: GameSim.prototype.probSack.call(game, qb),
			complete: GameSim.prototype.probComplete.call(game, qb, target, defender),
		});
	}
	assert.isAbove(results[1]!.yds, results[0]!.yds);
	assert.isAbove(results[1]!.sack, results[0]!.sack);
	assert.isAtMost(results[1]!.complete, results[0]!.complete);
});

test.each(FOOTBALL_COACH_DEFENSES)(
	"$name uses its actual personnel and rusher/coverage assignments",
	async (defense) => {
		const game = await initCoachScrimmage();
		game.setCoachTeam(1);
		const automatic = vi.spyOn(game, "getPlayType").mockReturnValue("pass");
		const snapshot = await playOneCoachSnap(game, { defenseId: defense.id });
		assert.equal(automatic.mock.calls.length, 1);
		assert.equal(snapshot.lastCall?.defenseId, defense.id);
		assert.lengthOf(snapshot.lastCall!.rusherPids!, defense.rushers);
		assert.lengthOf(snapshot.lastCall!.coveragePids!, 11 - defense.rushers);
		assert.equal(
			new Set([
				...snapshot.lastCall!.rusherPids!,
				...snapshot.lastCall!.coveragePids!,
			]).size,
			11,
		);
		for (const [position, count] of Object.entries(defense.positions)) {
			assert.lengthOf(game.playersOnField[1][position as "DL"]!, count);
		}
	},
);

test("blitz pressure changes the native sack and interception inputs", async () => {
	const pressures: number[] = [];
	const coverages: number[] = [];
	for (const defenseId of ["base34", "blitz"] as const) {
		const game = await initCoachScrimmage();
		game.setCoachTeam(1);
		game.getPlayType = () => "pass";
		await playOneCoachSnap(game, { defenseId });
		pressures.push(game.team[1].compositeRating.passRushing);
		coverages.push(game.team[1].compositeRating.passCoverage);
	}
	assert.isAbove(pressures[1]!, pressures[0]!);
	assert.isBelow(coverages[1]!, coverages[0]!);
});

test("a spike consumes a down and two seconds, stops the clock, and credits no receiver", async () => {
	const game = await initCoachScrimmage();
	game.isClockRunning = true;
	const snapshot = await playOneCoachSnap(game, { play: "spike" });
	assert.equal(snapshot.down, 2);
	assert.closeTo(snapshot.clock, 10 - 2 / 60, 1e-10);
	assert.equal(snapshot.scrimmage, 30);
	assert.isFalse(snapshot.isClockRunning);
	assert.equal(game.team[0].stat.pss, 1);
	assert.equal(game.team[0].stat.pssCmp, 0);
	assert.equal(
		game.team[0].player.reduce((sum, p) => sum + p.stat.tgt, 0),
		0,
	);
	assert.isTrue(snapshot.events.some((event) => event.type === "spike"));
});

test("fourth-down spike turns possession over through the native play state", async () => {
	const game = await initCoachScrimmage();
	game.down = 4;
	const snapshot = await playOneCoachSnap(game, { play: "spike" });
	assert.equal(snapshot.offense, 1);
	assert.equal(snapshot.down, 1);
	assert.equal(snapshot.scrimmage, 70);
});

test("spikes and tactical calls are rejected at kickoff, conversion, or no remaining time", async () => {
	const game = await initCoachScrimmage();
	game.clock = 0;
	assert.throws(() =>
		game.validateCoachDecision(
			{ play: "spike" },
			game.getCoachSnapshot("play"),
		),
	);
	for (const state of ["kickoff", "conversion"] as const) {
		game.clock = 10;
		game.awaitingKickoff = state === "kickoff" ? 0 : undefined;
		game.awaitingAfterTouchdown = state === "conversion";
		for (const decision of [{ play: "spike" }, { callId: "slant" }] as const) {
			assert.throws(() =>
				game.validateCoachDecision(decision, game.getCoachSnapshot("play")),
			);
		}
	}
});

test("ownership rejects every offensive override when the opponent has possession", async () => {
	const game = await initCoachScrimmage();
	game.setCoachTeam(1);
	const snapshot = game.getCoachSnapshot("play");
	for (const decision of [
		{ play: "run" },
		{ play: "spike" },
		{ callId: "slant" },
		{ targetPid: 0 },
		{ runnerPid: 0 },
		{ route: "go" },
	] as const) {
		assert.throws(
			() => validateFootballCoachDecision(decision, snapshot),
			/own team/,
		);
	}
	assert.doesNotThrow(() =>
		validateFootballCoachDecision({ defenseId: "blitz" }, snapshot),
	);
	assert.doesNotThrow(() =>
		validateFootballCoachDecision({ play: "auto" }, snapshot),
	);
	assert.doesNotThrow(() => validateFootballCoachDecision({}, snapshot));
});

test("ownership rejects opponent defense, timeout, and tempo overrides", async () => {
	const game = await initCoachScrimmage();
	assert.throws(
		() =>
			game.validateCoachDecision(
				{ defenseId: "blitz" },
				game.getCoachSnapshot("play"),
			),
		/own team/,
	);
	game.isClockRunning = true;
	assert.throws(
		() =>
			game.validateCoachDecision(
				{ timeout: 1 },
				game.getCoachSnapshot("clock"),
			),
		/own team/,
	);
	game.setCoachTeam(1);
	assert.throws(
		() =>
			game.validateCoachDecision(
				{ tempo: "chewClock" },
				game.getCoachSnapshot("clock"),
			),
		/own team/,
	);
	assert.doesNotThrow(() =>
		game.validateCoachDecision({ timeout: 1 }, game.getCoachSnapshot("clock")),
	);
});

test("invalid target roles, injuries, routes, and unknown decision keys are rejected before the snap", async () => {
	const game = await initCoachScrimmage();
	const snapshot = game.getCoachSnapshot("play");
	const rb = snapshot.eligibleRushers!.find((p) => p.pos === "RB")!;
	// A natural RB may legitimately be a depth-chart WR/QB on custom rosters.
	// This validation case explicitly excludes those permitted alternate roles.
	for (const formation of ["11", "13"] as const) {
		snapshot.lineups!.offense[formation] = snapshot.lineups!.offense[
			formation
		].filter((p) => p.id !== rb.id);
	}
	for (const decision of [
		{ callId: "slant", targetPid: rb.id },
		{ callId: "qbSneak", runnerPid: rb.id },
		{ callId: "insideZone", route: "go" },
		{ callId: "slant", targetPid: -9999 },
		{ callId: "slant", opponentScore: 99 },
	] as const) {
		assert.throws(() => game.validateCoachDecision(decision, snapshot));
	}
	const injured = game.team[0].player.find((p) => p.id === rb.id)!;
	injured.injured = true;
	assert.throws(() =>
		game.validateCoachDecision(
			{ callId: "insideZone", runnerPid: rb.id },
			game.getCoachSnapshot("play"),
		),
	);
	assert.equal(game.team[0].stat.rus + game.team[0].stat.pss, 0);
});

test("explicit no-timeout still allows the opposing AI to stop a late kneel", async () => {
	const game = await initKneelScenario();
	game.setCoachTeam(0);
	const snapshot = await playOneCoachSnap(game, { play: "kneel" });
	assert.equal(snapshot.timeouts[1], 2);
	assert.equal(snapshot.timeouts[0], 3);
	assert.closeTo(snapshot.clock * 60, 58, 1e-10);
});

test("the controlled defense gets a timeout window after an automatic opponent kneel", async () => {
	const game = await initKneelScenario();
	game.setCoachTeam(1);
	game.getPlayType = () => "kneel";
	let clockSeen = false;
	await expect(
		game.runInteractive((snapshot) => {
			if (snapshot.stage === "clock") {
				clockSeen = true;
				assert.closeTo(snapshot.clock * 60, 58, 1e-10);
				return { timeout: 1 };
			}
			if (clockSeen) {
				assert.closeTo(snapshot.clock * 60, 58, 1e-10);
				assert.equal(snapshot.timeouts[1], 2);
				throw new Error("opponent kneel stopped");
			}
			return { defenseId: "base43" };
		}),
	).rejects.toThrow("opponent kneel stopped");
});

// Deliberately minimal test fixture. It is not a claimed NFL measurement.
const coachReferenceFixture: FootballCoachReference = {
	schemaVersion: 1,
	generatedAt: "test fixture",
	seasons: [],
	sources: [],
	players: [],
	profiles: [
		{
			id: "runInside",
			label: "Test only",
			sampleSize: 20,
			completionRate: null,
			turnoverRate: 0,
			meanYards: 20,
			meanAirYards: null,
			passRate: 0,
			passAttempts: 0,
			airYardsSampleSize: 0,
			rushSampleSize: 20,
			rushYardsDistribution: [{ yards: 20, count: 20 }],
		},
	],
};

test("a supplied observed yard histogram changes the tactical baseline with native player adjustments", async () => {
	const without = await initCoachScrimmage();
	await playOneCoachSnap(without, { callId: "insideZone" });
	const withReference = await initCoachScrimmage();
	withReference.setCoachReference(coachReferenceFixture);
	const snapshot = await playOneCoachSnap(withReference, {
		callId: "insideZone",
	});
	assert.equal(snapshot.lastCall?.referenceProfile, "runInside");
	assert.equal(snapshot.lastCall?.referenceSampleSize, 20);
	assert.isAbove(
		withReference.team[0].stat.rusYds,
		without.team[0].stat.rusYds,
	);
});

test("missing empirical families use the native tactical fallback", async () => {
	const without = await initCoachScrimmage();
	const withoutSnapshot = await playOneCoachSnap(without, { callId: "draw" });
	const withReference = await initCoachScrimmage();
	withReference.setCoachReference(coachReferenceFixture);
	const snapshot = await playOneCoachSnap(withReference, { callId: "draw" });
	assert.isUndefined(snapshot.lastCall?.referenceProfile);
	assert.deepEqual(snapshot.events, withoutSnapshot.events);
});

test("control-team and reference setup preserve exact undefined-auto parity", async () => {
	let random = mockSeededRandom();
	let expected;
	try {
		const automatic = await initGameSim();
		expected = automatic.run();
	} finally {
		random.mockRestore();
	}
	random = mockSeededRandom();
	try {
		const interactive = await initGameSim();
		interactive.setCoachTeam(0);
		interactive.setCoachReference(coachReferenceFixture);
		assert.deepEqual(
			await interactive.runInteractive(() => undefined),
			expected,
		);
	} finally {
		random.mockRestore();
	}
});

test("a depth-chart receiver with a different natural position can be targeted", async () => {
	const game = await initCoachScrimmage();
	const projected = game
		.getCoachSnapshot("play")
		.lineups!.offense["11"].find((p) => p.slot === "WR1")!;
	const target = game.team[0].player.find((p) => p.id === projected.id)!;
	target.pos = "QB";
	const snapshot = await playOneCoachSnap(game, {
		callId: "slant",
		targetPid: target.id,
	});
	assert.equal(snapshot.lastCall?.targetPid, target.id);
	assert.include(game.playersOnField[0].WR!, target);
	assert.notInclude(game.playersOnField[0].QB!, target);
	assert.equal(target.stat.tgt, 1);
});

test("a selected reserve absent from positional depth is still pinned into the call", async () => {
	const game = await initCoachScrimmage();
	const target = game.team[0].player.find((p) => p.pos === "WR")!;
	game.team[0].depth.WR = game.team[0].depth.WR.filter(
		(p) => p.id !== target.id,
	);
	await playOneCoachSnap(game, { callId: "slant", targetPid: target.id });
	assert.include(game.playersOnField[0].WR!, target);
	assert.equal(target.stat.rec, 1);
});

test("native positional fallbacks support a roster lacking natural wide receivers", async () => {
	const game = await initCoachScrimmage();
	for (const player of game.team[0].player) {
		if (player.pos === "WR") {
			player.pos = "RB";
		}
	}
	const target = game
		.getCoachSnapshot("play")
		.lineups!.offense["11"].find((p) => p.slot === "WR1")!;
	const snapshot = await playOneCoachSnap(game, {
		callId: "slant",
		targetPid: target.id,
	});
	assert.equal(snapshot.playersOnField[0].length, 11);
	assert.equal(snapshot.lastCall?.targetPid, target.id);
	assert.equal(game.team[0].stat.pssCmp, 1);
});

test("an RPO player cannot be assigned simultaneously as receiver and runner", async () => {
	const game = await initCoachScrimmage();
	const player = game.getCoachSnapshot("play").eligibleRushers![0]!;
	assert.throws(
		() =>
			game.validateCoachDecision(
				{ callId: "zoneBubble", targetPid: player.id, runnerPid: player.id },
				game.getCoachSnapshot("play"),
			),
		/different players/,
	);
});

test.each(["run", "pass"] as const)(
	"the RPO read chooses native %s from the front and rating matchup",
	async (expected) => {
		const game = await initCoachScrimmage();
		const nativeUpdate = game.updateTeamCompositeRatings.bind(game);
		game.updateTeamCompositeRatings = () => {
			nativeUpdate();
			game.team[0].compositeRating.receiving = expected === "pass" ? 100 : 0;
		};
		const snapshot = await playOneCoachSnap(game, { callId: "zoneBubble" });
		assert.equal(snapshot.lastCall?.play, expected);
		assert.equal(game.team[0].stat[expected === "pass" ? "pss" : "rus"], 1);
	},
);

test("defensive coaching preserves the opponent offense's late timeout AI", async () => {
	const game = await initKneelScenario();
	game.team[0].stat.pts = 0;
	game.team[1].stat.pts = 7;
	game.setCoachTeam(1);
	game.getPlayType = () => "kneel";
	const snapshot = await playOneCoachSnap(game, { defenseId: "base43" });
	assert.equal(snapshot.timeouts[0], 2);
	assert.equal(snapshot.timeouts[1], 3);
	assert.closeTo(snapshot.clock * 60, 58, 1e-10);
});

test("the controlled defense can decline its AI timeout while the opponent kneels", async () => {
	const game = await initKneelScenario();
	game.setCoachTeam(1);
	game.getPlayType = () => "kneel";
	const snapshot = await playOneCoachSnap(game, { defenseId: "base43" });
	assert.deepEqual(snapshot.timeouts, [3, 3]);
	assert.closeTo(snapshot.clock * 60, 18, 1e-10);
});

test("an away-team coach completes a full native game with tactical calls, defenses, and own clock controls", async () => {
	const game = await initGameSim();
	game.setCoachTeam(1);
	game.setCoachReference(coachReferenceFixture);
	game.playByPlay.active = true;
	game.baseInjuryRate = 0;
	let offensiveCalls = 0;
	let defensiveCalls = 0;
	let clockChoices = 0;
	const families = new Set<string>();
	const random = mockSeededRandom();
	try {
		const result = await game.runInteractive((snapshot) => {
			assert.equal(snapshot.controlledTeam, 1);
			if (snapshot.stage === "clock") {
				clockChoices += 1;
				if (snapshot.clock < 1 && snapshot.canTimeout[1]) {
					return { timeout: 1 };
				}
				return snapshot.offense === 1 ? { tempo: "hurryUp" } : {};
			}
			if (!snapshot.allowedPlays.includes("run")) {
				return undefined;
			}
			if (snapshot.offense === 1) {
				const call =
					FOOTBALL_COACH_CALLS[offensiveCalls++ % FOOTBALL_COACH_CALLS.length]!;
				families.add(call.group);
				return { callId: call.id };
			}
			return {
				defenseId:
					FOOTBALL_COACH_DEFENSES[
						defensiveCalls++ % FOOTBALL_COACH_DEFENSES.length
					]!.id,
			};
		});
		assert.equal(result.playByPlay?.at(-1)?.type, "gameOver");
		assert.deepEqual([...families].sort(), ["pass", "rpo", "run", "trick"]);
		assert.isAbove(defensiveCalls, FOOTBALL_COACH_DEFENSES.length);
		assert.isAbove(clockChoices, 0);
		for (const team of result.team) {
			assert.isTrue(Number.isFinite(team.stat.pts));
			assert.isAbove(team.stat.pss + team.stat.rus, 0);
			for (const player of team.player) {
				for (const stat of [
					"pss",
					"pssYds",
					"rus",
					"rusYds",
					"rec",
					"recYds",
				]) {
					assert.isTrue(Number.isFinite(player.stat[stat]), stat);
				}
			}
		}
	} finally {
		random.mockRestore();
	}
});

test("interactive auto decisions preserve the exact native game result", async () => {
	const random = vi.spyOn(Math, "random");
	const resetRandom = () => {
		let seed = 123456789;
		random.mockImplementation(() => {
			seed = (1664525 * seed + 1013904223) >>> 0;
			return seed / 2 ** 32;
		});
	};
	try {
		resetRandom();
		const automatic = await initGameSim();
		automatic.playByPlay.active = true;
		const expected = automatic.run();
		resetRandom();
		const interactive = await initGameSim();
		interactive.playByPlay.active = true;
		const stages = new Set<string>();
		const actual = await interactive.runInteractive((snapshot) => {
			stages.add(snapshot.stage);
			return undefined;
		});
		assert.deepEqual(actual, expected);
		assert.deepEqual([...stages].sort(), ["clock", "play"]);
	} finally {
		random.mockRestore();
	}
});

test("interactive simulation waits for a decision before resolving a snap", async () => {
	const game = await initGameSim();
	game.playByPlay.active = true;
	let first = true;
	let resume: ((decision: FootballCoachDecision) => void) | undefined;
	const pending = game.runInteractive(() => {
		if (first) {
			first = false;
			return new Promise<FootballCoachDecision>((resolve) => {
				resume = resolve;
			});
		}
		return undefined;
	});
	assert.isDefined(resume);
	assert.equal(game.clock, g.get("quarterLength"));
	assert.equal(game.playByPlay.playByPlay.length, 0);
	resume!({ play: "kickoff" });
	const result = await pending;
	assert.equal(result.playByPlay?.at(-1)?.type, "gameOver");
});

test("interactive play continues through native overtime", async () => {
	const game = await initGameSim();
	game.clock = 0;
	game.numPeriods = 1;
	game.maxOvertimes = 1;
	game.shootoutRounds = 0;
	game.getOvertimeLength = () => 0.1;
	let overtimeSnapshots = 0;
	const result = await game.runInteractive((snapshot) => {
		assert.equal(snapshot.quarter, 2);
		overtimeSnapshots += 1;
		return undefined;
	});
	assert.isAbove(overtimeSnapshots, 0);
	assert.equal(result.overtimes, 1);
});

test("a conversion at zero seconds is played before game finalization", async () => {
	const game = await initGameSim();
	game.clock = 0;
	game.numPeriods = 1;
	game.maxOvertimes = 0;
	game.shootoutRounds = 0;
	game.awaitingKickoff = undefined;
	game.awaitingAfterTouchdown = true;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 6;
	game.team[0].stat.ptsQtrs = [6];
	let conversionPlayed = false;
	const result = await game.runInteractive((snapshot) => {
		assert.equal(snapshot.clock, 0);
		assert.isTrue(snapshot.awaitingAfterTouchdown);
		conversionPlayed = true;
		return { play: "extraPoint" };
	});
	assert.isTrue(conversionPlayed);
	assert.equal(result.team[0].stat.xpa, 1);
});

test("coach decisions respect kickoff, conversion, and timeout availability", async () => {
	const game = await initGameSim();
	assert.deepEqual(game.getAllowedCoachPlays(), ["kickoff", "onsideKick"]);
	assert.throws(() =>
		game.validateCoachDecision({ play: "pass" }, game.getCoachSnapshot("play")),
	);
	game.awaitingAfterSafety = true;
	assert.deepEqual(game.getAllowedCoachPlays(), ["kickoff"]);
	game.awaitingAfterSafety = false;
	game.awaitingKickoff = undefined;
	game.awaitingAfterTouchdown = true;
	assert.include(game.getAllowedCoachPlays(), "extraPoint");
	assert.notInclude(game.getAllowedCoachPlays(), "run");
	game.awaitingAfterTouchdown = false;
	assert.include(game.getAllowedCoachPlays(), "pass");
	game.isClockRunning = true;
	game.timeouts = [0, 1];
	assert.throws(() =>
		game.validateCoachDecision({ timeout: 0 }, game.getCoachSnapshot("clock")),
	);
	assert.doesNotThrow(() =>
		game.validateCoachDecision({ timeout: 1 }, game.getCoachSnapshot("clock")),
	);
	assert.throws(() =>
		game.validateCoachDecision({ play: "run" }, game.getCoachSnapshot("clock")),
	);
});

test("a manual timeout prevents runoff after a native rushing play", async () => {
	const game = await initGameSim();
	game.playByPlay.active = true;
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.clock = 5;
	game.scrimmage = 20;
	game.checkPenalties = () => false;
	game.probFumble = () => 0;
	const random = mockSeededRandom();
	let clockSnapshot: FootballCoachSnapshot | undefined;
	const stop = new Error("test stopped after one native snap");
	try {
		await expect(
			game.runInteractive((snapshot) => {
				if (snapshot.stage === "clock") {
					clockSnapshot = snapshot;
					assert.isAbove(game.team[0].stat.rus, 0);
					assert.isBelow(snapshot.clock, 5);
					return { timeout: 0 };
				}
				if (clockSnapshot) {
					assert.equal(snapshot.clock, clockSnapshot.clock);
					assert.equal(snapshot.timeouts[0], clockSnapshot.timeouts[0] - 1);
					assert.isFalse(snapshot.isClockRunning);
					throw stop;
				}
				return { play: snapshot.allowedPlays.includes("run") ? "run" : "auto" };
			}),
		).rejects.toThrow(stop.message);
		assert.isDefined(clockSnapshot);
		const timeout = game.playByPlay.playByPlay.find(
			(event) => event.type === "timeout",
		);
		assert.equal(
			timeout?.type === "timeout" && timeout.clock,
			clockSnapshot?.clock,
		);
	} finally {
		random.mockRestore();
	}
});

test("coach snapshots do not expose mutable engine objects", async () => {
	const game = await initGameSim();
	game.playByPlay.active = true;
	game.logTimeouts();
	const snapshot = game.getCoachSnapshot("play");
	snapshot.timeouts[0] = 99;
	snapshot.teams[0].pts = 99;
	snapshot.playersOnField[0][0]!.name = "changed";
	const timeoutEvent = snapshot.events.find(
		(event) => event.type === "timeouts",
	);
	if (timeoutEvent?.type === "timeouts") {
		timeoutEvent.timeouts[0] = 99;
	}
	const fresh = game.getCoachSnapshot("play");
	assert.notEqual(fresh.timeouts[0], 99);
	assert.notEqual(fresh.teams[0].pts, 99);
	assert.notEqual(fresh.playersOnField[0][0]!.name, "changed");
	assert.notDeepEqual(fresh.events, snapshot.events);
});

test("coach box scores keep cumulative native totals beyond the recent event window", async () => {
	const game = await initGameSim();
	game.playByPlay.active = true;
	game.baseInjuryRate = 0;
	const opening = game.getCoachSnapshot("play").boxScore!;
	for (const t of [0, 1] as const) {
		assert.lengthOf(opening.teams[t].players, game.team[t].player.length);
		assert.isTrue(opening.teams[t].players.every((p) => p.stat.pss === 0));
	}
	let cappedSnapshot: FootballCoachSnapshot | undefined;
	const random = mockSeededRandom();
	try {
		const result = await game.runInteractive((snapshot) => {
			if (snapshot.events.length === 80) {
				cappedSnapshot = snapshot;
			}
			return undefined;
		});
		assert.isDefined(cappedSnapshot);
		const final = game.getCoachSnapshot("play").boxScore!;
		assert.equal(final.season, g.get("season"));
		assert.deepEqual(final.scoringSummary, result.scoringSummary);
		for (const t of [0, 1] as const) {
			assert.deepEqual(final.teams[t].stat, result.team[t].stat);
			assert.isAbove(final.teams[t].stat.pss as number, 0);
			assert.isAbove(final.teams[t].stat.rus as number, 0);
			assert.isAtLeast(
				final.teams[t].stat.pss as number,
				cappedSnapshot!.boxScore!.teams[t].stat.pss as number,
			);
			assert.equal(opening.teams[t].stat.pss, 0);
			for (const nativePlayer of result.team[t].player) {
				const snapshotPlayer = final.teams[t].players.find(
					(p) => p.id === nativePlayer.id,
				)!;
				assert.deepEqual(snapshotPlayer.stat, nativePlayer.stat);
				assert.notProperty(snapshotPlayer, "compositeRating");
				assert.notProperty(snapshotPlayer, "ovrs");
			}
		}
	} finally {
		random.mockRestore();
	}
});

test("coach box scores feed native passing and receiving derived columns", async () => {
	const game = await initCoachScrimmage();
	const snapshot = await playOneCoachSnap(game, { callId: "slant" });
	const passing = snapshot.boxScore!.teams[0].players.find(
		(p) => p.id === snapshot.lastCall!.passerPid,
	)!;
	const receiving = snapshot.boxScore!.teams[0].players.find(
		(p) => p.id === snapshot.lastCall!.targetPid,
	)!;
	const passingStats = processStats(
		passing.stat as PlayerStatsToProcess,
		["cmpPct", "pssYdsPerAtt", "qbRat"],
		undefined,
		() => g.get("fantasyPoints"),
	);
	const receivingStats = processStats(
		receiving.stat as PlayerStatsToProcess,
		["recCatchPct", "recYdsPerRec"],
		undefined,
		() => g.get("fantasyPoints"),
	);
	assert.equal(passingStats.cmpPct, 100);
	assert.equal(passingStats.pssYdsPerAtt, passing.stat.pssYds);
	assert.isTrue(Number.isFinite(passingStats.qbRat));
	assert.equal(receivingStats.recCatchPct, 100);
	assert.equal(receivingStats.recYdsPerRec, receiving.stat.recYds);
});

test("coach box scores detach nested statistics, skills, injuries, and scoring summaries", async () => {
	const game = await initCoachScrimmage();
	game.playByPlay.logEvent({
		type: "fieldGoal",
		clock: 8,
		t: 0,
		names: ["Test kicker"],
		yds: 35,
		made: true,
	});
	const snapshot = game.getCoachSnapshot("play").boxScore!;
	snapshot.teams[0].stat.ptsQtrs[0] = 999;
	snapshot.teams[0].stat.pss = 999;
	snapshot.teams[0].players[0]!.stat.pss = 999;
	snapshot.teams[0].players[0]!.skills.push("changed");
	snapshot.teams[0].players[0]!.injury.type = "changed";
	const copiedScore = snapshot.scoringSummary[0]!;
	if (copiedScore.type !== "fieldGoal") {
		throw new Error("Expected the logged field goal");
	}
	copiedScore.names[0] = "changed";
	const fresh = game.getCoachSnapshot("play").boxScore!;
	assert.notEqual(fresh.teams[0].stat.ptsQtrs[0], 999);
	assert.equal(fresh.teams[0].stat.pss, 0);
	assert.equal(fresh.teams[0].players[0]!.stat.pss, 0);
	assert.notInclude(fresh.teams[0].players[0]!.skills, "changed");
	assert.notEqual(fresh.teams[0].players[0]!.injury.type, "changed");
	const freshScore = fresh.scoringSummary[0]!;
	if (freshScore.type !== "fieldGoal") {
		throw new Error("Expected the original field goal");
	}
	assert.equal(freshScore.names[0], "Test kicker");
	assert.notProperty(fresh.teams[0].players[0]!.stat, "energy");
	assert.notProperty(fresh.teams[0].players[0]!.stat, "benchTime");
	assert.notProperty(fresh.teams[0].players[0]!.stat, "courtTime");
	game.playByPlay.removeLastScore();
	assert.lengthOf(game.getCoachSnapshot("play").boxScore!.scoringSummary, 0);
});

test("coach box scores show newly injured players and respect hidden ratings", async () => {
	const game = await initCoachScrimmage();
	game.team[0].player[0]!.newInjury = true;
	game.team[0].player[0]!.injured = true;
	game.team[0].player[0]!.skills = ["Pa"];
	const previous = g.get("challengeNoRatings");
	try {
		g.setWithoutSavingToDB("challengeNoRatings", true);
		const injured =
			game.getCoachSnapshot("play").boxScore!.teams[0].players[0]!;
		assert.isTrue(injured.injured);
		assert.isTrue(injured.newInjury);
		assert.deepEqual(injured.injury, {
			type: "Injured",
			gamesRemaining: -1,
			playingThrough: false,
		});
		assert.deepEqual(injured.skills, []);
		assert.deepEqual(game.team[0].player[0]!.skills, ["Pa"]);
		assert.notEqual(game.team[0].player[0]!.injury.type, "Injured");
	} finally {
		g.setWithoutSavingToDB("challengeNoRatings", previous);
	}
});

test("manual tempo changes only the native between-play runoff", async () => {
	const runoffSeconds: number[] = [];
	for (const tempo of ["normal", "chewClock", "hurryUp"] as const) {
		const game = await initGameSim();
		game.awaitingKickoff = undefined;
		game.o = 0;
		game.d = 1;
		game.clock = 5;
		game.scrimmage = 20;
		game.checkPenalties = () => false;
		game.probFumble = () => 0;
		const random = mockSeededRandom();
		let clockBeforeRunoff: number | undefined;
		try {
			await expect(
				game.runInteractive((snapshot) => {
					if (snapshot.stage === "clock") {
						clockBeforeRunoff = snapshot.clock;
						return { tempo };
					}
					if (clockBeforeRunoff !== undefined) {
						runoffSeconds.push(
							(clockBeforeRunoff - snapshot.clock) * 60 * g.get("pace"),
						);
						assert.isAbove(game.team[0].stat.rus, 0);
						throw new Error("one snap complete");
					}
					return {
						play: snapshot.allowedPlays.includes("run") ? "run" : "auto",
					};
				}),
			).rejects.toThrow("one snap complete");
		} finally {
			random.mockRestore();
		}
	}
	assert.lengthOf(runoffSeconds, 3);
	assert.isAtLeast(runoffSeconds[0]!, 37 - 1e-10);
	assert.isAtMost(runoffSeconds[0]!, 62 + 1e-10);
	assert.closeTo(runoffSeconds[1]!, 40, 1e-10);
	assert.isAtLeast(runoffSeconds[2]!, 5 - 1e-10);
	assert.isAtMost(runoffSeconds[2]!, 13 + 1e-10);
});

const initKneelScenario = async () => {
	const game = await initGameSim();
	game.playByPlay.active = true;
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.clock = 1;
	game.numPeriods = 1;
	game.maxOvertimes = 0;
	game.shootoutRounds = 0;
	game.scrimmage = 50;
	game.twoMinuteWarningHappened = true;
	game.team[0].stat.pts = 7;
	game.team[0].stat.ptsQtrs = [7];
	return game;
};

test("defense can stop a manually called kneel after two seconds", async () => {
	const game = await initKneelScenario();
	let clockSeen = false;
	await expect(
		game.runInteractive((snapshot) => {
			if (snapshot.stage === "clock") {
				clockSeen = true;
				assert.closeTo(snapshot.clock * 60, 58, 1e-10);
				assert.isTrue(snapshot.canTimeout[1]);
				return { timeout: 1 };
			}
			if (clockSeen) {
				assert.closeTo(snapshot.clock * 60, 58, 1e-10);
				assert.equal(snapshot.down, 2);
				assert.equal(snapshot.timeouts[1], 2);
				assert.equal(game.team[0].stat.rus, 1);
				throw new Error("kneel stopped by defense");
			}
			return { play: "kneel" };
		}),
	).rejects.toThrow("kneel stopped by defense");
	assert.isTrue(clockSeen);
});

test("manual kneel with no timeout uses a separate forty-second runoff", async () => {
	const game = await initKneelScenario();
	let clockSeen = false;
	await expect(
		game.runInteractive((snapshot) => {
			if (snapshot.stage === "clock") {
				clockSeen = true;
				return {};
			}
			if (clockSeen) {
				assert.closeTo(snapshot.clock * 60, 18, 1e-10);
				assert.deepEqual(snapshot.timeouts, [3, 3]);
				throw new Error("kneel runoff complete");
			}
			return { play: "kneel" };
		}),
	).rejects.toThrow("kneel runoff complete");
	assert.isTrue(clockSeen);
});

test("fourth-down manual kneel changes possession without clock runoff", async () => {
	const game = await initKneelScenario();
	game.down = 4;
	let plays = 0;
	await expect(
		game.runInteractive((snapshot) => {
			assert.equal(snapshot.stage, "play");
			plays += 1;
			if (plays === 2) {
				assert.equal(snapshot.offense, 1);
				assert.equal(snapshot.down, 1);
				assert.isFalse(snapshot.isClockRunning);
				assert.closeTo(snapshot.clock * 60, 58, 1e-10);
				throw new Error("possession changed");
			}
			return { play: "kneel" };
		}),
	).rejects.toThrow("possession changed");
});

test("automatic kneels retain exact synchronous and interactive parity", async () => {
	const automatic = await initKneelScenario();
	automatic.getPlayType = () => "kneel";
	let random = mockSeededRandom();
	let expected: ReturnType<GameSim["run"]>;
	try {
		expected = automatic.run();
	} finally {
		random.mockRestore();
	}
	const interactive = await initKneelScenario();
	interactive.getPlayType = () => "kneel";
	random = mockSeededRandom();
	try {
		const actual = await interactive.runInteractive((snapshot) => {
			assert.equal(snapshot.stage, "play");
			return undefined;
		});
		assert.deepEqual(actual, expected);
	} finally {
		random.mockRestore();
	}
});

test("kick a field goal when down 2 at the end of the game and there is little time left", async () => {
	const game = await initGameSim();

	// Down by 2, 4th quarter, ball on the opp 20 yard line, 6 seconds left
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 0;
	game.team[0].stat.ptsQtrs = [0, 0, 0, game.team[0].stat.pts];
	game.team[1].stat.pts = 2;
	game.team[1].stat.ptsQtrs = [0, 0, 0, game.team[1].stat.pts];
	game.scrimmage = 80;
	game.clock = 0.01;
	game.currentPlay = new Play(game);

	assert.strictEqual(game.getPlayType(), "fieldGoalLate");
});

test("kick a field goal on 4th down to take the lead late in the game", async () => {
	const game = await initGameSim();
	game.probMadeFieldGoal = () => 0.75;

	const situationsToAlwaysKick = [
		{
			ptsDown: 2,
			clock: 2,
		},
		{
			ptsDown: 1,
			clock: 2,
		},
		{
			ptsDown: 0,
			clock: 2,
		},
		{
			ptsDown: -4,
			clock: 2,
		},
		{
			ptsDown: -5,
			clock: 2,
		},
		{
			ptsDown: -6,
			clock: 2,
		},
		{
			ptsDown: -7,
			clock: 2,
		},
		{
			ptsDown: -8,
			clock: 2,
		},
	];

	// 4th quarter, 4th down, ball on the opp 20 yard line
	for (const { ptsDown, clock } of situationsToAlwaysKick) {
		game.awaitingKickoff = undefined;
		game.o = 0;
		game.d = 1;
		game.team[0].stat.pts = 10;
		game.team[0].stat.ptsQtrs = [0, 0, 0, game.team[0].stat.pts];
		game.team[1].stat.pts = game.team[0].stat.pts + ptsDown;
		game.team[1].stat.ptsQtrs = [0, 0, 0, game.team[1].stat.pts];
		game.scrimmage = 80;
		game.clock = clock;
		game.down = 4;
		game.currentPlay = new Play(game);

		assert.strictEqual(game.getPlayType(), "fieldGoal");
	}
});

test("kick a field goal at the end of the 2nd quarter rather than running out the clock", async () => {
	const game = await initGameSim();

	// Arbitrary score, 2nd quarter, ball on the opp 20 yard line, 6 seconds left
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = Math.round(Math.random() * 100);
	game.team[0].stat.ptsQtrs = [0, game.team[0].stat.pts];
	game.team[1].stat.pts = Math.round(Math.random() * 100);
	game.team[1].stat.ptsQtrs = [0, game.team[1].stat.pts];
	game.scrimmage = 80;
	game.clock = 0.01;
	game.currentPlay = new Play(game);

	assert.strictEqual(game.getPlayType(), "fieldGoalLate");
});

test("kick a field goal at the end of overtime in a tie game rather than running out the clock", async () => {
	const game = await initGameSim();

	// Arbitrary score, 2nd quarter, ball on the opp 20 yard line, 6 seconds left
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 21;
	game.team[0].stat.ptsQtrs = [0, 0, 0, game.team[0].stat.pts, 0];
	game.team[1].stat.pts = game.team[0].stat.pts;
	game.team[1].stat.ptsQtrs = [0, 0, 0, game.team[1].stat.pts, 0];
	game.scrimmage = 80;
	game.clock = 3 / 60;
	game.overtimes = 1;
	game.overtimeState = "bothTeamsPossessed";
	game.currentPlay = new Play(game);

	assert.strictEqual(game.getPlayType(), "fieldGoalLate");
});

test("kick a field goal in overtime if it will win the game and is very likely to go in", async () => {
	const game = await initGameSim();

	// Arbitrary score, 2nd quarter, ball on the opp 20 yard line, 6 seconds left
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 21;
	game.team[0].stat.ptsQtrs = [0, 0, 0, game.team[0].stat.pts, 0];
	game.team[1].stat.pts = game.team[0].stat.pts;
	game.team[1].stat.ptsQtrs = [0, 0, 0, game.team[1].stat.pts, 0];
	game.scrimmage = 90;
	game.clock = 10;
	game.overtimes = 1;
	game.overtimeState = "firstPossession";
	game.probMadeFieldGoal = () => 0.99;
	game.currentPlay = new Play(game);

	assert(game.getPlayType() !== "fieldGoal");

	game.overtimeState = "bothTeamsPossessed";

	assert.strictEqual(game.getPlayType(), "fieldGoal");
});

test("don't punt when down late, and usually pass", async () => {
	// Down by 7, 4th quarter, ball on own 20 yard line, 4th down, 1:30 left
	const game = await initGameSim();
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 0;
	game.team[0].stat.ptsQtrs = [0, 0, 0, game.team[0].stat.pts];
	game.team[1].stat.pts = 7;
	game.team[1].stat.ptsQtrs = [0, 0, 0, game.team[1].stat.pts];
	game.down = 4;
	game.scrimmage = 20;
	game.clock = 1.5;
	game.currentPlay = new Play(game);

	let numRun = 0;
	for (let i = 0; i < 100; i++) {
		const playType = game.getPlayType();
		assert(playType === "run" || playType === "pass");
		if (playType === "run") {
			numRun += 1;
		}
	}

	// Should really be 2% chance
	assert(numRun <= 10);
});

test("sack on 4th down gets recorded on correct team", async () => {
	const game = await initGameSim();

	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.scrimmage = 20;
	game.down = 4;
	game.currentPlay = new Play(game);

	// Sacks always happen, no penalties
	game.probSack = () => 1;
	game.probFumble = () => 0;
	game.checkPenalties = () => false;

	game.doPass();
	game.currentPlay.commit(false);

	assert.strictEqual(game.team[0].stat.defSk, 0);
	assert.strictEqual(game.team[1].stat.defSk, 1);

	// Possession changed
	assert.strictEqual(game.o, 1);
	assert.strictEqual(game.d, 0);
});

test("interception on 4th down works", async () => {
	const game = await initGameSim();

	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.scrimmage = 20;
	game.toGo = 1;
	game.down = 4;
	game.currentPlay = new Play(game);

	// Always interception
	game.probSack = () => 0;
	game.probFumble = () => 0;
	game.probInt = () => 1;
	game.probScramble = () => 0;
	game.checkPenalties = () => false;

	game.doPass();
	game.currentPlay.commit(false);

	assert.strictEqual(game.team[0].stat.defInt, 0);
	assert.strictEqual(game.team[1].stat.defInt, 1);

	// Possession changed
	assert.strictEqual(game.o, 1);
	assert.strictEqual(game.d, 0);
});

test("OT ends after failed 4th down conversion if 1st team kicked a FG", async () => {
	// Down by 3, overtime, ball on own 20 yard line, 4th down, 1:30 left
	const game = await initGameSim();
	game.awaitingKickoff = undefined;
	game.o = 0;
	game.d = 1;
	game.team[0].stat.pts = 0;
	game.team[0].stat.ptsQtrs = [0, 0, 0, 0, game.team[0].stat.pts];
	game.team[1].stat.pts = 3;
	game.team[1].stat.ptsQtrs = [0, 0, 0, 0, game.team[1].stat.pts];
	game.down = 4;
	game.scrimmage = 20;
	game.clock = 1.5;
	game.overtimeState = "secondPossession";

	// Sacks always happen, no penalties
	game.getPlayType = () => "pass";
	game.probSack = () => 1;
	game.probFumble = () => 0;
	game.checkPenalties = () => false;

	game.simPlay();

	assert.strictEqual(game.overtimeState, "over");

	// Possession changed
	assert.strictEqual(game.o, 1);
	assert.strictEqual(game.d, 0);
});

test("fumble recovered by offense should only cost one down", async () => {
	const game = await initGameSim();

	// No penalties, run the ball
	game.checkPenalties = () => false;
	game.getPlayType = () => "run";

	// Keep doing it until offense recovers
	while (true) {
		game.awaitingKickoff = undefined;
		game.awaitingAfterTouchdown = false;
		game.o = 0;
		game.d = 1;
		game.down = 1;
		game.toGo = 10;
		game.scrimmage = 20;
		game.clock = 20;

		// Just one fumble, not double fumble
		let fumbled = false;
		game.probFumble = () => {
			if (fumbled) {
				return 0;
			}

			fumbled = true;
			return 1;
		};

		game.simPlay();

		// Looking for the offense to recover, and not for a first down
		if (game.o === 0 && game.scrimmage < 30 && !game.awaitingAfterTouchdown) {
			break;
		}
	}

	assert.strictEqual(game.down, 2);

	// No possession change
	assert.strictEqual(game.o, 0);
	assert.strictEqual(game.d, 1);
});
