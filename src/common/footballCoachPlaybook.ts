import type { Position } from "./types.football.ts";
import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "./footballCoach.ts";

// These are transparent game-design profiles for this fork, not measured NFL
// probabilities. The native football engine resolves their personnel and ratings.
export const FOOTBALL_COACH_PERSONNEL = {
	"11": {
		name: "11 personnel",
		positions: { QB: 1, RB: 1, WR: 3, TE: 1, OL: 5 },
	},
	"12": {
		name: "12 personnel",
		positions: { QB: 1, RB: 1, WR: 2, TE: 2, OL: 5 },
	},
	"21": {
		name: "21 personnel",
		positions: { QB: 1, RB: 2, WR: 2, TE: 1, OL: 5 },
	},
	"13": {
		name: "13 personnel",
		positions: { QB: 1, RB: 1, WR: 1, TE: 3, OL: 5 },
	},
} as const;

export type FootballCoachFormation = keyof typeof FOOTBALL_COACH_PERSONNEL;

export const FOOTBALL_COACH_ROUTES = [
	{
		id: "screen",
		name: "Screen",
		depth: -1,
		spread: 3,
		seconds: 2,
		shape: [
			[0, 0],
			[0, -1],
			[5, -1],
		],
	},
	{
		id: "flat",
		name: "Flat",
		depth: 2,
		spread: 3,
		seconds: 2,
		shape: [
			[0, 0],
			[5, 2],
			[10, 2],
		],
	},
	{
		id: "slant",
		name: "Slant",
		depth: 6,
		spread: 4,
		seconds: 2.5,
		shape: [
			[0, 0],
			[0, 3],
			[-7, 8],
		],
	},
	{
		id: "hitch",
		name: "Hitch",
		depth: 5,
		spread: 3,
		seconds: 2.5,
		shape: [
			[0, 0],
			[0, 7],
			[-1, 5],
		],
	},
	{
		id: "out",
		name: "Out",
		depth: 7,
		spread: 4,
		seconds: 3,
		shape: [
			[0, 0],
			[0, 7],
			[8, 7],
		],
	},
	{
		id: "cross",
		name: "Cross",
		depth: 4,
		spread: 5,
		seconds: 3,
		shape: [
			[0, 0],
			[-2, 4],
			[-15, 4],
		],
	},
	{
		id: "stick",
		name: "Stick",
		depth: 6,
		spread: 3,
		seconds: 2.5,
		shape: [
			[0, 0],
			[0, 6],
			[3, 6],
		],
	},
	{
		id: "curl",
		name: "Curl",
		depth: 10,
		spread: 4,
		seconds: 3.5,
		shape: [
			[0, 0],
			[0, 12],
			[-2, 10],
		],
	},
	{
		id: "dig",
		name: "Dig",
		depth: 13,
		spread: 5,
		seconds: 4,
		shape: [
			[0, 0],
			[0, 13],
			[-10, 13],
		],
	},
	{
		id: "seam",
		name: "Seam",
		depth: 17,
		spread: 6,
		seconds: 4,
		shape: [
			[0, 0],
			[1, 7],
			[2, 23],
		],
	},
	{
		id: "corner",
		name: "Corner",
		depth: 20,
		spread: 7,
		seconds: 4.5,
		shape: [
			[0, 0],
			[0, 10],
			[10, 24],
		],
	},
	{
		id: "post",
		name: "Post",
		depth: 23,
		spread: 8,
		seconds: 4.5,
		shape: [
			[0, 0],
			[0, 10],
			[-10, 27],
		],
	},
	{
		id: "go",
		name: "Go",
		depth: 29,
		spread: 10,
		seconds: 5,
		shape: [
			[0, 0],
			[0, 12],
			[0, 35],
		],
	},
] as const;

export type FootballCoachRoute = (typeof FOOTBALL_COACH_ROUTES)[number]["id"];
export type FootballCoachRunStyle =
	| "inside"
	| "outside"
	| "power"
	| "counter"
	| "draw"
	| "toss"
	| "sneak"
	| "qbPower"
	| "reverse";

export type FootballCoachCallDefinition = {
	id: string;
	name: string;
	group: "run" | "pass" | "rpo" | "trick";
	description: string;
	formation: FootballCoachFormation;
	kind: "run" | "pass" | "option";
	route?: FootballCoachRoute;
	runnerPosition?: "RB" | "QB" | "WR";
	runStyle?: FootballCoachRunStyle;
	targetPositions?: readonly ("WR" | "TE" | "RB")[];
	protection?: "standard" | "max" | "screen";
	setupSeconds?: number;
	passerPosition?: "RB";
};

export const FOOTBALL_COACH_CALLS = [
	{
		id: "insideZone",
		name: "Inside zone",
		group: "run",
		description: "Running back attacks the interior behind five linemen.",
		formation: "11",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "inside",
	},
	{
		id: "outsideZone",
		name: "Outside zone",
		group: "run",
		description:
			"Running back stretches the edge; speed and perimeter blocking matter.",
		formation: "11",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "outside",
	},
	{
		id: "power",
		name: "Power",
		group: "run",
		description: "Three tight ends supply a heavier blocking group.",
		formation: "13",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "power",
	},
	{
		id: "counter",
		name: "Counter",
		group: "run",
		description: "Two backs, a delayed handoff, and a wider outcome spread.",
		formation: "21",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "counter",
		setupSeconds: 1,
	},
	{
		id: "draw",
		name: "Draw",
		group: "run",
		description:
			"Delayed handoff exploits a pass-rushing front, with extra setup time.",
		formation: "11",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "draw",
		setupSeconds: 2,
	},
	{
		id: "toss",
		name: "Toss",
		group: "run",
		description: "Two backs attack outside behind the lead back and tight end.",
		formation: "21",
		kind: "run",
		runnerPosition: "RB",
		runStyle: "toss",
		setupSeconds: 1,
	},
	{
		id: "qbSneak",
		name: "QB sneak",
		group: "run",
		description:
			"Quarterback follows the interior line for a short, low-variance gain.",
		formation: "13",
		kind: "run",
		runnerPosition: "QB",
		runStyle: "sneak",
	},
	{
		id: "qbPower",
		name: "QB power",
		group: "run",
		description:
			"Designed quarterback run with two backs available as blockers.",
		formation: "21",
		kind: "run",
		runnerPosition: "QB",
		runStyle: "qbPower",
	},
	{
		id: "slant",
		name: "Slants",
		group: "pass",
		description: "Quick inside-breaking receiver target.",
		formation: "11",
		kind: "pass",
		route: "slant",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "hitch",
		name: "Hitch",
		group: "pass",
		description: "Quick receiver stop route.",
		formation: "11",
		kind: "pass",
		route: "hitch",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "quickOut",
		name: "Quick out",
		group: "pass",
		description: "A short receiver break toward the sideline.",
		formation: "11",
		kind: "pass",
		route: "out",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "drag",
		name: "Drag",
		group: "pass",
		description: "A shallow crossing target with room after the catch.",
		formation: "12",
		kind: "pass",
		route: "cross",
		targetPositions: ["WR", "TE"],
		protection: "standard",
	},
	{
		id: "stick",
		name: "Stick",
		group: "pass",
		description: "A short tight-end option from two-tight-end personnel.",
		formation: "12",
		kind: "pass",
		route: "stick",
		targetPositions: ["TE"],
		protection: "standard",
	},
	{
		id: "curl",
		name: "Curl",
		group: "pass",
		description: "An intermediate receiver stop route.",
		formation: "11",
		kind: "pass",
		route: "curl",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "dig",
		name: "Dig",
		group: "pass",
		description: "An intermediate inside break requiring more protection time.",
		formation: "11",
		kind: "pass",
		route: "dig",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "seam",
		name: "Seam",
		group: "pass",
		description: "A tight end attacks vertically between coverage defenders.",
		formation: "12",
		kind: "pass",
		route: "seam",
		targetPositions: ["TE"],
		protection: "standard",
	},
	{
		id: "corner",
		name: "Corner",
		group: "pass",
		description: "A deep outside break from heavier personnel.",
		formation: "12",
		kind: "pass",
		route: "corner",
		targetPositions: ["WR", "TE"],
		protection: "max",
	},
	{
		id: "post",
		name: "Post",
		group: "pass",
		description: "A deep inside break with additional pass protection.",
		formation: "21",
		kind: "pass",
		route: "post",
		targetPositions: ["WR"],
		protection: "max",
	},
	{
		id: "go",
		name: "Go route",
		group: "pass",
		description:
			"A vertical receiver target; longer protection time and deeper throw.",
		formation: "11",
		kind: "pass",
		route: "go",
		targetPositions: ["WR"],
		protection: "max",
	},
	{
		id: "rbScreen",
		name: "RB screen",
		group: "pass",
		description: "A quick throw behind the line to a running back.",
		formation: "21",
		kind: "pass",
		route: "screen",
		targetPositions: ["RB"],
		protection: "screen",
	},
	{
		id: "wrScreen",
		name: "WR screen",
		group: "pass",
		description: "A quick perimeter throw to a wide receiver.",
		formation: "11",
		kind: "pass",
		route: "screen",
		targetPositions: ["WR"],
		protection: "screen",
	},
	{
		id: "zoneBubble",
		name: "Zone / bubble",
		group: "rpo",
		description: "Read the box: inside handoff or receiver screen.",
		formation: "11",
		kind: "option",
		runnerPosition: "RB",
		runStyle: "inside",
		route: "screen",
		targetPositions: ["WR"],
		protection: "screen",
	},
	{
		id: "zoneSlant",
		name: "Zone / slant",
		group: "rpo",
		description: "Read the front and coverage: inside handoff or slant.",
		formation: "11",
		kind: "option",
		runnerPosition: "RB",
		runStyle: "inside",
		route: "slant",
		targetPositions: ["WR"],
		protection: "standard",
	},
	{
		id: "zoneFlat",
		name: "Zone / flat",
		group: "rpo",
		description: "Read the front: inside handoff or tight-end flat route.",
		formation: "12",
		kind: "option",
		runnerPosition: "RB",
		runStyle: "inside",
		route: "flat",
		targetPositions: ["TE"],
		protection: "standard",
	},
	{
		id: "reverse",
		name: "Reverse",
		group: "trick",
		description: "A wide receiver becomes the runner after a longer exchange.",
		formation: "11",
		kind: "run",
		runnerPosition: "WR",
		runStyle: "reverse",
		setupSeconds: 2,
	},
	{
		id: "fleaFlicker",
		name: "Flea flicker",
		group: "trick",
		description: "Quarterback throws deep after a delayed backfield exchange.",
		formation: "21",
		kind: "pass",
		route: "post",
		targetPositions: ["WR"],
		protection: "max",
		setupSeconds: 2,
	},
	{
		id: "halfbackPass",
		name: "Halfback pass",
		group: "trick",
		description:
			"The running back throws; his passing ratings and statistics apply.",
		formation: "21",
		kind: "pass",
		route: "corner",
		targetPositions: ["WR", "TE"],
		protection: "max",
		setupSeconds: 1,
		passerPosition: "RB",
	},
] as const satisfies readonly FootballCoachCallDefinition[];

export type FootballCoachCallId = (typeof FOOTBALL_COACH_CALLS)[number]["id"];

export const FOOTBALL_COACH_DEFENSES = [
	{
		id: "base43",
		name: "4–3 zone",
		description: "Four linemen rush; three linebackers cover the middle.",
		positions: { DL: 4, LB: 3, CB: 2, S: 2 },
		rushers: 4,
		coverage: "zone",
	},
	{
		id: "base34",
		name: "3–4 zone",
		description: "Three linemen and one linebacker rush.",
		positions: { DL: 3, LB: 4, CB: 2, S: 2 },
		rushers: 4,
		coverage: "zone",
	},
	{
		id: "nickel",
		name: "Nickel man",
		description:
			"Five defensive backs; target position determines the coverage matchup.",
		positions: { DL: 4, LB: 2, CB: 3, S: 2 },
		rushers: 4,
		coverage: "man",
	},
	{
		id: "dime",
		name: "Dime prevent",
		description:
			"Six defensive backs protect deeper targets at the expense of the run front.",
		positions: { DL: 4, LB: 1, CB: 4, S: 2 },
		rushers: 4,
		coverage: "prevent",
	},
	{
		id: "blitz",
		name: "Six-man pressure",
		description:
			"Three linemen and three linebackers rush, leaving five in coverage.",
		positions: { DL: 3, LB: 4, CB: 2, S: 2 },
		rushers: 6,
		coverage: "man",
	},
	{
		id: "goalLine",
		name: "Goal-line front",
		description: "Five linemen and three linebackers defend short yardage.",
		positions: { DL: 5, LB: 3, CB: 2, S: 1 },
		rushers: 5,
		coverage: "zone",
	},
] as const satisfies readonly {
	id: string;
	name: string;
	description: string;
	positions: Partial<Record<Position, number>>;
	rushers: number;
	coverage: "zone" | "man" | "prevent";
}[];

export type FootballCoachDefenseId =
	(typeof FOOTBALL_COACH_DEFENSES)[number]["id"];

export const FOOTBALL_COACH_DEFAULT_DEFENSES: Record<
	FootballCoachFormation,
	FootballCoachDefenseId
> = {
	"11": "nickel",
	"12": "base43",
	"21": "base34",
	"13": "goalLine",
};

export const getFootballCoachCall = (
	id: FootballCoachCallId,
): FootballCoachCallDefinition =>
	FOOTBALL_COACH_CALLS.find((call) => call.id === id)!;
export const getFootballCoachRoute = (id: FootballCoachRoute) =>
	FOOTBALL_COACH_ROUTES.find((route) => route.id === id)!;
export const getFootballCoachDefense = (id: FootballCoachDefenseId) =>
	FOOTBALL_COACH_DEFENSES.find((defense) => defense.id === id)!;

export const validateFootballCoachDecision = (
	decision: FootballCoachDecision | undefined,
	snapshot: FootballCoachSnapshot,
) => {
	if (decision === undefined) {
		return;
	}
	if (
		!decision ||
		typeof decision !== "object" ||
		Array.isArray(decision) ||
		Object.keys(decision).some(
			(key) =>
				![
					"play",
					"callId",
					"targetPid",
					"runnerPid",
					"route",
					"defenseId",
					"timeout",
					"tempo",
				].includes(key),
		)
	) {
		throw new Error("Invalid coaching decision.");
	}
	if (snapshot.controlledTeam !== undefined) {
		const ownOffense = snapshot.offense === snapshot.controlledTeam;
		if (
			(!ownOffense &&
				(decision.callId !== undefined ||
					decision.targetPid !== undefined ||
					decision.runnerPid !== undefined ||
					decision.route !== undefined ||
					(decision.play !== undefined && decision.play !== "auto") ||
					decision.tempo !== undefined)) ||
			(ownOffense && decision.defenseId !== undefined) ||
			(decision.timeout !== undefined &&
				decision.timeout !== snapshot.controlledTeam)
		) {
			throw new Error("You can only coach your own team.");
		}
	}
	if (snapshot.stage === "clock") {
		if (
			[
				decision.play,
				decision.callId,
				decision.targetPid,
				decision.runnerPid,
				decision.route,
				decision.defenseId,
			].some((value) => value !== undefined) ||
			(decision.timeout !== undefined &&
				((decision.timeout !== 0 && decision.timeout !== 1) ||
					!snapshot.canTimeout[decision.timeout])) ||
			(decision.tempo !== undefined &&
				!["normal", "hurryUp", "chewClock"].includes(decision.tempo))
		) {
			throw new Error(
				"That clock decision is unavailable in the current situation.",
			);
		}
		return;
	}
	if (
		decision.timeout !== undefined ||
		decision.tempo !== undefined ||
		(decision.play !== undefined &&
			decision.play !== "auto" &&
			!snapshot.allowedPlays.includes(decision.play))
	) {
		throw new Error("That play is unavailable in this situation.");
	}
	const call =
		decision.callId !== undefined
			? (FOOTBALL_COACH_CALLS.find((entry) => entry.id === decision.callId) as
					| FootballCoachCallDefinition
					| undefined)
			: undefined;
	if (
		decision.callId !== undefined &&
		(!call ||
			!snapshot.allowedCallIds?.includes(decision.callId) ||
			(decision.play !== undefined && decision.play !== "auto"))
	) {
		throw new Error("That tactical call is unavailable in this situation.");
	}
	const kind = call?.kind ?? decision.play;
	const fillsRole = (id: number, positions: readonly string[]) =>
		snapshot.lineups?.offense[call?.formation ?? "11"].some(
			(p) => p.id === id && positions.includes(p.slot.replace(/\d+$/, "")),
		);
	if (
		decision.targetPid !== undefined &&
		decision.targetPid === decision.runnerPid
	) {
		throw new Error(
			"Receiver and runner assignments require different players.",
		);
	}
	if (
		decision.defenseId !== undefined &&
		(!snapshot.allowedDefenseIds?.includes(decision.defenseId) ||
			!snapshot.allowedPlays.includes("run") ||
			(kind !== undefined && !["run", "pass", "option", "auto"].includes(kind)))
	) {
		throw new Error("That defensive package is unavailable in this situation.");
	}
	if (
		decision.route !== undefined &&
		((kind !== "pass" && kind !== "option") ||
			!FOOTBALL_COACH_ROUTES.some((route) => route.id === decision.route))
	) {
		throw new Error("Choose a passing call before assigning a route.");
	}
	if (decision.targetPid !== undefined) {
		const target = snapshot.eligibleReceivers?.find(
			(p) => p.id === decision.targetPid && !p.injured,
		);
		if (
			!Number.isInteger(decision.targetPid) ||
			(kind !== "pass" && kind !== "option") ||
			!target ||
			(call?.targetPositions &&
				!call.targetPositions.includes(target.pos as "WR" | "TE" | "RB") &&
				!fillsRole(target.id, call.targetPositions))
		) {
			throw new Error("That receiver is unavailable for this call.");
		}
	}
	if (decision.runnerPid !== undefined) {
		const runner = snapshot.eligibleRushers?.find(
			(p) => p.id === decision.runnerPid && !p.injured,
		);
		if (
			!Number.isInteger(decision.runnerPid) ||
			(kind !== "run" && kind !== "option") ||
			!runner ||
			(call?.runnerPosition &&
				runner.pos !== call.runnerPosition &&
				!fillsRole(runner.id, [call.runnerPosition]))
		) {
			throw new Error("That runner is unavailable for this call.");
		}
	}
};
