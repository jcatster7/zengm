import { PHASE } from "../../common/constants.ts";
import { draft, game, season, trade } from "../core/index.ts";
import { idb } from "../db/index.ts";
import {
	g,
	helpers,
	toUI,
	updateStatus,
	lock,
	updatePlayMenu,
} from "../util/index.ts";
import type { Conditions, TradeTeams } from "../../common/types.ts";
import type { FootballCoachDecision } from "../../common/footballCoach.ts";
import type { FootballCoachTeam } from "../../common/footballCoachSession.ts";
import { footballCoach } from "../core/game/footballCoach.ts";

type TradeForOptions = {
	dpid?: number;
	pid?: number;
	otherDpids?: number[];
	otherPids?: number[];
	tid?: number;
	userDpids?: number[];
	userPids?: number[];
};

const tradeFor = async (arg: TradeForOptions, conditions: Conditions) => {
	let teams: TradeTeams | undefined;

	if (arg.pid !== undefined) {
		const p = await idb.cache.players.get(arg.pid);

		if (!p || p.tid < 0) {
			return;
		}

		// Start new trade for a single player, like a Trade For button
		teams = [
			{
				tid: g.get("userTid"),
				pids: [],
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
			{
				tid: p.tid,
				pids: [arg.pid],
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
		];
	} else if (arg.dpid !== undefined) {
		const dp = await idb.cache.draftPicks.get(arg.dpid);

		if (!dp) {
			return;
		}

		// Start new trade for a single player, like a Trade For button
		teams = [
			{
				tid: g.get("userTid"),
				pids: [],
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
			{
				tid: dp.tid,
				pids: [],
				pidsExcluded: [],
				dpids: [arg.dpid],
				dpidsExcluded: [],
			},
		];
	} else if (
		arg.userPids &&
		arg.userDpids &&
		arg.otherPids &&
		arg.otherDpids &&
		arg.tid !== undefined
	) {
		// Start a new trade with everything specified, from the trading block
		teams = [
			{
				tid: g.get("userTid"),
				pids: arg.userPids,
				pidsExcluded: [],
				dpids: arg.userDpids,
				dpidsExcluded: [],
			},
			{
				tid: arg.tid,
				pids: arg.otherPids,
				pidsExcluded: [],
				dpids: arg.otherDpids,
				dpidsExcluded: [],
			},
		];
	} else if (arg.tid !== undefined) {
		// Start trade with team, like from League Finances
		teams = [
			{
				tid: g.get("userTid"),
				pids: [],
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
			{
				tid: arg.tid,
				pids: [],
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
		];
	}

	// Start a new trade based on a list of pids and dpids, like from the trading block
	if (teams) {
		await trade.create(teams);
		toUI("realtimeUpdate", [[], helpers.leagueUrl(["trade"])], conditions);
	}
};

export const runDraft = async (
	action: Parameters<typeof draft.runPicks>[0],
	conditions: Conditions,
) => {
	if (
		g.get("phase") === PHASE.DRAFT ||
		g.get("phase") === PHASE.FANTASY_DRAFT ||
		g.get("phase") === PHASE.EXPANSION_DRAFT
	) {
		await updateStatus("Draft in progress...");
		await draft.runPicks(action, conditions);
	}
};

const untilPick = async (dpid: number, conditions: Conditions) => {
	await runDraft({ type: "untilPick", dpid }, conditions);
};

const addToTradingBlock = (
	// Require at least one of pids or dpids
	param:
		| {
				pids: number[];
				dpids?: number[];
		  }
		| {
				pids?: number[];
				dpids: number[];
		  },
	conditions: Conditions,
) => {
	toUI(
		"realtimeUpdate",
		[[], helpers.leagueUrl(["trading_block"]), param],
		conditions,
	);
};

const liveGame = async (gid: number, conditions: Conditions) => {
	await toUI(
		"realtimeUpdate",
		[
			[],
			helpers.leagueUrl(["live_game"]),
			{
				fromAction: true,
			},
		],
		conditions,
	);
	game.play(1, conditions, true, gid, true);
};

const simGame = async (gid: number, conditions: Conditions) => {
	await game.play(1, conditions, true, gid);
};

const interactiveGame = async (gid: number, conditions: Conditions) => {
	if (__SPORT !== "football") {
		throw new Error("Play calling is available for football games.");
	}
	if (!Number.isSafeInteger(gid) || gid < 0) {
		throw new Error("Invalid game ID.");
	}
	if (footballCoach.isActive()) {
		const session = footballCoach.get(g.get("lid"));
		if (session?.gid !== gid) {
			throw new Error("Finish the current coached game first.");
		}
		await toUI(
			"realtimeUpdate",
			[
				[],
				helpers.leagueUrl(["live_game"]),
				{ fromAction: true, interactiveFootball: true },
			],
			conditions,
		);
		return;
	}
	const phase = g.get("phase");
	if (
		phase !== PHASE.REGULAR_SEASON &&
		phase !== PHASE.AFTER_TRADE_DEADLINE &&
		phase !== PHASE.PLAYOFFS
	) {
		throw new Error(
			"Play calling requires a scheduled regular-season or playoff game.",
		);
	}
	const lid = g.get("lid");
	const seasonNumber = g.get("season");
	let reserved = false;
	let started = false;
	try {
		const scheduled = (await season.getSchedule(true)).find(
			(item) => item.gid === gid,
		);
		if (g.get("lid") !== lid) {
			throw new Error("The league changed before the game started.");
		}
		if (!scheduled || scheduled.homeTid < 0 || scheduled.awayTid < 0) {
			throw new Error(
				"Choose a normal matchup from the current week's schedule.",
			);
		}
		if (scheduled.forceWin !== undefined) {
			throw new Error(
				"Clear Force win before calling plays. Quick sim still supports forced results.",
			);
		}
		const getCoachTeam = async (tid: number): Promise<FootballCoachTeam> => {
			const info = await idb.cache.teams.get(tid);
			if (!info) {
				throw new Error("A scheduled team is unavailable.");
			}
			return {
				tid,
				abbrev: info.abbrev,
				region: info.region,
				name: info.name,
				colors: info.colors,
				imgURL: info.imgURL,
				imgURLSmall: info.imgURLSmall,
			};
		};
		const teams = await Promise.all([
			getCoachTeam(scheduled.homeTid),
			getCoachTeam(scheduled.awayTid),
		]);
		if (
			g.get("lid") !== lid ||
			g.get("season") !== seasonNumber ||
			g.get("phase") !== phase
		) {
			throw new Error(
				"The league or season advanced before the game started. Refresh the schedule.",
			);
		}
		// Read-only preparation precedes reservation. From this point through
		// track(), no await can let another action switch leagues or start a game.
		if (!lock.canStartGames()) {
			throw new Error("Another simulation is already running.");
		}
		reserved = true;
		footballCoach.start({ lid, gid, teams });
		started = true;
		// Keep one continuation through the existing native result-saving path.
		// No submit/finalize endpoint accepts a client-generated score or stats.
		// Register the continuation before yielding so a league switch can await it
		// even while navigation and roster preparation are still in progress.
		const completion = (async () => {
			await lock.set("stopGameSim", false);
			await toUI(
				"realtimeUpdate",
				[
					[],
					helpers.leagueUrl(["live_game"]),
					{ fromAction: true, interactiveFootball: true },
				],
				conditions,
			);
			await game.play(1, conditions, false, gid, true, (snapshot) => {
				if (g.get("lid") !== lid) {
					throw new Error("The league changed during the coached game.");
				}
				return footballCoach.next(lid, snapshot);
			});
			const result = await idb.merged.games.get(gid);
			if (!result) {
				throw new Error(
					"The game did not start. Check roster-size requirements and the current schedule.",
				);
			}
			footballCoach.complete(
				lid,
				helpers.leagueUrl([
					"game_log",
					`${teams[0].abbrev}_${teams[0].tid}`,
					seasonNumber,
					gid,
				]),
			);
		})().catch(async (error: unknown) => {
			footballCoach.fail(lid, error);
			// Never rerun a failed save: native writes might already have started.
			await lock.set("gameSim", false);
			await updateStatus();
			await updatePlayMenu();
		});
		footballCoach.track(completion);
	} catch (error) {
		if (started) {
			footballCoach.fail(lid, error);
		}
		if (reserved && g.get("lid") === lid) {
			await lock.set("gameSim", false);
			await updatePlayMenu();
		}
		throw error;
	}
};

const getFootballCoach = () => footballCoach.get(g.get("lid"));
const submitFootballCoach = (input: {
	sessionId: string;
	revision: number;
	decision: FootballCoachDecision;
}) => footballCoach.submit(g.get("lid"), input);
const finishFootballCoach = ({ sessionId }: { sessionId: string }) =>
	footballCoach.automate(g.get("lid"), sessionId, "end");
const skipFootballCoach = ({
	sessionId,
	until,
}: {
	sessionId: string;
	until: "twoMinute";
}) => {
	if (until !== "twoMinute") {
		throw new Error("Invalid simulation target.");
	}
	footballCoach.automate(g.get("lid"), sessionId, until);
};

const simToGame = async (gid: number, conditions: Conditions) => {
	const numDays = await season.getDaysLeftSchedule(gid);
	await updateStatus("Playing..."); // For quick UI updating, before game.play
	await game.play(numDays, conditions);
};

export default {
	addToTradingBlock,
	liveGame,
	interactiveGame,
	getFootballCoach,
	submitFootballCoach,
	finishFootballCoach,
	skipFootballCoach,
	simGame,
	simToGame,
	tradeFor,
	untilPick,
};
