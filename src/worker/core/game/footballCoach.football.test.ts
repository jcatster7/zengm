import { assert, expect, test, vi } from "vitest";
import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import type { Game } from "../../../common/types.ts";
import { FootballCoachController } from "./footballCoach.ts";

const makeInput = (): Pick<
	FootballCoachSession,
	"lid" | "gid" | "teams" | "controlledTeam"
> => ({
	lid: 7,
	gid: 42,
	controlledTeam: 0,
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

test.each([0, 1] as const)(
	"team %i owns only its offense, defense, and timeouts across possessions",
	async (controlledTeam) => {
		const opponent = controlledTeam === 0 ? 1 : 0;
		const controller = new FootballCoachController();
		const session = controller.start({ ...makeInput(), controlledTeam });
		assert.strictEqual(
			session.controlledTid,
			makeInput().teams[controlledTeam].tid,
		);
		const defense = controller.next(
			7,
			makeSnapshot({
				offense: opponent,
				defense: controlledTeam,
				allowedDefenseIds: ["blitz"],
				controlledTeam: opponent,
			}),
		);
		assert.strictEqual(
			controller.get(7)?.snapshot?.controlledTeam,
			controlledTeam,
			"The controller must overwrite any snapshot ownership mismatch",
		);
		for (const decision of [
			{ play: "pass" },
			{ callId: "go" },
			{ targetPid: 11 },
			{ runnerPid: 11 },
			{ route: "slant" },
			{ tempo: "chewClock" },
			{ timeout: opponent },
		]) {
			assert.throws(
				() => submit(controller, decision as FootballCoachDecision),
				/own team/,
			);
		}
		assert.strictEqual(controller.get(7)?.status, "waiting");
		submit(controller, { defenseId: "blitz" });
		assert.deepEqual(await defense, { defenseId: "blitz" });
		const clock = controller.next(
			7,
			makeSnapshot({
				stage: "clock",
				offense: opponent,
				defense: controlledTeam,
				allowedPlays: [],
				canTimeout: [true, true],
			}),
		);
		assert.throws(() => submit(controller, { timeout: opponent }), /own team/);
		submit(controller, { timeout: controlledTeam });
		assert.deepEqual(await clock, { timeout: controlledTeam });
		const offense = controller.next(
			7,
			makeSnapshot({
				offense: controlledTeam,
				defense: opponent,
				allowedDefenseIds: ["blitz"],
			}),
		);
		assert.throws(() => submit(controller, { defenseId: "blitz" }), /own team/);
		submit(controller, { play: "run" });
		assert.deepEqual(await offense, { play: "run" });
	},
);

test("opponent special-team calls and unavailable defensive timeouts advance automatically", async () => {
	const { controller } = start();
	assert.isUndefined(
		await controller.next(
			7,
			makeSnapshot({
				offense: 1,
				defense: 0,
				allowedPlays: ["kickoff", "onsideKick"],
			}),
		),
	);
	assert.isUndefined(
		await controller.next(
			7,
			makeSnapshot({
				stage: "clock",
				offense: 1,
				defense: 0,
				canTimeout: [false, true],
			}),
		),
	);
	assert.strictEqual(controller.get(7)?.revision, 0);
	const ownKick = controller.next(
		7,
		makeSnapshot({ allowedPlays: ["kickoff", "onsideKick"] }),
	);
	submit(controller, { play: "onsideKick" });
	assert.deepEqual(await ownKick, { play: "onsideKick" });
});

test("coaching requires explicit valid team ownership", () => {
	const controller = new FootballCoachController();
	for (const controlledTeam of [undefined, -1, 2, "0"]) {
		assert.throws(
			() =>
				controller.start({ ...makeInput(), controlledTeam } as Parameters<
					FootballCoachController["start"]
				>[0]),
			/Choose your team/,
		);
	}
	assert.strictEqual(controller.isActive(), false);
});

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
	const { default: GameSimFootball } =
		await import("../GameSim.football/index.ts");
	const originalLeague = idb.league;
	const originalCache = idb.cache;
	const nativeInjuries = GameSimFootball.prototype.injuries;
	const injuryRoll = vi
		.spyOn(GameSimFootball.prototype, "injuries")
		.mockImplementationOnce(function (
			this: InstanceType<typeof GameSimFootball>,
		) {
			// Trigger one native injury on the first snap. Diagnosis and all save
			// work remain the real pipeline, rather than a fabricated box score.
			const originalRate = this.baseInjuryRate;
			this.baseInjuryRate = 0.001;
			const random = vi
				.spyOn(Math, "random")
				.mockReturnValue(0.99)
				.mockReturnValueOnce(0);
			try {
				nativeInjuries.call(this);
			} finally {
				random.mockRestore();
				this.baseInjuryRate = originalRate;
			}
		});
	const flushEntered = deferred();
	const releaseFlush = deferred();
	let completion: Promise<void> | undefined;
	let completionResult: Game | undefined;
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
			controlledTeam: 0,
			teams: [teams[0]!, teams[1]!],
		});
		footballCoach.automate(7, session.sessionId, "end");
		let decisions = 0;
		let sawUnknownInjury = false;
		completion = play(1, {}, true, 42, true, (snapshot) => {
			decisions += 1;
			for (const injured of snapshot
				.boxScore!.teams.flatMap((team) => team.players)
				.filter((p) => p.newInjury)) {
				assert.deepEqual(injured.injury, {
					type: "Injured",
					gamesRemaining: -1,
					playingThrough: false,
				});
				sawUnknownInjury = true;
			}
			return footballCoach.next(7, snapshot);
		}).then(async () => {
			completionResult = structuredClone((await idb.merged.games.get(42))!);
			footballCoach.complete(
				7,
				"/l/7/game_log/HOM_0/2016/42",
				completionResult,
			);
		});
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
		const finalBoxScore = finalSnapshot.boxScore!;
		assert.isDefined(finalBoxScore);
		assert.isTrue(sawUnknownInjury);
		const newlyInjured = finalBoxScore.teams
			.flatMap((team) => team.players)
			.filter((p) => p.newInjury);
		assert.lengthOf(newlyInjured, 1);
		const injuredPid = newlyInjured[0]!.id;
		const savedInjured = games[0]!.teams
			.flatMap((team) => team.players)
			.find((p) => p.pid === injuredPid)!;
		const diagnosedInjury = structuredClone(savedInjured.injury);
		assert.isTrue(diagnosedInjury.newThisGame);
		assert.notEqual(diagnosedInjury.type, "Injured");
		assert.isAtLeast(diagnosedInjury.gamesRemaining, 0);
		const savedPlayer = players.find((p) => p.pid === injuredPid)!;
		assert.strictEqual(savedPlayer.injury.type, diagnosedInjury.type);
		assert.strictEqual(
			savedPlayer.injury.gamesRemaining,
			diagnosedInjury.gamesRemaining,
		);
		assert.deepEqual(finalBoxScore.scoringSummary, games[0]!.scoringSummary);
		// Use the native stat registry so every passing, rushing, receiving,
		// defense, kicking, return, penalty, and blocking counter is covered.
		const playerStats = player.stats.raw.filter((stat) => stat !== "min");
		for (const t of [0, 1] as const) {
			const liveTeam = finalBoxScore.teams[t];
			const savedTeam = games[0]!.teams[t];
			assert.strictEqual(liveTeam.id, savedTeam.tid);
			assert.lengthOf(liveTeam.players, 50);
			for (const [stat, value] of Object.entries(liveTeam.stat)) {
				assert.deepEqual(value, savedTeam[stat], `Team ${t}: ${stat}`);
			}
			const livePlayersByPid = new Map(liveTeam.players.map((p) => [p.id, p]));
			const savedPids = new Set(savedTeam.players.map((p) => p.pid));
			for (const savedPlayer of savedTeam.players) {
				const livePlayer = livePlayersByPid.get(savedPlayer.pid);
				assert.isDefined(livePlayer, `Missing live player ${savedPlayer.pid}`);
				for (const stat of playerStats) {
					assert.strictEqual(
						livePlayer!.stat[stat],
						savedPlayer[stat],
						`Player ${savedPlayer.pid}: ${stat}`,
					);
				}
			}
			// Native saved games omit DNPs; the live roster deliberately retains them.
			for (const livePlayer of liveTeam.players) {
				assert.strictEqual(
					savedPids.has(livePlayer.id),
					livePlayer.stat.gp! > 0,
					`Player ${livePlayer.id}: participation`,
				);
			}
		}
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
		assert.strictEqual(footballCoach.get(7)!.status, "complete");
		const completedBoxScore = footballCoach.get(7)!.snapshot!.boxScore!;
		const completedInjured = completedBoxScore.teams
			.flatMap((team) => team.players)
			.find((p) => p.id === injuredPid)!;
		assert.deepEqual(completedInjured.injury, {
			...diagnosedInjury,
			playingThrough: false,
		});
		// Every raw statistic and all other metadata stay unchanged. Only the
		// diagnosed injury replaces the live unknown label after saving finishes.
		const expectedFinalBoxScore = structuredClone(finalBoxScore);
		expectedFinalBoxScore.teams
			.flatMap((team) => team.players)
			.find((p) => p.id === injuredPid)!.injury = completedInjured.injury;
		assert.deepEqual(completedBoxScore, expectedFinalBoxScore);
		completionResult!.teams
			.flatMap((team) => team.players)
			.find((p) => p.pid === injuredPid)!.injury.type = "mutated saved result";
		assert.deepEqual(
			footballCoach.get(7)!.snapshot!.boxScore,
			completedBoxScore,
			"Completed injury metadata must not alias the saved result",
		);
		assert.strictEqual(flushes, 1);
		footballCoach.automate(7, session.sessionId, "end");
		await footballCoach.finishBeforeClosingLeague();
		assert.deepEqual(
			footballCoach.get(7)!.snapshot!.boxScore,
			completedBoxScore,
		);
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
		injuryRoll.mockRestore();
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

test.each([0, 1] as const)(
	"a full game coached by team %i survives a native database disconnect and reopen",
	async (controlledTeam) => {
		const fakeIndexedDB = await import("fake-indexeddb");
		const { resetCache, resetG } = await import("../../../test/helpers.ts");
		const { DEFAULT_LEVEL } = await import("../../../common/budgetLevels.ts");
		const { PHASE } = await import("../../../common/constants.ts");
		const { defaultGameAttributes } =
			await import("../../../common/defaultGameAttributes.ts");
		const { player, team, league } = await import("../index.ts");
		const { Cache, connectLeague, idb } = await import("../../db/index.ts");
		const { g, helpers, local, lock } = await import("../../util/index.ts");
		const { footballCoach } = await import("./footballCoach.ts");
		const { default: play } = await import("./play.ts");
		const { default: gameLog } = await import("../../views/gameLog.ts");
		const originalLeague = idb.league;
		const originalCache = idb.cache;
		const lid = 71000 + controlledTeam;
		const season = 2035;
		let database: typeof idb.league | undefined;
		let completion: Promise<void> | undefined;
		try {
			// Exercise native IndexedDB transactions in an isolated test database.
			// This does not use the browser's database or mock Cache.flush/fill.
			for (const [name, value] of Object.entries(fakeIndexedDB)) {
				if (name.startsWith("IDB")) {
					vi.stubGlobal(name, value);
				}
			}
			vi.stubGlobal("indexedDB", new fakeIndexedDB.IDBFactory());
			resetG();
			local.reset();
			lock.reset();
			g.setWithoutSavingToDB("lid", lid);
			g.setWithoutSavingToDB("season", season);
			g.setWithoutSavingToDB("startingSeason", season);
			g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
			g.setWithoutSavingToDB("injuryRate", 0);
			g.setWithoutSavingToDB("userTid", controlledTeam);
			g.setWithoutSavingToDB("userTids", [controlledTeam]);
			g.setWithoutSavingToDB("numGamesPlayoffSeries", [1]);
			g.setWithoutSavingToDB("numPlayoffByes", 0);
			g.setWithoutSavingToDB("playoffsByConf", false);
			g.setWithoutSavingToDB("numTeams", 4);
			g.setWithoutSavingToDB("numActiveTeams", 4);
			const teams = helpers.getTeamsDefault().slice(0, 4).map(team.generate);
			database = await connectLeague(lid);
			idb.league = database;
			await resetCache(
				{
					players: teams.flatMap((t) =>
						Array.from({ length: 50 }, () =>
							player.generate(t.tid, 25, season - 3, true, DEFAULT_LEVEL),
						),
					),
					teams,
					teamSeasons: teams.map((t) => team.genSeasonRow(t)),
					teamStats: teams.map((t) => team.genStatsRow(t.tid)),
				},
				{ stubFlush: false },
			);
			for (const key of helpers.keys(defaultGameAttributes)) {
				await idb.cache.gameAttributes.put({ key, value: g.getRaw(key) });
			}
			await idb.cache.schedule.add({ gid: 42, day: 1, homeTid: 0, awayTid: 1 });
			await idb.cache.schedule.add({ gid: 43, day: 1, homeTid: 2, awayTid: 3 });
			await idb.cache.flush();
			idb.cache = new Cache();
			await idb.cache.fill(season);
			local.leagueLoaded = true;
			const session = footballCoach.start({
				lid,
				gid: 42,
				controlledTeam,
				teams: [teams[0]!, teams[1]!],
			});
			let offenseDecisions = 0;
			let defenseDecisions = 0;
			let clockDecisions = 0;
			let ownTimeouts = 0;
			const possessions = new Set<number>();
			const quarters = new Set<number>();
			completion = play(1, {}, true, 42, true, (snapshot) => {
				assert.strictEqual(snapshot.controlledTeam, controlledTeam);
				possessions.add(snapshot.offense);
				quarters.add(snapshot.quarter);
				const pending = footballCoach.next(lid, snapshot);
				const current = footballCoach.get(lid)!;
				if (current.status === "waiting") {
					let decision: FootballCoachDecision;
					if (snapshot.stage === "clock") {
						clockDecisions += 1;
						if (ownTimeouts === 0 && snapshot.canTimeout[controlledTeam]) {
							decision = { timeout: controlledTeam };
							ownTimeouts += 1;
						} else {
							decision =
								snapshot.offense === controlledTeam ? { tempo: "hurryUp" } : {};
						}
					} else if (snapshot.offense === controlledTeam) {
						offenseDecisions += 1;
						decision = snapshot.allowedPlays.includes("run")
							? { callId: offenseDecisions % 2 === 0 ? "slant" : "insideZone" }
							: { play: "auto" };
					} else {
						defenseDecisions += 1;
						assert.throws(
							() =>
								footballCoach.submit(lid, {
									sessionId: current.sessionId,
									revision: current.revision,
									decision: { callId: "slant" },
								}),
							/own team/,
						);
						decision = { defenseId: "nickel" };
					}
					footballCoach.submit(lid, {
						sessionId: current.sessionId,
						revision: current.revision,
						decision,
					});
				}
				return pending;
			}).then(() =>
				footballCoach.complete(
					lid,
					`/l/${lid}/game_log/${teams[controlledTeam]!.abbrev}_${controlledTeam}/${season}/42`,
				),
			);
			footballCoach.track(completion);
			await completion;
			assert.isAbove(offenseDecisions, 0);
			assert.isAbove(defenseDecisions, 0);
			assert.isAbove(clockDecisions, 0);
			assert.strictEqual(ownTimeouts, 1);
			assert.deepEqual([...possessions].sort(), [0, 1]);
			assert.includeMembers([...quarters], [1, 2, 3, 4]);
			assert.strictEqual(footballCoach.get(lid)!.status, "complete");
			const beforeClose = {
				game: await idb.cache.games.get(42),
				players: await idb.cache.players.getAll(),
				teamStats: await idb.cache.teamStats.getAll(),
				teamSeasons: await idb.cache.teamSeasons.getAll(),
				schedule: await idb.cache.schedule.getAll(),
			};
			assert.isDefined(beforeClose.game);
			assert.deepEqual(
				beforeClose.schedule.map((game) => game.gid),
				[43],
			);
			assert.deepEqual(
				beforeClose.teamStats.filter((row) => row.tid < 2).map((row) => row.gp),
				[1, 1],
			);
			const finalStats = footballCoach.get(lid)!.snapshot!.boxScore!;
			assert.deepEqual(
				finalStats.scoringSummary,
				beforeClose.game!.scoringSummary,
			);
			await league.close(true);
			assert.isUndefined(g.get("lid"));
			assert.throws(() => database!.transaction("games"));
			helpers.resetG();
			assert.throws(() => g.get("season"), /not already set/);
			database = await connectLeague(lid);
			idb.league = database;
			g.setWithoutSavingToDB("lid", lid);
			idb.cache = new Cache();
			// With globals cleared, native fill discovers season from persisted data.
			await idb.cache.fill();
			await league.loadGameAttributes();
			assert.strictEqual(g.get("season"), season);
			assert.strictEqual(g.get("userTid"), controlledTeam);
			assert.deepEqual(g.get("userTids"), [controlledTeam]);
			assert.deepEqual(await database.get("games", 42), beforeClose.game);
			assert.deepEqual(await idb.merged.games.get(42), beforeClose.game);
			assert.deepEqual(await database.getAll("players"), beforeClose.players);
			assert.deepEqual(await idb.cache.players.getAll(), beforeClose.players);
			assert.deepEqual(
				await database.getAll("teamStats"),
				beforeClose.teamStats,
			);
			assert.deepEqual(
				await idb.cache.teamStats.getAll(),
				beforeClose.teamStats,
			);
			assert.deepEqual(
				await database.getAll("teamSeasons"),
				beforeClose.teamSeasons,
			);
			assert.deepEqual(
				await idb.cache.teamSeasons.getAll(),
				beforeClose.teamSeasons,
			);
			assert.deepEqual(await database.getAll("schedule"), beforeClose.schedule);
			assert.deepEqual(await idb.cache.schedule.getAll(), beforeClose.schedule);
			const view = await gameLog.load({
				inputs: {
					gid: 42,
					season,
					tid: controlledTeam,
					abbrev: teams[controlledTeam]!.abbrev,
				},
				updateEvents: new Set(["firstRun"]),
				prevInputs: undefined,
				prevOutput: {},
				conditions: {},
			});
			expect(view.boxScore).toMatchObject({
				gid: 42,
				season,
				scoringSummary: finalStats.scoringSummary,
				teams: finalStats.teams.map((t) => ({ tid: t.id, pts: t.stat.pts })),
			});
			await footballCoach.finishBeforeClosingLeague();
			await idb.cache.flush();
			assert.strictEqual((await database.getAll("games")).length, 1);
			assert.deepEqual(
				await database.getAll("teamStats"),
				beforeClose.teamStats,
			);
			assert.deepEqual(footballCoach.get(lid)!.snapshot!.boxScore, finalStats);
			assert.strictEqual(footballCoach.get(lid)!.sessionId, session.sessionId);
		} finally {
			if (footballCoach.isActive()) {
				footballCoach.fail(lid, new Error("test cleanup"));
			}
			if (completion) {
				await completion.catch(() => {});
			}
			footballCoach.complete(lid, "/test-cleanup");
			idb.cache.stopAutoFlush();
			database?.close();
			idb.league = originalLeague;
			idb.cache = originalCache;
			vi.unstubAllGlobals();
			local.reset();
			lock.reset();
			resetG();
		}
	},
);

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

test("the game-start API refuses coaching unrelated matchups and spectator teams", async () => {
	const { resetCache, resetG } = await import("../../../test/helpers.ts");
	const { PHASE } = await import("../../../common/constants.ts");
	const { idb } = await import("../../db/index.ts");
	const { g, local, lock } = await import("../../util/index.ts");
	const { default: actions } = await import("../../api/actions.ts");
	const { footballCoach } = await import("./footballCoach.ts");
	const originalCache = idb.cache;
	try {
		resetG();
		local.reset();
		lock.reset();
		g.setWithoutSavingToDB("lid", 12);
		g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
		g.setWithoutSavingToDB("userTid", 2);
		await resetCache({});
		await idb.cache.schedule.add({ gid: 42, day: 1, homeTid: 0, awayTid: 1 });
		await expect(actions.interactiveGame(42, {})).rejects.toThrow(
			/only coach the team selected/,
		);
		g.setWithoutSavingToDB("userTid", 1);
		g.setWithoutSavingToDB("spectator", true);
		await expect(actions.interactiveGame(42, {})).rejects.toThrow(
			/only coach the team selected/,
		);
		assert.strictEqual(footballCoach.isActive(), false);
		assert.strictEqual(lock.get("gameSim"), false);
		assert.strictEqual((await idb.cache.schedule.getAll()).length, 1);
		assert.strictEqual((await idb.cache.games.getAll()).length, 0);
	} finally {
		idb.cache = originalCache;
		local.reset();
		lock.reset();
		resetG();
	}
});
