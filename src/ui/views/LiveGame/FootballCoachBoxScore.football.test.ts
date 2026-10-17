import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FootballCoachBoxScorePlayer } from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { PLAYER_GAME_STATS } from "../../../common/constants.football.ts";
import playerStats from "../../../worker/core/player/stats.football.ts";
import { local } from "../../util/local.ts";
import {
	FootballCoachBoxScore,
	getFootballCoachBoxScore,
} from "./FootballCoachBoxScore.tsx";

// Static rendering exercises the real tables and player links without spawning
// the browser worker used by player-popover click handlers.
vi.mock("../../util/toWorker.ts", () => ({ toWorker: vi.fn() }));
// The shared row imports this baseball-only decoration from a routed view.
vi.mock("../PlayerGameLog.tsx", () => ({ BaseballDecision: () => null }));

const player = (
	id: number,
	name: string,
	pos: string,
	stat: Record<string, number>,
): FootballCoachBoxScorePlayer => ({
	id,
	name,
	pos,
	stat: {
		...Object.fromEntries(playerStats.raw.map((key) => [key, 0])),
		...stat,
	},
	jerseyNumber: "12",
	skills: [],
	injured: false,
	newInjury: false,
	injury: { type: "Healthy", gamesRemaining: 0, playingThrough: false },
});
const fixture = (): FootballCoachSession => ({
	sessionId: "box-score-test",
	lid: 7,
	gid: 42,
	revision: 2,
	status: "waiting",
	controlledTeam: 1,
	controlledTid: 9,
	teams: [
		{
			tid: 4,
			abbrev: "HOM",
			region: "Home",
			name: "Club",
			colors: ["#123456"],
		},
		{
			tid: 9,
			abbrev: "AWY",
			region: "Away",
			name: "Club",
			colors: ["#654321"],
		},
	],
	snapshot: {
		gid: 42,
		stage: "play",
		quarter: 2,
		numPeriods: 4,
		clock: 10,
		down: 1,
		toGo: 10,
		scrimmage: 30,
		offense: 0,
		defense: 1,
		teams: [
			{ id: 4, pts: 0 },
			{ id: 9, pts: 0 },
		],
		timeouts: [3, 3],
		canTimeout: [false, false],
		awaitingKickoff: undefined,
		awaitingAfterTouchdown: false,
		isClockRunning: false,
		allowedPlays: ["run", "pass"],
		events: [],
		playersOnField: [[], []],
		boxScore: {
			season: 2026,
			overtimes: 0,
			neutralSite: false,
			scoringSummary: [],
			teams: [
				{
					id: 4,
					stat: { pts: 0, ptsQtrs: [0, 0] },
					players: [
						player(101, "Home Quarterback", "QB", {
							pss: 4,
							pssCmp: 2,
							pssYds: 30,
						}),
						player(102, "Home Receiver", "WR", {
							tgt: 3,
							rec: 2,
							recYds: 30,
							recLng: 19,
						}),
						player(103, "Home Reserve", "WR", {}),
					],
				},
				{
					id: 9,
					stat: { pts: 0, ptsQtrs: [0, 0] },
					players: [
						player(201, "Away Quarterback", "QB", {
							pss: 1,
							pssCmp: 1,
							pssYds: 9,
						}),
						player(202, "Away Runner", "RB", { rus: 2, rusYds: 13, rusLng: 8 }),
						player(203, "Away Defender", "LB", {
							defTckSolo: 2,
							defTckAst: 1,
							defSk: 0.5,
						}),
					],
				},
			],
		},
	},
});
const original = local.getState();
beforeEach(() =>
	local
		.getState()
		.actions.update({ lid: 7, fullNames: true, fantasyPoints: "ppr" }),
);
afterEach(() =>
	local.getState().actions.update({
		lid: original.lid,
		fullNames: original.fullNames,
		fantasyPoints: original.fantasyPoints,
	}),
);
const render = (session: FootballCoachSession) =>
	renderToStaticMarkup(createElement(FootballCoachBoxScore, { session }));
const text = (html: string) => html.replace(/<[^>]*>/g, "");
const cells = (html: string, name: string) => {
	const rows = [...html.matchAll(/<tr\b[^>]*>([\S\s]*?)<\/tr>/g)];
	for (const row of rows) {
		const values = [...row[1]!.matchAll(/<td\b[^>]*>([\S\s]*?)<\/td>/g)].map(
			(cell) => text(cell[1]!),
		);
		if (values[1]?.includes(name)) {
			return values.slice(2);
		}
	}
	return [];
};

test("uses the usual native categories, player links, and away-first team tables", () => {
	const html = render(fixture());
	expect(
		[...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((heading) => text(heading[1]!)),
	).toEqual([
		"Scoring Summary",
		...Object.values(PLAYER_GAME_STATS).map((info) => info.name),
	]);
	expect(
		[...html.matchAll(/<th\b[^>]*\bcolspan="2"[^>]*>([\S\s]*?)<\/th>/gi)]
			.slice(0, 2)
			.map((heading) => text(heading[1]!)),
	).toEqual(["Away Club", "Home Club"]);
	expect(html).toContain("/l/7/player/101");
	expect(html).toContain("Game statistics update after each play.");
	expect(html).not.toContain("Home Reserve");
	expect(html).not.toMatch(/NaN|Infinity/);
});

test("native calculated passing, receiving, rushing and defensive columns use cumulative raw totals", () => {
	const html = render(fixture());
	expect(cells(html, "Home Quarterback").slice(0, 4).map(Number)).toEqual([
		2, 4, 50, 30,
	]);
	expect(Number(cells(html, "Home Quarterback")[8])).toBe(75);
	expect(cells(html, "Home Receiver").slice(0, 4).map(Number)).toEqual([
		3, 2, 30, 15,
	]);
	expect(cells(html, "Away Runner").slice(0, 3).map(Number)).toEqual([
		2, 13, 6.5,
	]);
	expect(cells(html, "Away Defender").slice(0, 3).map(Number)).toEqual([
		2, 1, 3,
	]);
});

test("new snapshots update earlier totals without relying on the recent-play log and retain final tables", () => {
	const session = fixture();
	const before = render(session);
	const next = structuredClone(session);
	next.revision += 1;
	Object.assign(next.snapshot!.boxScore!.teams[0].players[0]!.stat, {
		pss: 5,
		pssCmp: 3,
		pssYds: 45,
	});
	next.status = "complete";
	const after = render(next);
	expect(cells(before, "Home Quarterback").slice(0, 4).map(Number)).toEqual([
		2, 4, 50, 30,
	]);
	expect(cells(after, "Home Quarterback").slice(0, 4).map(Number)).toEqual([
		3, 5, 60, 45,
	]);
	expect(next.snapshot!.events).toEqual([]);
	expect(after).toContain("Final game statistics.");
	expect(after).toContain("Away Defender");
});

test("adapting totals cannot alter native statistics or invent pregame rows", () => {
	const session = fixture();
	const before = structuredClone(session);
	const boxScore = getFootballCoachBoxScore(session)!;
	boxScore.teams[0].players[0]!.pssYds = 999;
	expect(session).toEqual(before);
	delete session.snapshot;
	expect(render(session)).toBe("");
});
