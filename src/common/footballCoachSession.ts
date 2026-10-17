import type { FootballCoachSnapshot } from "./footballCoach.ts";

export type FootballCoachSession = {
	sessionId: string;
	lid: number;
	gid: number;
	revision: number;
	status: "starting" | "waiting" | "running" | "saving" | "complete" | "error";
	snapshot?: FootballCoachSnapshot;
	teams: [FootballCoachTeam, FootballCoachTeam];
	error?: string;
	requiresRecovery?: boolean;
	boxScoreUrl?: string;
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
