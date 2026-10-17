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
