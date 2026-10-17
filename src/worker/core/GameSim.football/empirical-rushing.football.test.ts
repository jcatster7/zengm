// @ts-expect-error Node-only test imports are outside the browser tsconfig types.
import { createHash } from "node:crypto";
// @ts-expect-error Node-only test imports are outside the browser tsconfig types.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { makeSeededRandom } from "../../../common/random.ts";
import { range } from "../../../common/utils.ts";
import { getBlockingFactors } from "./getCompositeFactor.ts";
import type { FootballCoachCallId } from "../../../common/footballCoachPlaybook.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";

const reference: FootballCoachReference = JSON.parse(
	readFileSync(
		new URL(
			"../../../../public/files/football-coach-reference.json",
			import.meta.url,
		),
		"utf8",
	),
);

beforeAll(async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	const random = vi
		.spyOn(Math, "random")
		.mockImplementation(makeSeededRandom(202310));
	try {
		const teams = helpers.getTeamsDefault().slice(0, 2);
		await resetCache({
			players: [0, 1].flatMap((tid) =>
				range(50).map(() =>
					player.generate(tid, 25, 2010, true, DEFAULT_LEVEL),
				),
			),
			teams: teams.map(team.generate),
			teamSeasons: teams.map((t) => team.genSeasonRow(t)),
			teamStats: teams.map((t) => team.genStatsRow(t.tid)),
		});
	} finally {
		random.mockRestore();
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	g.setWithoutSavingToDB("rushYdsFactor", 1);
});

// A native GameSim with a controlled, fixed matchup. Only raw rushing yardage
// is measured: penalties, fumbles, field clipping, and play-stat mutation are
// excluded. This is a distribution regression, not full-game NFL calibration.
const initRushing = async (callId?: FootballCoachCallId, matchupFactor = 1) => {
	// Formation selection and fatigue substitutions consume randomness too.
	// Seed setup separately so the subsequent yardage stream is independent of
	// test order and unrelated Math.random calls in other suites.
	const random = vi
		.spyOn(Math, "random")
		.mockImplementation(makeSeededRandom(202310));
	const teams = await loadTeams([0, 1], {});
	for (const t of [teams[0], teams[1]]) {
		if (t.depth) {
			t.depth = team.getDepthPlayers(t.depth, t.player);
		}
		for (const p of t.player) {
			for (const rating of Object.keys(p.compositeRating)) {
				p.compositeRating[rating] = 0.5;
			}
			for (const pos of helpers.keys(p.ovrs)) {
				p.ovrs[pos] = 50;
			}
		}
	}
	const game = new GameSim({
		gid: 0,
		teams: [teams[0], teams[1]],
		baseInjuryRate: 0,
		doPlayByPlay: false,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: true,
	});
	game.o = 0;
	game.d = 1;
	game.awaitingKickoff = undefined;
	game.setCoachTeam(0);
	game["prepareCoachTactics"](callId ? { callId } : undefined);
	if (!callId) {
		// Hold the native automatic fixture at 21 personnel; different blocker
		// counts consume different random draws before the yardage calculation.
		random.mockReturnValueOnce(0.5);
	}
	game.updatePlayersOnField("run");
	if (!callId) {
		expect([
			game.playersOnField[0].RB?.length,
			game.playersOnField[0].TE?.length,
		]).toEqual([2, 1]);
	}
	const runner = game.getTopPlayerOnField(0, "RB");
	game["prepareCoachTactics"](
		callId ? { callId, runnerPid: runner.id } : undefined,
	);
	const blocking = getBlockingFactors({
		...game.playersOnField[0],
		RB: (game.playersOnField[0].RB ?? []).filter((p) => p !== runner),
	})[1];
	game.team[0].compositeRating.runBlocking = blocking;
	game.team[1].compositeRating.runStopping =
		(0.5 * (runner.compositeRating.rushing + blocking)) / matchupFactor;
	vi.spyOn(game, "updatePlayersOnField").mockImplementation(() => {});
	vi.spyOn(game, "pickPlayer").mockReturnValue(runner);
	vi.spyOn(game, "checkPenalties").mockReturnValue(false);
	vi.spyOn(game, "probFumble").mockReturnValue(0);
	vi.spyOn(game, "doTackle").mockImplementation(() => {});
	vi.spyOn(game.currentPlay, "addEvent").mockReturnValue({
		td: false,
		safety: false,
		touchback: false,
	});
	const rawYards: number[] = [];
	vi.spyOn(game.currentPlay, "boundedYds").mockImplementation((yards) => {
		rawYards.push(yards);
		return yards;
	});
	g.setWithoutSavingToDB("rushYdsFactor", 1);
	random.mockImplementation(makeSeededRandom(803));
	return { game, rawYards, random };
};

const getProfile = (id: string) => {
	const profile = reference.profiles.find((entry) => entry.id === id);
	if (!profile?.rushYardsDistribution?.length) {
		throw new Error(`Missing observed rushing profile ${id}`);
	}
	return { ...profile, rushYardsDistribution: profile.rushYardsDistribution };
};

test.each([
	["runInside", "insideZone"],
	["runOutside", "outsideZone"],
] as const)(
	"%s preserves every observed yard value at a neutral matchup",
	async (id, callId) => {
		const profile = getProfile(id);
		const { game, rawYards } = await initRushing(callId);
		let weightedYards = 0;
		let negatives = 0;
		let explosive = 0;
		for (const bin of profile.rushYardsDistribution) {
			game.setCoachReference({
				...reference,
				profiles: [{ ...profile, rushYardsDistribution: [bin] }],
			});
			game.doRun();
			const actual = rawYards.at(-1)!;
			expect(actual).toBe(bin.yards);
			weightedYards += actual * bin.count;
			negatives += actual < 0 ? bin.count : 0;
			explosive += actual >= 20 ? bin.count : 0;
		}
		expect(weightedYards / profile.rushSampleSize).toBeCloseTo(
			profile.meanYards,
			8,
		);
		expect(negatives).toBe(
			profile.rushYardsDistribution
				.filter((bin) => bin.yards < 0)
				.reduce((sum, bin) => sum + bin.count, 0),
		);
		expect(explosive).toBe(
			profile.rushYardsDistribution
				.filter((bin) => bin.yards >= 20)
				.reduce((sum, bin) => sum + bin.count, 0),
		);
	},
);

test("a measured positive outcome does not receive another native breakaway draw", async () => {
	const { game, rawYards } = await initRushing("insideZone");
	const profile = getProfile("runInside");
	const bin = profile.rushYardsDistribution.find((entry) => entry.yards === 4)!;
	game.setCoachReference({
		...reference,
		profiles: [{ ...profile, rushYardsDistribution: [bin] }],
	});
	for (let i = 0; i < 512; i += 1) {
		game.doRun();
	}
	expect(new Set(rawYards)).toEqual(new Set([4]));
});

test.each([
	["runInside", "insideZone"],
	["runOutside", "outsideZone"],
] as const)(
	"%s weighted sampling retains historical mean, loss rate, and 20-yard rate",
	async (id, callId) => {
		const profile = getProfile(id);
		const { game, rawYards } = await initRushing(callId);
		game.setCoachReference(reference);
		for (let i = 0; i < 25000; i += 1) {
			game.doRun();
		}
		for (const metric of [
			{ name: "mean rushing yards", value: (yards: number) => yards },
			{
				name: "negative-yard rate",
				value: (yards: number) => Number(yards < 0),
			},
			{ name: "20-yard rate", value: (yards: number) => Number(yards >= 20) },
		]) {
			const expected =
				profile.rushYardsDistribution.reduce(
					(sum, bin) => sum + metric.value(bin.yards) * bin.count,
					0,
				) / profile.rushSampleSize;
			const variance =
				profile.rushYardsDistribution.reduce(
					(sum, bin) =>
						sum + (metric.value(bin.yards) - expected) ** 2 * bin.count,
					0,
				) / profile.rushSampleSize;
			const observed =
				rawYards.reduce((sum, yards) => sum + metric.value(yards), 0) /
				rawYards.length;
			// Seeded samples; tolerance comes from the observed distribution's variance.
			// This checks sampling integrity at the fixed neutral matchup above.
			expect(Math.abs(observed - expected), metric.name).toBeLessThan(
				4 * Math.sqrt(variance / rawYards.length),
			);
		}
	},
);

test("empirical outcomes still receive native matchup and league yardage adjustments", async () => {
	const { game, rawYards } = await initRushing("insideZone", 2);
	const profile = getProfile("runInside");
	const bin = profile.rushYardsDistribution.find(
		(entry) => entry.yards === -6,
	)!;
	game.setCoachReference({
		...reference,
		profiles: [{ ...profile, rushYardsDistribution: [bin] }],
	});
	g.setWithoutSavingToDB("rushYdsFactor", 1.5);
	game.doRun();
	// Native matchup mean is 7, so the observed -6 gets +3.5, then the league factor.
	expect(rawYards).toEqual([Math.round(Math.round(-6 + 7 - 3.5) * 1.5)]);
});

test.each([
	[
		undefined,
		"c0934b5a25ea234aad72e33f292ad884a27d6eb85582b69d5b7451f58eaf9d5b",
	],
	["draw", "e02a62edc4fd3e459d4296682b967f4319f6f363a4d2cb959ce0efcbdde082a2"],
	[
		"qbSneak",
		"799cf6717f4c396242eca7737a8030125ab1d59186590c3d2f1446f111712674",
	],
] as const)(
	"%s retains its seeded native fallback with the reference loaded",
	async (callId, baseline) => {
		const { game, rawYards, random } = await initRushing(callId);
		for (let i = 0; i < 1024; i += 1) {
			game.doRun();
		}
		const expected = [...rawYards];
		const nextRandom = Math.random();
		game.setCoachReference(reference);
		rawYards.length = 0;
		random.mockImplementation(makeSeededRandom(803));
		for (let i = 0; i < 1024; i += 1) {
			game.doRun();
		}
		expect(rawYards).toEqual(expected);
		expect(Math.random()).toBe(nextRandom);
		// Captured before the empirical-only correction, including random consumption.
		const digest = createHash("sha256")
			.update(JSON.stringify([expected, nextRandom]))
			.digest("hex");
		expect(digest).toBe(baseline);
	},
);
