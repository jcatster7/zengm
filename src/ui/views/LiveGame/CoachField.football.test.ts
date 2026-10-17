import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type {
	FootballCoachLineupPlayer,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import { getFootballCoachCall } from "../../../common/footballCoachPlaybook.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { CoachField, matchesCoachRole, pinCoachPlayer } from "./CoachField.tsx";
import { CoachPlayerDetails } from "./CoachRoster.tsx";

const lineup = (
	slots: string[],
	firstId: number,
): FootballCoachLineupPlayer[] =>
	slots.map((slot, i) => ({
		id: firstId + i,
		name: `Test ${slot}`,
		pos: slot.replace(/\d+$/, ""),
		slot,
	}));
const offense = lineup(
	["QB1", "RB1", "WR1", "WR2", "WR3", "TE1", "OL1", "OL2", "OL3", "OL4", "OL5"],
	100,
);
const defense = lineup(
	["DL1", "DL2", "DL3", "DL4", "LB1", "LB2", "LB3", "CB1", "CB2", "S1", "S2"],
	200,
);
const snapshot: FootballCoachSnapshot = {
	gid: 1,
	stage: "play",
	controlledTeam: 0,
	quarter: 4,
	numPeriods: 4,
	clock: 1.5,
	down: 2,
	toGo: 5,
	scrimmage: 70,
	offense: 0,
	defense: 1,
	teams: [
		{ id: 0, pts: 14 },
		{ id: 1, pts: 17 },
	],
	timeouts: [2, 1],
	canTimeout: [false, false],
	awaitingKickoff: undefined,
	awaitingAfterTouchdown: false,
	isClockRunning: false,
	allowedPlays: ["run", "pass"],
	allowedCallIds: ["slant"],
	events: [],
	playersOnField: [offense, defense],
};
const session: FootballCoachSession = {
	sessionId: "field-test",
	lid: 1,
	gid: 1,
	revision: 1,
	status: "waiting",
	snapshot,
	controlledTeam: 0,
	controlledTid: 0,
	teams: [
		{
			tid: 0,
			abbrev: "HOM",
			region: "Home",
			name: "Test",
			colors: ["#143a50"],
		},
		{
			tid: 1,
			abbrev: "AWY",
			region: "Away",
			name: "Test",
			colors: ["#773344"],
		},
	],
	rosters: [
		offense.map((p) => ({
			pid: p.id,
			name: p.name,
			pos: p.pos,
			team: "HOM",
			jerseyNumber: String(p.id - 100),
		})),
		defense.map((p) => ({ pid: p.id, name: p.name, pos: p.pos, team: "AWY" })),
	],
};
const render = (overrides: Partial<Parameters<typeof CoachField>[0]> = {}) =>
	renderToStaticMarkup(
		createElement(CoachField, {
			snapshot,
			session,
			offense,
			defense,
			preview: true,
			call: getFootballCoachCall("slant"),
			targetPid: 102,
			onSelect: () => {},
			...overrides,
		}),
	);

test("formation field renders all 22 roster identities with keyboard-selectable markers", () => {
	const html = render();
	expect(html.match(/class="football-coach-player"/g)).toHaveLength(22);
	expect(html.match(/tabindex="0"/g)).toHaveLength(22);
	for (const player of [...offense, ...defense]) {
		expect(html).toContain(`aria-label="${player.slot}, ${player.name}`);
	}
	expect(html).toContain("WR1, Test WR1, selected target");
	expect(html).not.toContain("OVR");
});

test("route overrides change the selected receiver path and last-snap display removes it", () => {
	const routePath = (html: string) =>
		html.match(/<path d="([^"]+)" fill="none" stroke="#81d4eb"/)?.[1];
	expect(routePath(render({ route: "go" }))).toBeTruthy();
	expect(routePath(render({ route: "go" }))).not.toEqual(
		routePath(render({ route: "slant" })),
	);
	expect(routePath(render({ preview: false }))).toBeUndefined();
	expect(render({ preview: false })).toContain("PERSONNEL FROM THE LAST SNAP");
});

test("empty personnel and goal-line situations keep valid field coordinates", () => {
	const html = render({
		offense: [],
		defense: [],
		snapshot: { ...snapshot, scrimmage: 99, toGo: 1 },
	});
	expect(html).not.toMatch(/NaN|Infinity/);
	expect(html).not.toContain("football-coach-player-ring");
	expect(html).toContain("AWY");
});

test("player details do not invent ratings when the league hides them", () => {
	const html = renderToStaticMarkup(
		createElement(CoachPlayerDetails, {
			player: { pid: 1, name: "Test Player", pos: "QB", team: "HOM" },
		}),
	);
	expect(html).toContain("Ratings are hidden in this league.");
	expect(html).not.toContain("football-coach-rating-track");
	expect(html).not.toContain("OVR");
});

test("custom depth-chart receivers remain eligible in their actual field role", () => {
	const player = { id: 102, name: "Test versatile player", pos: "RB" };
	const custom = offense.map((p) =>
		p.id === player.id ? { ...player, slot: "WR1" } : p,
	);
	expect(matchesCoachRole(player, ["WR"], custom)).toBe(true);
	expect(matchesCoachRole(player, ["RB"], custom)).toBe(true);
	expect(matchesCoachRole(player, ["QB"], custom)).toBe(false);
	const pinned = pinCoachPlayer(custom, player, ["WR"]);
	expect(pinned.find((p) => p.id === player.id)?.slot).toBe("WR1");
	expect(pinned).toHaveLength(11);
	expect(new Set(pinned.map((p) => p.id)).size).toBe(11);
});

test("pinning an out-of-position receiver moves him without duplicating personnel", () => {
	const player = { id: 106, name: "Test reserve receiver", pos: "WR" };
	const custom = offense.map((p) =>
		p.id === player.id ? { ...player, slot: "OL1" } : p,
	);
	const pinned = pinCoachPlayer(custom, player, ["WR"]);
	expect(pinned.find((p) => p.id === player.id)?.slot).toBe("WR1");
	expect(pinned.find((p) => p.id === 102)?.slot).toBe("OL1");
	expect(pinned).toHaveLength(11);
	expect(new Set(pinned.map((p) => p.id)).size).toBe(11);
});
