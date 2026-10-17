import type { TeamNum } from "./types.ts";
import type { PlayByPlayEventOutput } from "../worker/core/GameSim.football/PlayByPlayLogger.ts";
import type {
	FootballCoachCallId,
	FootballCoachDefenseId,
	FootballCoachFormation,
	FootballCoachRoute,
} from "./footballCoachPlaybook.ts";

export type FootballCoachPlay =
	| "run"
	| "pass"
	| "kneel"
	| "spike"
	| "punt"
	| "fieldGoal"
	| "kickoff"
	| "onsideKick"
	| "extraPoint"
	| "twoPointConversion";

export type FootballCoachDecision = {
	play?: FootballCoachPlay | "auto";
	callId?: FootballCoachCallId;
	targetPid?: number;
	runnerPid?: number;
	route?: FootballCoachRoute;
	defenseId?: FootballCoachDefenseId;
	timeout?: TeamNum;
	tempo?: "normal" | "hurryUp" | "chewClock";
};

export type FootballCoachEligiblePlayer = {
	id: number;
	name: string;
	pos: string;
	energy: number;
	injured: boolean;
};
export type FootballCoachLineupPlayer = {
	id: number;
	name: string;
	pos: string;
	slot: string;
};
export type FootballCoachLastCall = {
	callId?: FootballCoachCallId;
	name: string;
	play: "run" | "pass" | "spike";
	route?: FootballCoachRoute;
	targetPid?: number;
	runnerPid?: number;
	passerPid?: number;
	defenseId?: FootballCoachDefenseId;
	rusherPids?: number[];
	coveragePids?: number[];
	referenceProfile?: string;
	referenceSampleSize?: number;
};

export type FootballCoachSnapshot = {
	gid: number;
	stage: "play" | "clock";
	controlledTeam?: TeamNum;
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
	allowedCallIds?: FootballCoachCallId[];
	allowedDefenseIds?: FootballCoachDefenseId[];
	eligibleReceivers?: FootballCoachEligiblePlayer[];
	eligibleRushers?: FootballCoachEligiblePlayer[];
	lineups?: {
		offense: Record<FootballCoachFormation, FootballCoachLineupPlayer[]>;
		defense: Record<FootballCoachDefenseId, FootballCoachLineupPlayer[]>;
	};
	lastCall?: FootballCoachLastCall;
	/** Recent native events, excluding the high-volume stat updates. */
	events: PlayByPlayEventOutput[];
	playersOnField: [
		{ id: number; name: string; pos: string }[],
		{ id: number; name: string; pos: string }[],
	];
};
