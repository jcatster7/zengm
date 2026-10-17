import { assert, expect, test } from "vitest";
import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { FootballCoachController } from "./footballCoach.ts";

const makeInput = (): Pick<FootballCoachSession, "lid" | "gid" | "teams"> => ({
	lid: 7,
	gid: 42,
	teams: [
		{
			tid: 4,
			abbrev: "HOM",
			region: "Home",
			name: "Team",
			colors: ["#123456"],
		},
		{
			tid: 9,
			abbrev: "AWY",
			region: "Away",
			name: "Team",
			colors: ["#654321"],
		},
	],
});

const makeSnapshot = (
	overrides: Partial<FootballCoachSnapshot> = {},
): FootballCoachSnapshot => ({
	gid: 42,
	stage: "play",
	quarter: 4,
	numPeriods: 4,
	clock: 1.5,
	down: 2,
	toGo: 5,
	scrimmage: 70,
	offense: 0,
	defense: 1,
	teams: [
		{ id: 4, pts: 20 },
		{ id: 9, pts: 24 },
	],
	timeouts: [2, 0],
	canTimeout: [true, false],
	awaitingKickoff: undefined,
	awaitingAfterTouchdown: false,
	isClockRunning: true,
	allowedPlays: ["run", "pass", "fieldGoal"],
	events: [],
	playersOnField: [[{ id: 11, name: "Test Quarterback", pos: "QB" }], []],
	...overrides,
});

const start = () => {
	const controller = new FootballCoachController();
	const session = controller.start(makeInput());
	return { controller, session };
};

const submit = (
	controller: FootballCoachController,
	decision: FootballCoachDecision = { play: "run" },
) => {
	const session = controller.get(7)!;
	return controller.submit(7, {
		sessionId: session.sessionId,
		revision: session.revision,
		decision,
	});
};

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

test("coaching lifecycle pauses at each decision and advances revisions once", async () => {
	const { controller } = start();
	assert.strictEqual(controller.isActive(), true);
	assert.strictEqual(controller.get(7)?.status, "starting");
	assert.strictEqual(controller.get(7)?.revision, 0);
	assert.throws(() => controller.start(makeInput()), /Finish the current/);
	const first = controller.next(7, makeSnapshot());
	assert.strictEqual(controller.get(7)?.status, "waiting");
	assert.strictEqual(controller.get(7)?.revision, 1);
	assert.strictEqual(submit(controller)?.status, "running");
	assert.deepEqual(await first, { play: "run" });
	const second = controller.next(
		7,
		makeSnapshot({ stage: "clock", allowedPlays: [] }),
	);
	assert.strictEqual(controller.get(7)?.revision, 2);
	submit(controller, { tempo: "hurryUp", timeout: 0 });
	assert.deepEqual(await second, { tempo: "hurryUp", timeout: 0 });
	controller.saving(7);
	assert.strictEqual(controller.get(7)?.status, "saving");
	assert.strictEqual(controller.isActive(), true);
	controller.complete(7, "/l/7/game_log/42");
	assert.strictEqual(controller.get(7)?.status, "complete");
	assert.strictEqual(controller.get(7)?.boxScoreUrl, "/l/7/game_log/42");
	assert.strictEqual(controller.isActive(), false);
	await expect(controller.next(7, makeSnapshot())).rejects.toThrow(
		/no longer matches/,
	);
	assert.strictEqual(controller.start(makeInput()).revision, 0);
});

test("double submissions and stale revisions cannot resolve the next pending decision", async () => {
	const { controller, session } = start();
	const first = controller.next(7, makeSnapshot());
	const originalCommand = {
		sessionId: session.sessionId,
		revision: 1,
		decision: { play: "pass" } as const,
	};
	controller.submit(7, originalCommand);
	assert.throws(
		() => controller.submit(7, originalCommand),
		/already advanced/,
	);
	assert.deepEqual(await first, { play: "pass" });
	const second = controller.next(7, makeSnapshot());
	let resolved = false;
	void second.then(() => {
		resolved = true;
	});
	assert.throws(
		() => controller.submit(7, originalCommand),
		/already advanced/,
	);
	await flushMicrotasks();
	assert.strictEqual(resolved, false);
	assert.strictEqual(controller.get(7)?.status, "waiting");
	submit(controller, { play: "fieldGoal" });
	assert.deepEqual(await second, { play: "fieldGoal" });
});

test("wrong league, session, game, and overlapping next calls preserve the live decision", async () => {
	const { controller, session } = start();
	const pending = controller.next(7, makeSnapshot());
	const command = {
		sessionId: session.sessionId,
		revision: 1,
		decision: { play: "run" } as const,
	};
	assert.strictEqual(controller.get(8), null);
	assert.throws(
		() => controller.submit(8, command),
		/different game or league/,
	);
	assert.throws(
		() => controller.submit(7, { ...command, sessionId: "other-session" }),
		/different game or league/,
	);
	assert.throws(
		() => controller.automate(8, session.sessionId, "end"),
		/different game or league/,
	);
	assert.throws(
		() => controller.automate(7, "other-session", "end"),
		/different game or league/,
	);
	await expect(controller.next(8, makeSnapshot())).rejects.toThrow(
		/no longer matches/,
	);
	await expect(controller.next(7, makeSnapshot({ gid: 43 }))).rejects.toThrow(
		/no longer matches/,
	);
	await expect(controller.next(7, makeSnapshot())).rejects.toThrow(
		/already pending/,
	);
	controller.saving(8);
	controller.complete(8, "/wrong");
	controller.fail(8, new Error("wrong league"));
	assert.strictEqual(controller.get(7)?.status, "waiting");
	submit(controller);
	assert.deepEqual(await pending, { play: "run" });
});

test.each([
	null,
	[],
	{ play: "kickoff" },
	{ play: "invented" },
	{ timeout: 1 },
	{ timeout: 2 },
	{ timeout: "0" },
	{ timeout: 0 },
	{ tempo: "hurryUp" },
	{ tempo: "instant" },
	{ score: 99 },
	{ play: "run", roster: [] },
])("invalid decision %j does not consume a pending snap", async (invalid) => {
	const { controller } = start();
	const pending = controller.next(7, makeSnapshot());
	let resolved = false;
	void pending.then(() => {
		resolved = true;
	});
	assert.throws(() => submit(controller, invalid as FootballCoachDecision));
	await flushMicrotasks();
	assert.strictEqual(resolved, false);
	assert.strictEqual(controller.get(7)?.revision, 1);
	assert.strictEqual(controller.get(7)?.status, "waiting");
	submit(controller, { play: "auto" });
	assert.deepEqual(await pending, { play: "auto" });
});

test("a play command at the clock stage is rejected without losing the clock decision", async () => {
	const { controller } = start();
	const pending = controller.next(
		7,
		makeSnapshot({ stage: "clock", allowedPlays: [] }),
	);
	assert.throws(() => submit(controller, { play: "auto" }), /unavailable/);
	submit(controller, { tempo: "chewClock" });
	assert.deepEqual(await pending, { tempo: "chewClock" });
});

test("invalid automation mode does not resolve a pending snap", async () => {
	const { controller, session } = start();
	const pending = controller.next(7, makeSnapshot());
	try {
		assert.throws(() =>
			controller.automate(7, session.sessionId, "invalid" as "end"),
		);
		assert.strictEqual(controller.get(7)?.status, "waiting");
	} finally {
		controller.automate(7, session.sessionId, "end");
		await pending;
	}
});

test("session inputs, snapshots, responses, and submitted decisions are detached clones", async () => {
	const input = makeInput();
	const controller = new FootballCoachController();
	const returned = controller.start(input);
	input.teams[0].colors[0] = "#ffffff";
	returned.teams[0].name = "changed";
	assert.deepEqual(controller.get(7)?.teams, makeInput().teams);
	const snapshot = makeSnapshot();
	const pending = controller.next(7, snapshot);
	snapshot.allowedPlays.length = 0;
	snapshot.teams[0].pts = 999;
	snapshot.playersOnField[0][0]!.name = "changed";
	const visible = controller.get(7)!;
	assert.strictEqual(visible.snapshot?.teams[0].pts, 20);
	assert.strictEqual(
		visible.snapshot?.playersOnField[0][0]?.name,
		"Test Quarterback",
	);
	visible.snapshot!.canTimeout[0] = false;
	visible.snapshot!.allowedPlays.length = 0;
	const decision: FootballCoachDecision = {
		play: "pass",
	};
	const response = submit(controller, decision)!;
	decision.play = "punt";
	response.teams[1].colors[0] = "#000000";
	assert.deepEqual(await pending, { play: "pass" });
	assert.deepEqual(controller.get(7)?.teams, makeInput().teams);
});

test("skip to two minutes releases the current decision and skips earlier regulation", async () => {
	const { controller, session } = start();
	const pending = controller.next(7, makeSnapshot({ quarter: 1, clock: 12 }));
	controller.automate(7, session.sessionId, "twoMinute");
	assert.strictEqual(await pending, undefined);
	for (const snapshot of [
		makeSnapshot({ quarter: 2, clock: 1 }),
		makeSnapshot({ quarter: 3, clock: 0.1 }),
		makeSnapshot({ quarter: 4, clock: 2.01 }),
	]) {
		assert.strictEqual(await controller.next(7, snapshot), undefined);
		assert.strictEqual(controller.get(7)?.revision, 1);
	}
	const boundary = controller.next(7, makeSnapshot({ quarter: 4, clock: 2 }));
	assert.strictEqual(controller.get(7)?.status, "waiting");
	assert.strictEqual(controller.get(7)?.revision, 2);
	submit(controller);
	assert.deepEqual(await boundary, { play: "run" });
	const next = controller.next(7, makeSnapshot({ quarter: 4, clock: 1.9 }));
	assert.strictEqual(controller.get(7)?.status, "waiting");
	submit(controller);
	await next;
});

test.each([
	{ quarter: 4, numPeriods: 4, clock: 1.9 },
	{ quarter: 5, numPeriods: 4, clock: 10 },
	{ quarter: 6, numPeriods: 4, clock: 10 },
	{ quarter: 2, numPeriods: 2, clock: 2 },
])(
	"skip resumes coaching in late regulation or overtime: %j",
	async (situation) => {
		const { controller, session } = start();
		controller.automate(7, session.sessionId, "twoMinute");
		const pending = controller.next(7, makeSnapshot(situation));
		assert.strictEqual(controller.get(7)?.status, "waiting");
		submit(controller);
		assert.deepEqual(await pending, { play: "run" });
	},
);

test("automatic finish is idempotent and never asks for another snap", async () => {
	const { controller, session } = start();
	const pending = controller.next(7, makeSnapshot());
	controller.automate(7, session.sessionId, "end");
	controller.automate(7, session.sessionId, "end");
	assert.strictEqual(await pending, undefined);
	for (const quarter of [4, 5, 6]) {
		assert.strictEqual(
			await controller.next(7, makeSnapshot({ quarter })),
			undefined,
		);
	}
	assert.strictEqual(controller.get(7)?.revision, 1);
	controller.complete(7, "/box-score");
	controller.automate(7, session.sessionId, "end");
	controller.complete(7, "/box-score");
	assert.strictEqual(controller.get(7)?.status, "complete");
	assert.strictEqual(controller.get(7)?.boxScoreUrl, "/box-score");
});

test("failure releases a pending simulator and makes its old commands unusable", async () => {
	const { controller, session } = start();
	const pending = controller.next(7, makeSnapshot());
	controller.fail(7, new Error("Native simulation failed"));
	assert.strictEqual(await pending, undefined);
	assert.strictEqual(controller.get(7)?.status, "error");
	assert.strictEqual(controller.get(7)?.error, "Native simulation failed");
	assert.strictEqual(controller.isActive(), false);
	assert.throws(
		() =>
			controller.submit(7, {
				sessionId: session.sessionId,
				revision: 1,
				decision: { play: "run" },
			}),
		/already advanced/,
	);
	const replacement = controller.start(makeInput());
	assert.notStrictEqual(replacement.sessionId, session.sessionId);
	assert.throws(
		() => controller.automate(7, session.sessionId, "end"),
		/different game or league/,
	);
});

test("closing a league releases pending coaching but waits for all tracked persistence", async () => {
	const { controller } = start();
	const pending = controller.next(7, makeSnapshot());
	const persistence = deferred();
	controller.track(persistence.promise);
	let closed = false;
	const closing = controller.finishBeforeClosingLeague().then(() => {
		closed = true;
	});
	assert.strictEqual(await pending, undefined);
	controller.saving(7);
	controller.complete(7, "/box-score");
	await flushMicrotasks();
	assert.strictEqual(
		closed,
		false,
		"A completed display is not proof that the tracked write promise finished",
	);
	persistence.resolve();
	await closing;
	assert.strictEqual(closed, true);
});

test("closing an already-complete session still waits for its tracked persistence", async () => {
	const { controller } = start();
	const persistence = deferred();
	controller.track(persistence.promise);
	controller.complete(7, "/box-score");
	let closed = false;
	const closing = controller.finishBeforeClosingLeague().then(() => {
		closed = true;
	});
	try {
		await flushMicrotasks();
		assert.strictEqual(
			closed,
			false,
			"Do not close the database while tracked persistence remains pending",
		);
	} finally {
		persistence.resolve();
		await closing;
	}
});

test("closing propagates a tracked persistence failure", async () => {
	const { controller } = start();
	const persistence = deferred();
	controller.track(persistence.promise);
	const closing = expect(
		controller.finishBeforeClosingLeague(),
	).rejects.toThrow(/disk write failed/);
	persistence.reject(new Error("disk write failed"));
	await closing;
});

test("closing a failed session reports failure after waiting for tracked cleanup", async () => {
	const { controller } = start();
	const persistence = deferred();
	controller.track(persistence.promise);
	controller.saving(7);
	controller.fail(7, new Error("could not persist the result"));
	const closing = expect(
		controller.finishBeforeClosingLeague(),
	).rejects.toThrow(/could not persist the result/);
	persistence.resolve();
	await closing;
});

test("a failure after native writes begin blocks every retry in that league", () => {
	const { controller } = start();
	controller.saving(7);
	controller.fail(7, new Error("disk write failed"));
	assert.strictEqual(controller.get(7)?.requiresRecovery, true);
	assert.match(controller.get(7)!.error!, /export/i);
	assert.throws(() => controller.assertCanSimulate(7), /export/i);
	assert.throws(() => controller.start(makeInput()), /export/i);
	assert.throws(() => controller.start({ ...makeInput(), gid: 43 }), /export/i);
	assert.doesNotThrow(() => controller.assertCanSimulate(8));
	const detached = controller.get(7)!;
	detached.requiresRecovery = false;
	assert.throws(() => controller.assertCanSimulate(7), /export/i);
});

test("a pre-save failure can close and retry after its cleanup finishes", async () => {
	const { controller, session } = start();
	const cleanup = deferred();
	controller.track(cleanup.promise);
	controller.fail(7, new Error("roster requirements not met"));
	assert.notStrictEqual(controller.get(7)?.requiresRecovery, true);
	assert.doesNotThrow(() => controller.assertCanSimulate(7));
	let closed = false;
	const closing = controller.finishBeforeClosingLeague().then(() => {
		closed = true;
	});
	try {
		await flushMicrotasks();
		assert.strictEqual(closed, false);
	} finally {
		cleanup.resolve();
		await closing;
	}
	assert.notStrictEqual(
		controller.start(makeInput()).sessionId,
		session.sessionId,
	);
});

test("a new session resets the save marker from a previously completed game", async () => {
	const { controller } = start();
	controller.saving(7);
	controller.complete(7, "/box-score");
	controller.start({ ...makeInput(), gid: 43 });
	controller.fail(7, new Error("failed before simulation"));
	assert.notStrictEqual(controller.get(7)?.requiresRecovery, true);
	assert.doesNotThrow(() => controller.assertCanSimulate(7));
	await controller.finishBeforeClosingLeague();
});

test("closing with no coaching session is a no-op", async () => {
	await new FootballCoachController().finishBeforeClosingLeague();
});

test("final native snapshots are detached and rejected for another game or league", () => {
	const { controller } = start();
	const snapshot = makeSnapshot({ clock: 0 });
	controller.saving(7);
	controller.updateFinalSnapshot(7, snapshot);
	assert.strictEqual(controller.get(7)?.status, "saving");
	assert.strictEqual(controller.get(7)?.revision, 1);
	snapshot.teams[0].pts = 999;
	assert.strictEqual(controller.get(7)?.snapshot?.teams[0].pts, 20);
	const returned = controller.get(7)!;
	returned.snapshot!.playersOnField[0][0]!.name = "Changed";
	assert.strictEqual(
		controller.get(7)?.snapshot?.playersOnField[0][0]?.name,
		"Test Quarterback",
	);
	assert.throws(
		() => controller.updateFinalSnapshot(8, makeSnapshot()),
		/does not match/,
	);
	assert.throws(
		() => controller.updateFinalSnapshot(7, makeSnapshot({ gid: 43 })),
		/does not match/,
	);
	assert.strictEqual(controller.get(7)?.revision, 1);
	controller.complete(7, "/box-score");
	assert.throws(
		() => controller.updateFinalSnapshot(7, makeSnapshot()),
		/does not match/,
	);
});

test("a coached native game saves one box score and normal league stats before closing", async () => {
	const { resetCache, resetG, mockIDBLeague } =
		await import("../../../test/helpers.ts");
	const { DEFAULT_LEVEL } = await import("../../../common/budgetLevels.ts");
	const { PHASE } = await import("../../../common/constants.ts");
	const { player, team } = await import("../index.ts");
	const { idb } = await import("../../db/index.ts");
	const { g, helpers, local, lock } = await import("../../util/index.ts");
	const { footballCoach } = await import("./footballCoach.ts");
	const { default: play } = await import("./play.ts");
	const { default: closeLeague } = await import("../league/close.ts");
	const originalLeague = idb.league;
	const originalCache = idb.cache;
	const flushEntered = deferred();
	const releaseFlush = deferred();
	let completion: Promise<void> | undefined;
	try {
		resetG();
		local.reset();
		lock.reset();
		g.setWithoutSavingToDB("lid", 7);
		g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
		g.setWithoutSavingToDB("injuryRate", 0);
		g.setWithoutSavingToDB("numGamesPlayoffSeries", [1]);
		g.setWithoutSavingToDB("numPlayoffByes", 0);
		g.setWithoutSavingToDB("playoffsByConf", false);
		g.setWithoutSavingToDB("numTeams", 4);
		g.setWithoutSavingToDB("numActiveTeams", 4);
		const teams = helpers.getTeamsDefault().slice(0, 4).map(team.generate);
		await resetCache({
			players: teams.flatMap((t) =>
				Array.from({ length: 50 }, () =>
					player.generate(t.tid, 25, 2010, true, DEFAULT_LEVEL),
				),
			),
			teams,
			teamSeasons: teams.map((t) => team.genSeasonRow(t)),
			teamStats: teams.map((t) => team.genStatsRow(t.tid)),
		});
		idb.league = mockIDBLeague();
		// A second matchup keeps the native end-of-day and season-transition work
		// out of this test, while all game/player/team writes remain real code.
		await idb.cache.schedule.add({ gid: 42, day: 1, homeTid: 0, awayTid: 1 });
		await idb.cache.schedule.add({ gid: 43, day: 1, homeTid: 2, awayTid: 3 });
		let flushes = 0;
		idb.cache.flush = async () => {
			flushes += 1;
			flushEntered.resolve();
			await releaseFlush.promise;
		};
		const session = footballCoach.start({
			lid: 7,
			gid: 42,
			teams: [teams[0]!, teams[1]!],
		});
		footballCoach.automate(7, session.sessionId, "end");
		let decisions = 0;
		completion = play(1, {}, true, 42, true, (snapshot) => {
			decisions += 1;
			return footballCoach.next(7, snapshot);
		}).then(() => footballCoach.complete(7, "/l/7/game_log/HOM_0/2016/42"));
		footballCoach.track(completion);
		await Promise.race([
			flushEntered.promise,
			completion.then(() => {
				throw new Error(
					"Native save finished without reaching its flush boundary",
				);
			}),
		]);
		assert.isAbove(
			decisions,
			0,
			"The native simulator must actually use the coaching continuation",
		);
		const games = await idb.cache.games.getAll();
		assert.strictEqual(games.length, 1);
		assert.strictEqual(games[0]?.gid, 42);
		assert.deepEqual(
			(await idb.cache.schedule.getAll()).map((game) => game.gid),
			[43],
		);
		const teamStats = await idb.cache.teamStats.getAll();
		assert.deepEqual(
			teamStats.filter((row) => row.tid < 2).map((row) => row.gp),
			[1, 1],
		);
		assert.deepEqual(
			teamStats.filter((row) => row.tid >= 2).map((row) => row.gp),
			[0, 0],
		);
		const teamSeasons = await idb.cache.teamSeasons.getAll();
		assert.deepEqual(
			teamSeasons
				.filter((row) => row.tid < 2)
				.map((row) => row.won + row.lost + (row.tied ?? 0) + (row.otl ?? 0)),
			[1, 1],
		);
		const players = await idb.cache.players.getAll();
		const played = players.filter((p) =>
			p.stats.some((row) => row.season === g.get("season") && row.gp === 1),
		);
		assert.isAbove(played.length, 0);
		assert.isTrue(played.every((p) => p.tid === 0 || p.tid === 1));
		const finalSnapshot = footballCoach.get(7)!.snapshot!;
		assert.deepEqual(
			finalSnapshot.teams.map((t) => t.pts),
			games[0]!.teams.map((t) => t.pts),
		);
		let closed = false;
		const closing = closeLeague().then(() => {
			closed = true;
		});
		await flushMicrotasks();
		assert.strictEqual(
			closed,
			false,
			"The league must remain open until native persistence completes",
		);
		releaseFlush.resolve();
		await completion;
		await closing;
		assert.strictEqual(flushes, 1);
		footballCoach.automate(7, session.sessionId, "end");
		await footballCoach.finishBeforeClosingLeague();
		assert.strictEqual((await idb.cache.games.getAll()).length, 1);
		assert.deepEqual(
			(await idb.cache.teamStats.getAll())
				.filter((row) => row.tid < 2)
				.map((row) => row.gp),
			[1, 1],
		);
		assert.strictEqual(
			flushes,
			1,
			"Repeated finish requests must not run or save the game again",
		);
	} finally {
		releaseFlush.resolve();
		if (completion) {
			await completion.catch(() => {});
		}
		idb.league = originalLeague;
		idb.cache = originalCache;
		local.reset();
		lock.reset();
		resetG();
	}
});

test("native quick and recursive simulation entrypoints honor recovery protection", async () => {
	const { footballCoach } = await import("./footballCoach.ts");
	const { default: play } = await import("./play.ts");
	const { g, lock } = await import("../../util/index.ts");
	const originalLid = g.get("lid");
	try {
		g.setWithoutSavingToDB("lid", 7);
		lock.reset();
		footballCoach.start(makeInput());
		footballCoach.saving(7);
		footballCoach.fail(7, new Error("partially saved native result"));
		assert.throws(() => lock.canStartGames(), /export/i);
		assert.strictEqual(lock.get("gameSim"), false);
		await expect(play(1, {}, true, 42)).rejects.toThrow(/export/i);
		await expect(play(1, {}, false, 42)).rejects.toThrow(/export/i);
		assert.strictEqual(lock.get("gameSim"), false);
	} finally {
		// A different test league resets the singleton without granting a retry in
		// the damaged league. Production league.close rejects that unsafe switch.
		footballCoach.start({ ...makeInput(), lid: 8 });
		footballCoach.complete(8, "/test-cleanup");
		g.setWithoutSavingToDB("lid", originalLid);
		lock.reset();
	}
});
