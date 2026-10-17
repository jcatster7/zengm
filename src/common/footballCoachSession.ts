import type { FootballCoachSnapshot } from "./footballCoach.ts";
import type { TeamNum } from "./types.ts";

export type FootballCoachSession = {
	sessionId: string;
	lid: number;
	gid: number;
	revision: number;
	status: "starting" | "waiting" | "running" | "saving" | "complete" | "error";
	snapshot?: FootballCoachSnapshot;
	teams: [FootballCoachTeam, FootballCoachTeam];
	controlledTeam: TeamNum;
	controlledTid: number;
	rosters?: [FootballCoachRosterPlayer[], FootballCoachRosterPlayer[]];
	reference?: {
		status: "loaded" | "fallback";
		seasons?: number[];
		message?: string;
	};
	error?: string;
	requiresRecovery?: boolean;
	boxScoreUrl?: string;
};

export type FootballCoachRosterPlayer = {
	pid: number;
	name: string;
	pos: string;
	team: string;
	birthYear?: number;
	jerseyNumber?: string;
	ovr?: number;
	ratings?: Record<string, number>;
	injury?: string;
};

export type FootballCoachTeam = {
	tid: number;
	abbrev: string;
	region: string;
	name: string;
	colors: string[];
	imgURL?: string;
	imgURLSmall?: string;
};
