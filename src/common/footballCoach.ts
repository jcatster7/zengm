import type { TeamNum } from "./types.ts";
import type { PlayByPlayEventOutput } from "../worker/core/GameSim.football/PlayByPlayLogger.ts";

export type FootballCoachPlay =
	| "run"
	| "pass"
	| "kneel"
	| "punt"
	| "fieldGoal"
	| "kickoff"
	| "onsideKick"
	| "extraPoint"
	| "twoPointConversion";

export type FootballCoachDecision = {
	play?: FootballCoachPlay | "auto";
	timeout?: TeamNum;
	tempo?: "normal" | "hurryUp" | "chewClock";
};

export type FootballCoachSnapshot = {
	gid: number;
	stage: "play" | "clock";
	quarter: number;
	numPeriods: number;
	/** Minutes remaining, matching the native football simulation. */
	clock: number;
	down: number;
	toGo: number;
	/** Distance from the offense's own goal line. */
	scrimmage: number;
	/** Home is 0, away is 1. On a kickoff, offense is the kicking team. */
	offense: TeamNum;
	defense: TeamNum;
	teams: [
		{ id: number; pts: number; sPts?: number },
		{ id: number; pts: number; sPts?: number },
	];
	timeouts: [number, number];
	canTimeout: [boolean, boolean];
	awaitingKickoff: TeamNum | undefined;
	awaitingAfterTouchdown: boolean;
	isClockRunning: boolean;
	allowedPlays: FootballCoachPlay[];
	/** Recent native events, excluding the high-volume stat updates. */
	events: PlayByPlayEventOutput[];
	playersOnField: [
		{ id: number; name: string; pos: string }[],
		{ id: number; name: string; pos: string }[],
	];
};
