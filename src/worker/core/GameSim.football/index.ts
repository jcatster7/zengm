import { g, helpers } from "../../util/index.ts";
import { FATIGUE_POS, POSITIONS } from "../../../common/constants.football.ts";
import PlayByPlayLogger, {
	type PlayByPlayEventScore,
} from "./PlayByPlayLogger.ts";
import {
	getBlockingFactors,
	getCompositeFactor,
	type CompositeFactorParams,
} from "./getCompositeFactor.ts";
import getPlayers from "./getPlayers.ts";
import formations from "./formations.ts";
import { penaltiesByPlayType } from "./penalties.ts";
import type { Position } from "../../../common/types.football.ts";
import type {
	CompositeRating,
	PenaltyPlayType,
	PlayerGameSim,
	PlayersOnField,
	TeamGameSim,
	Formation,
} from "./types.ts";
import getInjuryRate from "../GameSim.basketball/getInjuryRate.ts";
import Play, {
	SCRIMMAGE_EXTRA_POINT,
	SCRIMMAGE_KICKOFF,
	SCRIMMAGE_TWO_POINT_CONVERSION,
} from "./Play.ts";
import LngTracker from "./LngTracker.ts";
import GameSimBase from "../GameSim/GameSimBase.ts";
import { PHASE, STARTING_NUM_TIMEOUTS } from "../../../common/constants.ts";
import type { TeamNum } from "../../../common/types.ts";
import type {
	FootballCoachDecision,
	FootballCoachPlay,
	FootballCoachSnapshot,
	FootballCoachLastCall,
	FootballCoachLineupPlayer,
	FootballCoachBoxScore,
	FootballCoachBoxScoreTeam,
} from "../../../common/footballCoach.ts";
import {
	FOOTBALL_COACH_CALLS,
	FOOTBALL_COACH_DEFENSES,
	FOOTBALL_COACH_DEFAULT_DEFENSES,
	FOOTBALL_COACH_PERSONNEL,
	getFootballCoachCall,
	getFootballCoachDefense,
	getFootballCoachRoute,
	validateFootballCoachDecision,
	type FootballCoachCallDefinition,
	type FootballCoachDefenseId,
	type FootballCoachFormation,
} from "../../../common/footballCoachPlaybook.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";
import {
	choice,
	randInt,
	shuffle,
	truncGauss,
} from "../../../common/random.ts";

const teamNums: [TeamNum, TeamNum] = [0, 1];

type CoachPause = {
	stage: FootballCoachSnapshot["stage"];
	clock?: number;
};

type CoachTactics = {
	decision: FootballCoachDecision;
	call?: FootballCoachCallDefinition;
	formation: FootballCoachFormation;
	defense: ReturnType<typeof getFootballCoachDefense>;
	route?: ReturnType<typeof getFootballCoachRoute>;
	rushers: PlayerGameSim[];
	coverage: PlayerGameSim[];
};

// A normal simulation drains the same steps without waiting or changing decisions.
const runAutomatically = <T>(
	steps: Generator<CoachPause, T, FootballCoachDecision | undefined>,
): T => {
	let step = steps.next();
	while (!step.done) {
		step = steps.next(undefined);
	}
	return step.value;
};

const FIELD_GOAL_DISTANCE_YARDS_ADDED_FROM_SCRIMMAGE = 17;

const ESTIMATED_SECONDS_PER_KNEEL = 42;
const ESTIMATED_SECONDS_PER_KNEEL_TIMEOUT = 2;
const YARDS_NEEDED_TO_KNEEL = 3;

const NUM_DOWNS = 4; // Not used everywhere!
const TWO_MINUTE_WARNING_TIME = 2; // Not used everywhere!

const FEWER_INJURIES_POS = new Set(["QB", "P", "K"]);

// Only apples to default ratings leagues
const AVERAGE_TACKLING_COMPOSITE = 0.56;

const COMPOSITE_FACTOR_OPTIONS = {
	receiving: {
		positions: ["WR", "TE", "RB"],
		orderFunc: (p) => p.ovrs.WR,
		weightsMain: [5, 3, 2],
		weightsBonus: [0.5, 0.25],
		valFunc: (p) => p.ovrs.WR / 100,
	},
	rushing: {
		positions: ["RB", "WR", "QB"],
		orderFunc: (p) => p.ovrs.RB,
		weightsMain: [1],
		weightsBonus: [0.1],
		valFunc: (p) => (p.ovrs.RB / 100 + p.compositeRating.rushing) / 2,
	},
	passRushing: {
		positions: ["DL", "LB"],
		orderFunc: (p) => p.ovrs.DL,
		weightsMain: [5, 4, 3, 2, 1],
		weightsBonus: [],
		valFunc: (p) => (p.ovrs.DL / 100 + p.compositeRating.passRushing) / 2,
	},
	runStopping: {
		positions: ["DL", "LB", "S"],
		orderFunc: (p) => p.ovrs.DL,
		weightsMain: [5, 4, 3, 2, 2, 1, 1],
		weightsBonus: [0.5, 0.5],
		valFunc: (p) => (p.ovrs.DL / 100 + p.compositeRating.runStopping) / 2,
	},
	passCoverage: {
		positions: ["CB", "S", "LB"],
		orderFunc: (p) => p.ovrs.CB,
		weightsMain: [5, 4, 3, 2, 1, 1],
		weightsBonus: [0.5, 0.5],
		valFunc: (p) => (p.ovrs.CB / 100 + p.compositeRating.passCoverage) / 2,
	},
	tackling: {
		positions: ["DL", "LB", "S"],
		orderFunc: (p) => p.ovrs.LB,
		weightsMain: [5, 4, 3, 2, 1],
		weightsBonus: [],
		valFunc: (p) => (p.ovrs.LB / 100 + p.compositeRating.tackling) / 2,
	},
} satisfies Record<string, CompositeFactorParams>;

/**
 * Convert energy into fatigue, which can be multiplied by a rating to get a fatigue-adjusted value.
 *
 * @param {number} energy A player's energy level, from 0 to 1 (0 = lots of energy, 1 = none).
 * @return {number} Fatigue, from 0 to 1 (0 = lots of fatigue, 1 = none).
 */
const fatigue = (energy: number, injured: boolean): number => {
	if (injured) {
		return 0;
	}

	energy += 0.05;

	if (energy > 1) {
		energy = 1;
	}

	return energy;
};

class GameSim extends GameSimBase {
	private coachTactics: CoachTactics | undefined;
	private lastCoachCall: FootballCoachLastCall | undefined;
	private coachReference: FootballCoachReference | undefined;
	private coachTeam: TeamNum | undefined;

	setCoachTeam(t: TeamNum) {
		if (t !== 0 && t !== 1) {
			throw new Error("Invalid controlled team.");
		}
		this.coachTeam = t;
	}

	setCoachReference(reference: FootballCoachReference) {
		if (reference.schemaVersion !== 1 || !Array.isArray(reference.profiles)) {
			throw new Error("Unsupported football reference data.");
		}
		this.coachReference = reference;
	}

	private sampleCoachReference(kind: "pass" | "run") {
		const tactics = this.coachTactics;
		if (!tactics?.call || !this.coachReference) {
			return undefined;
		}
		const call = tactics.call;
		const route = tactics.route;
		const family =
			kind === "pass"
				? route?.id === "screen"
					? "passScreen"
					: (route?.depth ?? 8.6) >= 20
						? "passDeep"
						: (route?.depth ?? 8.6) >= 10
							? "passMedium"
							: "passShort"
				: call?.runStyle === "draw"
					? "runDraw"
					: ["outside", "toss", "reverse"].includes(call?.runStyle ?? "")
						? "runOutside"
						: "runInside";
		const candidates = [
			call?.group === "rpo"
				? "rpo"
				: call?.group === "trick"
					? "trick"
					: undefined,
			family,
		].filter((id): id is string => id !== undefined);
		for (const id of candidates) {
			const profile = this.coachReference.profiles.find(
				(entry) => entry.id === id,
			);
			let distribution =
				kind === "pass"
					? profile?.airYardsDistribution
					: profile?.rushYardsDistribution;
			if (!distribution?.length) {
				continue;
			}
			distribution = distribution.filter(
				(entry) =>
					Number.isFinite(entry.yards) &&
					Number.isInteger(entry.count) &&
					entry.count > 0,
			);
			if (kind === "pass" && route) {
				const nearRoute = distribution.filter(
					(entry) =>
						Math.abs(entry.yards - route.depth) <= Math.max(3, route.spread),
				);
				if (nearRoute.reduce((sum, entry) => sum + entry.count, 0) >= 20) {
					distribution = nearRoute;
				}
			}
			if (!distribution.length) {
				continue;
			}
			const sampled = choice(distribution, (entry) => entry.count);
			if (this.lastCoachCall) {
				this.lastCoachCall.referenceProfile = id;
				this.lastCoachCall.referenceSampleSize = profile!.sampleSize;
			}
			return sampled.yards;
		}
		return undefined;
	}

	private chooseCoachPlayer(players: PlayerGameSim[], rating: string) {
		return choice(
			players,
			(p) =>
				Math.max(
					0.001,
					p.compositeRating[rating] * fatigue(p.stat.energy, p.injured),
				) ** 1.5,
		);
	}

	private chooseCoachDefender(target: PlayerGameSim) {
		const tactics = this.coachTactics;
		if (!tactics?.coverage.length) {
			return this.pickPlayer(this.d, "passCoverage", undefined, 2);
		}
		let pool = tactics.coverage;
		if (tactics.defense.coverage === "man") {
			const matched = pool.filter((p) =>
				target.pos === "WR" ? p.pos === "CB" : p.pos === "LB" || p.pos === "S",
			);
			if (matched.length) {
				pool = matched;
			}
		} else if (
			tactics.defense.coverage === "prevent" &&
			(tactics.route?.depth ?? 0) >= 15
		) {
			const safeties = pool.filter((p) => p.pos === "S");
			if (safeties.length) {
				pool = safeties;
			}
		}
		return this.chooseCoachPlayer(pool, "passCoverage");
	}
	team: [TeamGameSim, TeamGameSim];

	playersOnField: [PlayersOnField, PlayersOnField];

	/**
	 * "initialKickoff" -> (right after kickoff) "firstPossession" -> (after next call to possessionChange) -> "secondPossession" -> (after next call to possessionChange) -> "bothTeamPossessed" -> (based on conditions below) "over"
	 * - "initialKickoff", "firstPossession": when touchdown or safety is scored, set state to "over"
	 * - "secondPossession": when any points are scored, if scoring team is winning, set state to "over"
	 * - "bothTeamsPossessed": after each play, if (!this.awaitingAfterTouchdown or point differential is more than 2) then end game if score is not equal, set state to "over"
	 */
	overtimeState:
		| undefined
		| "initialKickoff"
		| "firstPossession"
		| "secondPossession"
		| "bothTeamsPossessed"
		| "over";

	clock: number;

	numPeriods: number;

	isClockRunning = false;

	o: TeamNum;

	d: TeamNum;

	playByPlay: PlayByPlayLogger;

	awaitingAfterTouchdown = false;

	awaitingAfterSafety = false;

	// This is used for drive-based team stats such as "drives" and "totStartYds".
	// Turnover edge cases - two turnovers on the same play means this is not a new drive, but recovering a fumbled punt or an onside kick are new drives.
	// Set this to undefined in situations where it'll be a new drive for either team (such as after a kickoff/punt) but not when it'll be a new drive only for a new team (fumble/interception).
	currentDrive: TeamNum | undefined;

	awaitingKickoff: TeamNum | undefined;
	lastHalfAwaitingKickoff: TeamNum;

	scrimmage = SCRIMMAGE_KICKOFF;

	down = 1;

	toGo = 10;

	timeouts: [number, number] = [STARTING_NUM_TIMEOUTS!, STARTING_NUM_TIMEOUTS!];

	twoMinuteWarningHappened = false;

	currentPlay: Play;

	lngTracker: LngTracker;

	// For penalties at the end of a half
	playUntimedPossession = false;

	twoPointConversionTeam: TeamNum | undefined;

	overtimeType =
		g.get("phase") === PHASE.PLAYOFFS
			? g.get("footballOvertimePlayoffs", "current")
			: g.get("footballOvertime", "current");

	constructor({
		gid,
		day,
		teams,
		doPlayByPlay,
		homeCourtFactor,
		neutralSite,
		allStarGame,
		baseInjuryRate,
	}: {
		gid: number;
		day?: number;
		teams: [TeamGameSim, TeamGameSim];
		doPlayByPlay: boolean;
		homeCourtFactor: number;
		neutralSite: boolean;
		allStarGame: boolean;
		baseInjuryRate: number;
	}) {
		super({
			gid,
			day,
			allStarGame,
			baseInjuryRate,
			neutralSite,
		});

		this.playByPlay = new PlayByPlayLogger(doPlayByPlay);
		this.team = teams; // If a team plays twice in a day, this needs to be a deep copy

		this.playersOnField = [{}, {}];

		// Record "gs" stat for starters
		this.o = 0;
		this.d = 1;
		this.updatePlayersOnField("starters");
		this.o = 1;
		this.d = 0;
		this.updatePlayersOnField("starters");

		this.clock = g.get("quarterLength"); // Game clock, in minutes
		this.numPeriods = g.get("numPeriods");

		this.awaitingKickoff = Math.random() < 0.5 ? 0 : 1;
		this.d = this.awaitingKickoff;
		this.o = this.awaitingKickoff === 0 ? 1 : 0;
		this.lastHalfAwaitingKickoff = this.awaitingKickoff;
		this.currentPlay = new Play(this);
		this.lngTracker = new LngTracker();

		if (!neutralSite) {
			this.homeCourtAdvantage(homeCourtFactor);
		}
	}

	homeCourtAdvantage(homeCourtFactor: number) {
		const homeCourtModifier =
			homeCourtFactor *
			helpers.bound(1 + g.get("homeCourtAdvantage") / 100, 0.01, Infinity);

		for (const t of [0, 1] as const) {
			let factor;

			if (t === 0) {
				factor = homeCourtModifier; // Bonus for home team
			} else {
				factor = 1.0 / homeCourtModifier; // Penalty for away team
			}

			for (const p of this.team[t].player) {
				for (const r of Object.keys(p.compositeRating)) {
					if (r !== "endurance") {
						p.compositeRating[r] *= factor;
					}
				}
			}
		}
	}

	run() {
		return runAutomatically(this.runSteps());
	}

	async runInteractive(
		choose: (
			snapshot: FootballCoachSnapshot,
		) =>
			| FootballCoachDecision
			| undefined
			| Promise<FootballCoachDecision | undefined>,
	) {
		const steps = this.runSteps();
		let step = steps.next();
		while (!step.done) {
			const snapshot = this.getCoachSnapshot(
				step.value.stage,
				step.value.clock,
			);
			const decision = await choose(snapshot);
			this.validateCoachDecision(decision, snapshot);
			step = steps.next(decision);
		}
		return step.value;
	}

	private *runSteps(): Generator<
		CoachPause,
		ReturnType<GameSim["finish"]>,
		FootballCoachDecision | undefined
	> {
		// Simulate the game up to the end of regulation
		yield* this.simRegulationSteps();

		let numOvertimes = 0;
		while (
			this.team[0].stat.pts === this.team[1].stat.pts &&
			numOvertimes < this.maxOvertimes
		) {
			yield* this.simOvertimeSteps();
			numOvertimes += 1;
		}

		this.doShootout();
		return this.finish();
	}

	private finish() {
		this.playByPlay.logEvent({
			type: "gameOver",
			clock: this.clock,
		});

		// Delete stuff that isn't needed before returning
		for (const t of [0, 1] as const) {
			delete this.team[t].compositeRating;
			// @ts-expect-error
			delete this.team[t].pace;

			for (const p of this.team[t].player) {
				// @ts-expect-error
				delete p.age;
				// @ts-expect-error
				delete p.valueNoPot;
				delete p.compositeRating;
				// @ts-expect-error
				delete p.ptModifier;
				delete p.stat.benchTime;
				delete p.stat.courtTime;
				delete p.stat.energy;
			}
		}

		const scoringSummary: PlayByPlayEventScore[] = [];

		// Remove any scores that were negated by penalties
		for (const [i, current] of this.playByPlay.scoringSummary.entries()) {
			const next = this.playByPlay.scoringSummary[i + 1];

			// Must have been reversed by a penalty
			if (next?.type === "removeLastScore") {
				continue;
			}

			// No longer need to store this
			if (current.type === "removeLastScore") {
				continue;
			}

			scoringSummary.push(current);
		}

		const out = {
			gid: this.id,
			day: this.day,
			overtimes: this.overtimes,
			team: this.team,
			clutchPlays: [],
			playByPlay: this.playByPlay.getPlayByPlay(this.team),
			neutralSite: this.neutralSite,
			scoringSummary,
		};
		return out;
	}

	doShootoutShot(t: TeamNum) {
		this.o = t;
		this.d = t === 0 ? 1 : 0;

		this.updatePlayersOnField("fieldGoal");

		const distance = 50;

		const p = this.getTopPlayerOnField(this.o, "K");
		this.scrimmage = distance + FIELD_GOAL_DISTANCE_YARDS_ADDED_FROM_SCRIMMAGE;

		// Don't let it ever be 0% or 100%
		const probMake = helpers.bound(this.probMadeFieldGoal(p), 0.01, 0.99);

		const made = Math.random() < probMake;

		this.recordStat(t, undefined, "sAtt");
		if (made) {
			this.recordStat(t, undefined, "sPts");
		}

		this.playByPlay.logEvent({
			type: "shootoutShot",
			t,
			names: [p.name],
			made,
			att: this.team[t].stat.sAtt,
			yds: distance,
			clock: this.clock,
		});
	}

	doShootout() {
		if (
			this.shootoutRounds <= 0 ||
			this.team[0].stat.pts !== this.team[1].stat.pts
		) {
			return;
		}

		this.shootout = true;
		this.clock = 1; // So fast-forward to end of period stops before the shootout
		this.team[0].stat.sPts = 0;
		this.team[0].stat.sAtt = 0;
		this.team[1].stat.sPts = 0;
		this.team[1].stat.sAtt = 0;

		const reversedTeamNums = [1, 0] as const;

		this.playByPlay.logEvent({
			type: "shootoutStart",
			rounds: this.shootoutRounds,
			clock: this.clock,
		});

		SHOOTOUT_ROUNDS: for (let i = 0; i < this.shootoutRounds; i++) {
			for (const t of reversedTeamNums) {
				this.doShootoutShot(t);

				if (
					this.shouldEndShootoutEarly(t, i, [
						this.team[0].stat.sPts,
						this.team[1].stat.sPts,
					])
				) {
					break SHOOTOUT_ROUNDS;
				}
			}
		}

		if (this.team[0].stat.sPts === this.team[1].stat.sPts) {
			this.playByPlay.logEvent({
				type: "shootoutTie",
				clock: this.clock,
			});

			while (this.team[0].stat.sPts === this.team[1].stat.sPts) {
				for (const t of reversedTeamNums) {
					this.doShootoutShot(t);
				}
			}
		}
	}

	isFirstPeriodAfterHalftime(quarter: number) {
		return this.numPeriods % 2 === 0 && quarter === this.numPeriods / 2 + 1;
	}

	kickoffAfterEndOfPeriod(quarter: number) {
		return (
			this.isFirstPeriodAfterHalftime(quarter + 1) || quarter >= this.numPeriods
		);
	}

	logTimeouts() {
		this.playByPlay.logEvent({
			type: "timeouts",
			timeouts: [...this.timeouts],
		});
	}

	simRegulation() {
		return runAutomatically(this.simRegulationSteps());
	}

	private *simRegulationSteps(): Generator<
		CoachPause,
		void,
		FootballCoachDecision | undefined
	> {
		let quarter = 1;

		while (true) {
			while (
				this.clock > 0 ||
				this.awaitingAfterTouchdown ||
				this.playUntimedPossession
			) {
				yield* this.simPlaySteps();
			}

			// Who gets the ball after halftime?
			if (this.isFirstPeriodAfterHalftime(quarter + 1)) {
				this.timeouts = [3, 3];
				this.logTimeouts();
				this.twoMinuteWarningHappened = false;

				this.d = this.lastHalfAwaitingKickoff === 0 ? 1 : 0;
				this.o = this.lastHalfAwaitingKickoff;
				this.awaitingKickoff = this.d;
				this.lastHalfAwaitingKickoff = this.d;
				this.scrimmage = SCRIMMAGE_KICKOFF;
			} else if (quarter === this.numPeriods) {
				break;
			}

			quarter += 1;

			this.team[0].stat.ptsQtrs.push(0);
			this.team[1].stat.ptsQtrs.push(0);
			this.clock = g.get("quarterLength");
			this.playByPlay.logEvent({
				type: "quarter",
				clock: this.clock,
				quarter,
				startsWithKickoff: this.kickoffAfterEndOfPeriod(quarter - 1),
			});
		}
	}

	simOvertime() {
		return runAutomatically(this.simOvertimeSteps());
	}

	private *simOvertimeSteps(): Generator<
		CoachPause,
		void,
		FootballCoachDecision | undefined
	> {
		this.clock = this.getOvertimeLength();

		this.overtime = true;
		this.overtimes += 1;
		if (this.overtimeState === undefined) {
			// Only set this in first overtime
			this.overtimeState = "initialKickoff";

			// Coin flip in initial overtime
			this.awaitingKickoff = Math.random() < 0.5 ? 0 : 1;
			this.lastHalfAwaitingKickoff = this.awaitingKickoff;
			this.scrimmage = SCRIMMAGE_KICKOFF;
		}
		this.team[0].stat.ptsQtrs.push(0);
		this.team[1].stat.ptsQtrs.push(0);
		this.timeouts = [2, 2];
		this.logTimeouts();
		this.twoMinuteWarningHappened = false;
		this.playByPlay.logEvent({
			type: "overtime",
			clock: this.clock,
			overtimes: this.overtimes,
			startsWithKickoff: this.kickoffAfterEndOfPeriod(
				this.numPeriods + this.overtimes - 1,
			),
		});

		this.d = this.lastHalfAwaitingKickoff === 0 ? 1 : 0;
		this.o = this.lastHalfAwaitingKickoff;
		this.awaitingKickoff = this.d;
		this.lastHalfAwaitingKickoff = this.d;
		this.scrimmage = SCRIMMAGE_KICKOFF;

		while (
			(this.clock > 0 || this.playUntimedPossession) &&
			this.overtimeState !== "over"
		) {
			yield* this.simPlaySteps();
		}
	}

	getTopPlayerOnField(t: TeamNum, pos: Position) {
		const players = this.playersOnField[t][pos];

		if (!players || !players[0]) {
			throw new Error(`No player found at position ${pos}`);
		}

		return players[0];
	}

	probPass() {
		// Hack!! Basically, we want to see what kind of talent we have before picking if it's a run or pass play, so put the starter (minus fatigue) out there and compute these
		this.updatePlayersOnField("startersFake");

		const ptsDown = this.team[this.d].stat.pts - this.team[this.o].stat.pts;
		const quarter = this.team[0].stat.ptsQtrs.length;
		const desperation =
			this.scrimmage < 97 &&
			quarter >= this.numPeriods &&
			((quarter > this.numPeriods && ptsDown > 0) ||
				(ptsDown > 0 && this.clock <= 2) ||
				(ptsDown > 8 && this.clock <= 3) ||
				(ptsDown > 16 && this.clock <= 4) ||
				(ptsDown > 24 && this.clock <= 6));
		if (desperation) {
			return 0.98 * g.get("passFactor");
		}

		let offPassing = 0;
		let offRushing = 0;
		let defPassing = 0;
		let defRushing = 0;

		// Calculate offPassing only if there is a quarterback in the formation
		if (this.playersOnField[this.o].QB) {
			const qb = this.getTopPlayerOnField(this.o, "QB");
			const qbFactor = qb ? qb.ovrs.QB / 100 : 0;
			offPassing =
				(5 * qbFactor +
					this.team[this.o].compositeRating.receiving +
					this.team[this.o].compositeRating.passBlocking) /
				7;
		}

		offRushing =
			(this.team[this.o].compositeRating.rushing +
				this.team[this.o].compositeRating.runBlocking) /
			2;
		defPassing =
			(this.team[this.d].compositeRating.passRushing +
				this.team[this.d].compositeRating.passCoverage) /
			2;
		defRushing = this.team[this.d].compositeRating.runStopping;

		// Arbitrary rescale - .45-.7 -> .25-.75
		offPassing = helpers.bound((offPassing - 0.45) * (0.5 / 0.25) + 0.25, 0, 1);

		// Arbitrary rescale - .5-.7 -> .25-.75
		offRushing = helpers.bound((offRushing - 0.5) * (0.5 / 0.2) + 0.25, 0, 1);

		// Arbitrary rescale - .4-.65 -> .25-.75
		defPassing = helpers.bound((defPassing - 0.4) * (0.5 / 0.25) + 0.25, 0, 1);

		// Arbitrary rescale - .4-.6 -> .25-.75
		defRushing = helpers.bound((defRushing - 0.4) * (0.5 / 0.2) + 0.25, 0, 1);

		const passingTendency =
			1.075 * helpers.bound(offPassing - 0.25 * defPassing, 0, 1);
		const rushingTendency =
			0.925 * helpers.bound(offRushing - 0.25 * defRushing, 0, 1);

		let passOdds = 0.57;
		if (passingTendency > 0 || rushingTendency > 0) {
			// Always pass at least 45% of the time, and always rush at least 35% of the time
			passOdds = helpers.bound(
				(1.5 * passingTendency) / (1.5 * passingTendency + rushingTendency),
				0.45,
				0.65,
			);
		}

		if (this.scrimmage >= 95) {
			// 5 for 1 yd to go, 1 for 5 yds to go
			const runAtGoallineWeight = this.scrimmage - 94;

			passOdds = passOdds / runAtGoallineWeight;
		}

		return passOdds * g.get("passFactor");
	}

	// Probability that a kickoff should be an onside kick
	probOnside() {
		if (this.awaitingAfterSafety) {
			return 0;
		}

		// Random onside kick, but never in the 4th quarter because some of those could be really stupid
		if (this.team[0].stat.ptsQtrs.length < this.numPeriods) {
			return 0.001 * g.get("onsideFactor");
		}

		// Does game situation dictate an onside kick in the 4th quarter?
		if (this.team[0].stat.ptsQtrs.length !== this.numPeriods) {
			return 0;
		}

		const numScoresDown = Math.ceil(
			(this.team[this.d].stat.pts - this.team[this.o].stat.pts) / 8,
		);

		if (numScoresDown <= 0 || numScoresDown >= 4) {
			// Either winning, or being blown out so there's no point
			return 0;
		}

		if (this.clock < 2) {
			return 1;
		}

		if (numScoresDown >= 2 && this.clock < 2.5) {
			return 0.9;
		}

		if (numScoresDown >= 3 && this.clock < 3.5) {
			return 0.8;
		}

		if (numScoresDown >= 2 && this.clock < 5) {
			return numScoresDown / 20;
		}

		return 0;
	}

	hurryUp() {
		const ptsDown = this.team[this.d].stat.pts - this.team[this.o].stat.pts;
		const quarter = this.team[0].stat.ptsQtrs.length;
		return (
			((this.kickoffAfterEndOfPeriod(quarter) && this.scrimmage >= 50) ||
				(quarter === this.numPeriods && ptsDown >= 0)) &&
			this.clock <= 2
		);
	}

	getPlayType() {
		if (this.awaitingKickoff !== undefined) {
			return Math.random() < this.probOnside() ? "onsideKick" : "kickoff";
		}

		const ptsDown = this.team[this.d].stat.pts - this.team[this.o].stat.pts;
		const quarter = this.team[0].stat.ptsQtrs.length;

		if (this.awaitingAfterTouchdown) {
			if (!g.get("twoPointConversions")) {
				return "extraPoint";
			}

			if (ptsDown === 2 && Math.random() < 0.7) {
				return "twoPointConversion";
			}

			if (quarter >= this.numPeriods - 1) {
				if (ptsDown === 0) {
					return "extraPoint";
				}
				if (ptsDown === 1) {
					return "extraPoint";
				}
				if (ptsDown === 2) {
					return "twoPointConversion";
				}
				if (ptsDown === 4) {
					return "extraPoint";
				}
				if (ptsDown === 5) {
					return "twoPointConversion";
				}
				if (ptsDown === 7) {
					return "extraPoint";
				}
				if (ptsDown === 8) {
					return "extraPoint";
				}
				if (ptsDown === 10) {
					return "twoPointConversion";
				}
				if (ptsDown === 11) {
					return "extraPoint";
				}
				if (ptsDown === 13) {
					return "twoPointConversion";
				}
				if (ptsDown === 14) {
					return "extraPoint";
				}
				if (ptsDown === 15) {
					return "extraPoint";
				}
				if (ptsDown === 18) {
					return "twoPointConversion";
				}
				if (ptsDown === -1) {
					return "twoPointConversion";
				}
				if (ptsDown === -2) {
					return "extraPoint";
				}
				if (ptsDown === -3) {
					return "extraPoint";
				}
				if (ptsDown === -5) {
					return "twoPointConversion";
				}
				if (ptsDown === -6) {
					return "extraPoint";
				}
				if (ptsDown === -7) {
					return "extraPoint";
				}
				if (ptsDown === -8) {
					return "extraPoint";
				}
				if (ptsDown === -9) {
					return "extraPoint";
				}
				if (ptsDown === -10) {
					return "extraPoint";
				}
				if (ptsDown === -12) {
					return "twoPointConversion";
				}
				if (ptsDown === -13) {
					return "extraPoint";
				}
				if (ptsDown === -14) {
					return "extraPoint";
				}
			}

			return Math.random() < 0.95 ? "extraPoint" : "twoPointConversion";
		}

		if (quarter >= this.numPeriods && ptsDown < 0) {
			// Does it make sense to kneel? Depends on clock time and opponent timeouts
			const numTimeouts =
				this.timeouts[this.d] + (this.clock > TWO_MINUTE_WARNING_TIME ? 1 : 0);
			const downsRemaining = NUM_DOWNS - this.down;
			const timeoutDownsRemaining = Math.min(numTimeouts, downsRemaining);
			const clockRunningDownsRemaining = downsRemaining - timeoutDownsRemaining;
			const timeRemainingAfterKeels =
				this.clock -
				(ESTIMATED_SECONDS_PER_KNEEL_TIMEOUT * timeoutDownsRemaining +
					ESTIMATED_SECONDS_PER_KNEEL * clockRunningDownsRemaining) /
					60;

			if (timeRemainingAfterKeels < 0) {
				if (this.scrimmage > YARDS_NEEDED_TO_KNEEL * downsRemaining) {
					return "kneel";
				} else {
					// We don't have room to kneel, so probably just run
					if (Math.random() < 0.9) {
						return "run";
					}
				}
			}
		}

		// Don't kick a FG when we really need a touchdown! secondPossession check is for playoff overtime rules
		const needTouchdown =
			quarter >= this.numPeriods &&
			ptsDown > 3 &&
			(this.clock <= 2 || this.overtimeState === "secondPossession");

		let neverPunt = false;
		if (quarter === this.numPeriods && ptsDown > 0) {
			// Losing in 4th quarter, maybe don't punt if there's not much time left. Also depends on how many timeouts are left
			const numTimeouts =
				this.timeouts[this.o] + (this.clock > TWO_MINUTE_WARNING_TIME ? 1 : 0);
			const downsRemaining = NUM_DOWNS - 1;
			const timeoutDownsRemaining = Math.min(numTimeouts, downsRemaining);
			const clockRunningDownsRemaining = downsRemaining - timeoutDownsRemaining;
			const timeRemainingAfterKeels =
				this.clock -
				(ESTIMATED_SECONDS_PER_KNEEL_TIMEOUT * timeoutDownsRemaining +
					ESTIMATED_SECONDS_PER_KNEEL * clockRunningDownsRemaining) /
					60;

			// We want at least 30 seconds after getting the ball back
			if (timeRemainingAfterKeels < 0.5) {
				neverPunt = true;
			}
		} else if (quarter > this.numPeriods && ptsDown > 0) {
			// Losing in overtime, never punt
			neverPunt = true;
		}

		// If there are under 10 seconds left in the half/overtime, maybe try a field goal
		if (
			this.clock <= 10 / 60 &&
			this.kickoffAfterEndOfPeriod(quarter) &&
			!needTouchdown &&
			this.probMadeFieldGoal() >= 0.02
		) {
			return "fieldGoalLate";
		}

		// If a field goal will win it in overtime and odds of success are high, go for it
		if (
			quarter > this.numPeriods &&
			(this.overtimeType === "suddenDeath" ||
				this.overtimeState === "secondPossession" ||
				this.overtimeState === "bothTeamsPossessed") &&
			ptsDown < 3 &&
			this.probMadeFieldGoal() >= 0.9
		) {
			return "fieldGoal";
		}

		if (this.down === 4) {
			// Don't kick a FG when we really need a touchdown!
			if (!needTouchdown) {
				const probMadeFieldGoal = this.probMadeFieldGoal();

				// If it's late in the 4th quarter, some scores heavily favor kicking a FG - the FG will take the lead, or when the FG will make the "number of scores" lead much better (like going from up 4 to up 7, or up 6 to up 9)
				if (
					probMadeFieldGoal >= 0.5 &&
					quarter === this.numPeriods &&
					this.clock <= 6 &&
					((ptsDown >= 0 && ptsDown <= 2) || (ptsDown <= -4 && ptsDown >= -8))
				) {
					return "fieldGoal";
				}

				// If it's 4th and short, maybe go for it
				let probGoForIt =
					(() => {
						// In overtime, if tied and a field goal would win, try it
						if (
							((quarter > this.numPeriods &&
								this.overtimeType === "suddenDeath") ||
								this.overtimeState !== "firstPossession") &&
							ptsDown === 0 &&
							probMadeFieldGoal >= 0.7
						) {
							return 0;
						}
						if (this.scrimmage < 40) {
							return 0;
						}
						if (this.toGo <= 1) {
							return 0.75;
						}
						if (this.toGo <= 2) {
							return 0.5;
						}
						if (this.toGo <= 3) {
							return 0.35;
						}
						if (this.toGo <= 4) {
							return 0.2;
						}
						if (this.toGo <= 5) {
							return 0.05;
						}
						if (this.toGo <= 7) {
							return 0.01;
						}
						if (this.toGo <= 10) {
							return 0.001;
						}
						return 0;
					})() * g.get("fourthDownFactor");
				if (probGoForIt > 0.99) {
					probGoForIt = 0.99;
				}

				if (Math.random() > probGoForIt) {
					// If it's a makeable field goal, take it
					if (probMadeFieldGoal >= 0.7) {
						return "fieldGoal";
					}

					// If it's a hard field goal, maybe take it
					const probTryFieldGoal = helpers.bound(
						(probMadeFieldGoal - 0.3) / 0.5,
						0,
						1,
					);

					if (Math.random() < probTryFieldGoal) {
						return "fieldGoal";
					}

					// Default option - punt
					if (!neverPunt) {
						return "punt";
					}
				}
			}
		}

		if (Math.random() < this.probPass()) {
			return "pass";
		}

		return "run";
	}

	getAllowedCoachPlays(): FootballCoachPlay[] {
		if (this.awaitingKickoff !== undefined) {
			return this.awaitingAfterSafety ? ["kickoff"] : ["kickoff", "onsideKick"];
		}
		if (this.awaitingAfterTouchdown) {
			return g.get("twoPointConversions")
				? ["extraPoint", "twoPointConversion"]
				: ["extraPoint"];
		}
		return [
			"run",
			"pass",
			"kneel",
			...(this.clock > 0 ? ["spike" as const] : []),
			"punt",
			"fieldGoal",
		];
	}

	// Pure depth-chart previews do not consume random numbers or mutate statistics.
	private getCoachLineup(
		t: TeamNum,
		positions: Partial<Record<Position, number>>,
		pinned: { id: number; position: Position }[] = [],
	): PlayersOnField {
		const used = new Set<number>();
		const lineup: PlayersOnField = {};
		const pins = pinned.flatMap(({ id, position }) => {
			const player = this.team[t].player.find((p) => p.id === id && !p.injured);
			return player ? [{ player, position }] : [];
		});
		for (const pos of helpers.keys(positions)) {
			const count = positions[pos]!;
			const depth = this.team[t].depth[pos] ?? [];
			const atPosition: PlayerGameSim[] = [];
			const add = (p: PlayerGameSim) => {
				if (!used.has(p.id) && atPosition.length < count) {
					atPosition.push(p);
					used.add(p.id);
				}
			};
			for (const pin of pins.filter((pin) => pin.position === pos)) {
				add(pin.player);
			}
			for (const candidates of [
				depth.filter((p) => !p.injured && p.stat.energy >= 0.25),
				depth.filter((p) => !p.injured),
				depth,
			]) {
				for (const p of candidates) {
					// Reserve the called role, including out-of-position depth-chart players.
					if (
						!pins.some((pin) => pin.player.id === p.id && pin.position !== pos)
					) {
						add(p);
					}
				}
			}
			lineup[pos] = atPosition;
		}
		return lineup;
	}

	private describeCoachLineup(
		lineup: PlayersOnField,
	): FootballCoachLineupPlayer[] {
		return helpers.keys(lineup).flatMap((pos) =>
			(lineup[pos] ?? []).map((p, index) => ({
				id: p.id,
				name: p.name,
				pos: p.pos,
				slot: `${pos}${index + 1}`,
			})),
		);
	}

	private getCoachEligible(
		positions: string[],
		lineups: FootballCoachLineupPlayer[],
	) {
		const roleIds = new Set(
			lineups
				.filter((p) => positions.includes(p.slot.replace(/\d+$/, "")))
				.map((p) => p.id),
		);
		return this.team[this.o].player
			.filter(
				(p) => (positions.includes(p.pos) || roleIds.has(p.id)) && !p.injured,
			)
			.map((p) => ({
				id: p.id,
				name: p.name,
				pos: p.pos,
				energy: p.stat.energy ?? 0,
				injured: p.injured,
			}));
	}

	private prepareCoachTactics(decision: FootballCoachDecision | undefined) {
		this.coachTactics = undefined;
		if (
			!decision ||
			[
				decision.callId,
				decision.targetPid,
				decision.runnerPid,
				decision.route,
				decision.defenseId,
			].every((value) => value === undefined)
		) {
			return;
		}
		const call = decision.callId
			? getFootballCoachCall(decision.callId)
			: undefined;
		const formation =
			call?.formation ??
			(this.coachTeam !== undefined && this.o !== this.coachTeam
				? choice(["11", "21", "12"] as const)
				: "11");
		this.coachTactics = {
			decision,
			call,
			formation,
			defense: getFootballCoachDefense(
				decision.defenseId ?? FOOTBALL_COACH_DEFAULT_DEFENSES[formation],
			),
			route:
				decision.route || call?.route
					? getFootballCoachRoute(decision.route ?? call!.route!)
					: undefined,
			rushers: [],
			coverage: [],
		};
	}

	private getCoachPlayType() {
		const call = this.coachTactics?.call;
		if (!call) {
			return undefined;
		}
		if (call.kind !== "option") {
			return call.kind;
		}
		this.updatePlayersOnField("run");
		const front = this.coachTactics!.defense.positions;
		const box = front.DL + front.LB;
		const offense = this.team[this.o].compositeRating;
		const defense = this.team[this.d].compositeRating;
		// A documented coaching read, not a learned NFL success probability.
		return box >= 7 ||
			offense.receiving / Math.max(0.01, defense.passCoverage) >
				offense.runBlocking / Math.max(0.01, defense.runStopping)
			? "pass"
			: "run";
	}

	private updateCoachAssignments() {
		const tactics = this.coachTactics;
		if (!tactics) {
			return;
		}
		const field = this.playersOnField[this.d];
		const candidates = [
			...(field.DL ?? []),
			...(field.LB ?? []).toSorted(
				(a, b) => b.compositeRating.passRushing - a.compositeRating.passRushing,
			),
		];
		tactics.rushers = candidates.slice(0, tactics.defense.rushers);
		const rushIds = new Set(tactics.rushers.map((p) => p.id));
		tactics.coverage = getPlayers(field).filter((p) => !rushIds.has(p.id));
		const groups = (players: PlayerGameSim[]) => {
			const grouped: PlayersOnField = {};
			for (const pos of helpers.keys(field)) {
				grouped[pos] = (field[pos] ?? []).filter((p) => players.includes(p));
			}
			return grouped;
		};
		const composite = this.team[this.d].compositeRating;
		composite.passRushing = Math.max(
			0.01,
			(getCompositeFactor(
				groups(tactics.rushers),
				COMPOSITE_FACTOR_OPTIONS.passRushing,
			) *
				tactics.rushers.length) /
				4,
		);
		composite.passCoverage = Math.max(
			0.01,
			(getCompositeFactor(
				groups(tactics.coverage),
				COMPOSITE_FACTOR_OPTIONS.passCoverage,
			) *
				tactics.coverage.length) /
				7,
		);
		if (tactics.defense.coverage === "prevent") {
			composite.runStopping = Math.max(
				0.01,
				getCompositeFactor(
					{ ...field, S: [] },
					COMPOSITE_FACTOR_OPTIONS.runStopping,
				),
			);
		}
		if (this.lastCoachCall) {
			this.lastCoachCall.rusherPids = tactics.rushers.map((p) => p.id);
			this.lastCoachCall.coveragePids = tactics.coverage.map((p) => p.id);
		}
	}

	getCoachSnapshot(
		stage: FootballCoachSnapshot["stage"],
		clock = this.clock,
	): FootballCoachSnapshot {
		const players = (t: TeamNum) =>
			Object.values(this.playersOnField[t]).flatMap((atPosition) =>
				atPosition.map((p) => ({ id: p.id, name: p.name, pos: p.pos })),
			);
		const scrimmage =
			stage === "play" &&
			this.awaitingKickoff === undefined &&
			!this.awaitingAfterTouchdown;
		const offenseLineups = Object.fromEntries(
			helpers
				.keys(FOOTBALL_COACH_PERSONNEL)
				.map((id) => [
					id,
					this.describeCoachLineup(
						this.getCoachLineup(this.o, FOOTBALL_COACH_PERSONNEL[id].positions),
					),
				]),
		) as Record<FootballCoachFormation, FootballCoachLineupPlayer[]>;
		const defenseLineups = Object.fromEntries(
			FOOTBALL_COACH_DEFENSES.map((entry) => [
				entry.id,
				this.describeCoachLineup(this.getCoachLineup(this.d, entry.positions)),
			]),
		) as Record<FootballCoachDefenseId, FootballCoachLineupPlayer[]>;
		return {
			gid: this.id,
			stage,
			controlledTeam: this.coachTeam,
			quarter: this.team[0].stat.ptsQtrs.length,
			numPeriods: this.numPeriods,
			clock: Math.max(0, clock),
			down: this.down,
			toGo: this.toGo,
			scrimmage: this.scrimmage,
			offense: this.o,
			defense: this.d,
			teams: [
				{
					id: this.team[0].id,
					pts: this.team[0].stat.pts,
					sPts: this.team[0].stat.sPts,
				},
				{
					id: this.team[1].id,
					pts: this.team[1].stat.pts,
					sPts: this.team[1].stat.sPts,
				},
			],
			timeouts: [...this.timeouts],
			canTimeout: [
				stage === "clock" && this.isClockRunning && this.timeouts[0] > 0,
				stage === "clock" && this.isClockRunning && this.timeouts[1] > 0,
			],
			awaitingKickoff: this.awaitingKickoff,
			awaitingAfterTouchdown: this.awaitingAfterTouchdown,
			isClockRunning: this.isClockRunning,
			allowedPlays: stage === "play" ? this.getAllowedCoachPlays() : [],
			allowedCallIds: scrimmage
				? FOOTBALL_COACH_CALLS.map((call) => call.id)
				: [],
			allowedDefenseIds: scrimmage
				? FOOTBALL_COACH_DEFENSES.map((entry) => entry.id)
				: [],
			eligibleReceivers: this.getCoachEligible(
				["WR", "TE", "RB"],
				Object.values(offenseLineups).flat(),
			),
			eligibleRushers: this.getCoachEligible(
				["QB", "RB", "WR"],
				Object.values(offenseLineups).flat(),
			),
			lineups: { offense: offenseLineups, defense: defenseLineups },
			lastCall: this.lastCoachCall
				? helpers.deepCopy(this.lastCoachCall)
				: undefined,
			boxScore: this.getCoachBoxScore(),
			events: helpers.deepCopy(
				this.playByPlay.playByPlay
					.filter((event) => event.type !== "stat" && event.type !== "init")
					.slice(-80),
			),
			playersOnField: [players(0), players(1)],
		};
	}

	private getCoachBoxScore(): FootballCoachBoxScore {
		const teams = this.team.map((team): FootballCoachBoxScoreTeam => ({
			id: team.id,
			stat: helpers.deepCopy(team.stat),
			players: team.player.map((player) => ({
				id: player.id,
				name: player.name,
				pos: player.pos,
				stat: Object.fromEntries(
					Object.entries(player.stat).filter(
						(entry): entry is [string, number] =>
							typeof entry[1] === "number" &&
							entry[0] !== "benchTime" &&
							entry[0] !== "courtTime" &&
							entry[0] !== "energy",
					),
				),
				jerseyNumber: (player as PlayerGameSim & { jerseyNumber?: string })
					.jerseyNumber,
				skills: g.get("challengeNoRatings") ? [] : [...player.skills],
				injured: player.injured,
				newInjury: !!player.newInjury,
				injury: player.newInjury
					? { type: "Injured", gamesRemaining: -1, playingThrough: false }
					: { ...player.injury },
			})),
		})) as [FootballCoachBoxScoreTeam, FootballCoachBoxScoreTeam];
		// Match native finalization: penalties can remove a score already logged.
		const scoringSummary = this.playByPlay.scoringSummary.filter(
			(event, index, events): event is PlayByPlayEventScore =>
				event.type !== "removeLastScore" &&
				events[index + 1]?.type !== "removeLastScore",
		);
		return {
			season: g.get("season"),
			teams,
			scoringSummary: helpers.deepCopy(scoringSummary),
			overtimes: this.overtimes,
			neutralSite: this.neutralSite,
		};
	}

	validateCoachDecision(
		decision: FootballCoachDecision | undefined,
		snapshot: FootballCoachSnapshot,
	) {
		validateFootballCoachDecision(decision, snapshot);
	}

	simPlay() {
		return runAutomatically(this.simPlaySteps());
	}

	private *simPlaySteps(): Generator<
		CoachPause,
		void,
		FootballCoachDecision | undefined
	> {
		const decision = yield { stage: "play" };
		// Reset before calling Play, so Play can set to true if necessary for the next play
		this.playUntimedPossession = false;
		this.prepareCoachTactics(decision);

		const playType =
			this.getCoachPlayType() ??
			(decision?.play && decision.play !== "auto"
				? decision.play
				: this.getPlayType());
		this.lastCoachCall =
			this.coachTactics && (playType === "run" || playType === "pass")
				? {
						callId: decision?.callId,
						name:
							this.coachTactics.call?.name ??
							(playType === "pass" ? "Pass" : "Run"),
						play: playType,
						route: this.coachTactics.route?.id,
						defenseId: this.coachTactics.defense.id,
					}
				: undefined;
		// A human defending an AI kneel also gets the timeout window before runoff.
		// Draining with undefined decisions keeps the native automatic timing.
		const manualKneel =
			playType === "kneel" &&
			(decision?.play === "kneel" ||
				(decision !== undefined && this.coachTeam !== undefined));

		// Set these before creating a new Play so they are updated in there too
		if (playType === "extraPoint") {
			this.scrimmage = SCRIMMAGE_EXTRA_POINT;
			this.down = 1;
			this.toGo = 100 - this.scrimmage;
		} else if (playType === "twoPointConversion") {
			this.scrimmage = SCRIMMAGE_TWO_POINT_CONVERSION;
			this.down = 1;
			this.toGo = 100 - this.scrimmage;
		}

		this.currentPlay = new Play(this);

		this.playByPlay.logClock({
			awaitingKickoff: this.awaitingKickoff,
			awaitingAfterTouchdown: this.awaitingAfterTouchdown,
			clock: this.clock,
			down: this.down,
			scrimmage: this.scrimmage,
			t: this.o,
			toGo: this.toGo,
		});

		// Track team drive stats - easier here than directly in Play.ts because we have playType here
		if (this.o !== this.currentDrive && this.down === 1) {
			// Ignore play types that are never part of a drive
			if (
				playType !== "kickoff" &&
				playType !== "onsideKick" &&
				playType !== "extraPoint" &&
				playType !== "twoPointConversion"
			) {
				this.currentPlay.addEvent({
					type: "newDrive",
				});
			}
		}

		let dt;

		if (playType === "kickoff") {
			dt = this.doKickoff();
		} else if (playType === "onsideKick") {
			dt = this.doKickoff(true);
		} else if (
			playType === "extraPoint" ||
			playType === "fieldGoal" ||
			playType === "fieldGoalLate"
		) {
			dt = this.doFieldGoal(playType);
		} else if (playType === "twoPointConversion") {
			dt = this.doTwoPointConversion();
		} else if (playType === "punt") {
			dt = this.doPunt();
		} else if (playType === "pass") {
			if (this.down === 4) {
				this.playByPlay.logEvent({
					type: "goingForItOn4th",
					clock: this.clock,
					t: this.o,
				});
			}
			dt = this.doPass();
		} else if (playType === "run") {
			if (this.down === 4) {
				this.playByPlay.logEvent({
					type: "goingForItOn4th",
					clock: this.clock,
					t: this.o,
				});
			}
			dt = this.doRun();
		} else if (playType === "kneel") {
			dt = this.doKneel(manualKneel);
		} else if (playType === "spike") {
			dt = this.doSpike();
		} else {
			throw new Error(`Unknown playType "${playType}"`);
		}

		dt /= 60;
		const quarter = this.team[0].stat.ptsQtrs.length;

		const clockAtEndOfPlay = this.clock - dt;

		const timeExpiredAtEndOfHalf =
			clockAtEndOfPlay <= 0 && this.kickoffAfterEndOfPeriod(quarter);

		this.currentPlay.commit(timeExpiredAtEndOfHalf);

		// Two minute warning
		let twoMinuteWarningHappening = false;
		if (
			this.kickoffAfterEndOfPeriod(quarter) &&
			clockAtEndOfPlay <= 2 &&
			!this.twoMinuteWarningHappened
		) {
			this.twoMinuteWarningHappened = true;
			this.isClockRunning = false;
			this.playByPlay.logEvent({
				type: "twoMinuteWarning",
				clock: clockAtEndOfPlay,
			});

			// So we know it happened this possession, and no random timeout should be used
			twoMinuteWarningHappening = true;
		}

		// Pause after resolving the snap, before either team spends a timeout or
		// the native between-play clock runoff is applied.
		let clockDecision: FootballCoachDecision | undefined;
		if (
			clockAtEndOfPlay > 0 &&
			!twoMinuteWarningHappening &&
			this.isClockRunning
		) {
			clockDecision = yield { stage: "clock", clock: clockAtEndOfPlay };
		}
		if (clockDecision?.timeout !== undefined) {
			this.doTimeout(clockDecision.timeout, true, clockAtEndOfPlay);
		}

		if (
			(clockDecision === undefined || this.coachTeam !== undefined) &&
			clockAtEndOfPlay > 0 &&
			!twoMinuteWarningHappening
		) {
			// Timeouts - small chance at any time
			const autoTimeout = (t: TeamNum, toStopClock: boolean) => {
				if (clockDecision === undefined || t !== this.coachTeam) {
					this.doTimeout(t, toStopClock);
				}
			};
			if (Math.random() < 0.01) {
				autoTimeout(this.o, false);
			} else if (Math.random() < 0.003) {
				autoTimeout(this.d, false);
			}

			// Timeouts - late in game when clock is running
			if (this.kickoffAfterEndOfPeriod(quarter) && this.isClockRunning) {
				const diff = this.team[this.o].stat.pts - this.team[this.d].stat.pts;

				const finalPeriod = quarter >= this.numPeriods;
				if (finalPeriod) {
					// No point in the 4th quarter of a blowout
					if (diff < 24) {
						if (diff > 0) {
							// If offense is winning, defense uses timeouts when near the end
							if (this.clock < 2.5) {
								autoTimeout(this.d, true);
							}
						} else {
							if (this.clock < 1.5) {
								// If offense is losing or tied, offense uses timeouts when even nearer the end
								autoTimeout(this.o, true);
							}
						}
					}
				} else {
					// Before halftime, less aggressive and don't care about score
					if (this.clock < 1.5) {
						autoTimeout(this.o, true);
					}
				}
			}
		}

		// Time between plays (can be more than 40 seconds because there is time before the play clock starts)
		let dtClockRunning = 0;

		if (this.isClockRunning) {
			if (
				clockDecision?.tempo === "chewClock" ||
				(manualKneel && clockDecision?.tempo !== "hurryUp")
			) {
				dtClockRunning = 40 / 60;
			} else if (
				clockDecision?.tempo === "hurryUp" ||
				(clockDecision?.tempo === undefined && this.hurryUp())
			) {
				dtClockRunning = randInt(5, 13) / 60;

				// Leave some time for a FG attempt!
				if (this.clock - dt - dtClockRunning < 0) {
					dtClockRunning = randInt(0, 4) / 60;
				}
			} else {
				dtClockRunning = randInt(37, 62) / 60;
			}

			dtClockRunning /= g.get("pace");
		}

		// Check two minute warning again
		if (
			this.kickoffAfterEndOfPeriod(quarter) &&
			clockAtEndOfPlay - dtClockRunning <= 2 &&
			!this.twoMinuteWarningHappened
		) {
			this.twoMinuteWarningHappened = true;
			this.isClockRunning = false;
			this.playByPlay.logEvent({
				type: "twoMinuteWarning",
				clock: 2,
			});

			// Clock only runs until it hits 2 minutes exactly
			dtClockRunning = helpers.bound(clockAtEndOfPlay - 2, 0, Infinity);
		}

		// Clock
		dt += dtClockRunning;
		this.clock -= dt;

		if (this.clock < 0) {
			dt += this.clock;
			this.clock = 0;
		}

		this.updatePlayingTime(dt);
		if (playType !== "kneel" && playType !== "spike") {
			this.injuries();
		}

		if (
			this.team[0].stat.pts !== this.team[1].stat.pts &&
			((this.overtimeState !== undefined &&
				this.overtimeType === "suddenDeath") ||
				(this.overtimeState === "bothTeamsPossessed" &&
					(!this.awaitingAfterTouchdown ||
						Math.abs(this.team[0].stat.pts - this.team[1].stat.pts) > 2)))
		) {
			this.overtimeState = "over";
		}
	}

	doTackle({ ydsFromScrimmage }: { ydsFromScrimmage: number | undefined }) {
		const d = this.currentPlay.state.current.d;

		// For non-sacks, record tackler(s)
		if (Math.random() < 0.9) {
			// Bias position of tackler based on how far from scrimmage the play is
			let positions: Position[] | undefined;
			if (ydsFromScrimmage !== undefined) {
				const r = Math.random();
				if (ydsFromScrimmage < 2) {
					if (r < 0) {
						positions = ["DL"];
					} else if (r < 0.4) {
						positions = ["DL", "LB"];
					}
				} else if (ydsFromScrimmage < 7) {
					if (r < 0.2) {
						positions = ["LB"];
					} else if (r < 0.4) {
						positions = ["LB", "S"];
					}
				} else if (ydsFromScrimmage < 15) {
					if (r < 0.3) {
						positions = ["LB", "S"];
					} else if (r < 0.95) {
						positions = ["LB", "S", "CB"];
					}
				} else {
					if (r < 0.3) {
						positions = ["S"];
					} else if (r < 0.9) {
						positions = ["S", "CB"];
					} else {
						positions = ["S", "CB", "LB"];
					}
				}
			}

			const tacklers =
				Math.random() < 0.25
					? new Set([
							this.pickPlayer(d, "tackling", positions, 1.5),
							this.pickPlayer(d, "tackling", positions, 1.5),
						])
					: new Set([this.pickPlayer(d, "tackling", positions, 1.5)]);

			this.currentPlay.addEvent({
				type: "tck",
				tacklers,
				loss: ydsFromScrimmage !== undefined && ydsFromScrimmage < 0,
			});
		}
	}

	updateTeamCompositeRatings() {
		this.team[this.o].compositeRating.receiving = getCompositeFactor(
			this.playersOnField[this.o],
			COMPOSITE_FACTOR_OPTIONS.receiving,
		);
		this.team[this.o].compositeRating.rushing = getCompositeFactor(
			this.playersOnField[this.o],
			COMPOSITE_FACTOR_OPTIONS.rushing,
		);
		this.team[this.d].compositeRating.passRushing = getCompositeFactor(
			this.playersOnField[this.d],
			COMPOSITE_FACTOR_OPTIONS.passRushing,
		);
		this.team[this.d].compositeRating.runStopping = getCompositeFactor(
			this.playersOnField[this.d],
			COMPOSITE_FACTOR_OPTIONS.runStopping,
		);
		this.team[this.d].compositeRating.passCoverage = getCompositeFactor(
			this.playersOnField[this.d],
			COMPOSITE_FACTOR_OPTIONS.passCoverage,
		);
		this.team[this.d].compositeRating.tackling = getCompositeFactor(
			this.playersOnField[this.d],
			COMPOSITE_FACTOR_OPTIONS.tackling,
		);

		const [passBlocking, runBlocking] = getBlockingFactors(
			this.playersOnField[this.o],
		);
		this.team[this.o].compositeRating.passBlocking = passBlocking;
		this.team[this.o].compositeRating.runBlocking = runBlocking;
		/*globalThis.valuesPass ??= [];
		globalThis.valuesPass.push(this.team[this.o].compositeRating.passBlocking / this.team[this.d].compositeRating.passRushing)
		globalThis.valuesRun ??= [];
		globalThis.valuesRun.push(this.team[this.o].compositeRating.runBlocking / this.team[this.d].compositeRating.runStopping)*/
	}

	updatePlayersOnField(
		playType:
			| "starters"
			| "startersFake"
			| "run"
			| "pass"
			| "extraPoint"
			| "fieldGoal"
			| "punt"
			| "kickoff",
	) {
		if (this.coachTactics && (playType === "run" || playType === "pass")) {
			const { decision, formation, defense, call } = this.coachTactics;
			const preview = this.getCoachLineup(
				this.o,
				FOOTBALL_COACH_PERSONNEL[formation].positions,
			);
			const pinRole = (id: number | undefined, roles: readonly Position[]) => {
				if (id === undefined) {
					return [];
				}
				const player = this.team[this.o].player.find((p) => p.id === id)!;
				const position =
					helpers
						.keys(preview)
						.find(
							(pos) =>
								roles.includes(pos) && preview[pos]?.some((p) => p.id === id),
						) ??
					(roles.includes(player.pos as Position)
						? (player.pos as Position)
						: roles[0]!);
				return [{ id, position }];
			};
			const pinned = [
				...pinRole(
					decision.targetPid,
					call?.targetPositions ?? ["WR", "TE", "RB"],
				),
				...pinRole(
					decision.runnerPid,
					call?.runnerPosition ? [call.runnerPosition] : ["QB", "RB", "WR"],
				),
			];
			this.playersOnField[this.o] = this.getCoachLineup(
				this.o,
				FOOTBALL_COACH_PERSONNEL[formation].positions,
				pinned,
			);
			this.playersOnField[this.d] = this.getCoachLineup(
				this.d,
				defense.positions,
			);
			for (const t of teamNums) {
				for (const p of getPlayers(this.playersOnField[t])) {
					this.recordStat(t, p, "gp");
				}
			}
			this.updateTeamCompositeRatings();
			this.updateCoachAssignments();
			return;
		}
		let formation: Formation;

		if (playType === "starters" || playType === "startersFake") {
			formation = formations.normal[0]!;
		} else if (playType === "run" || playType === "pass") {
			formation = choice(formations.normal);
		} else if (playType === "extraPoint" || playType === "fieldGoal") {
			formation = choice(formations.fieldGoal);
		} else if (playType === "punt") {
			formation = choice(formations.punt);
		} else if (playType === "kickoff") {
			formation = choice(formations.kickoff);
		} else {
			throw new Error(`Unknown playType "${playType}"`);
		}

		const sides = ["off", "def"] as const;

		for (const i of [0, 1] as const) {
			const t = i === 0 ? this.o : this.d;
			const side = sides[i];

			// Don't let one player be used at two positions!
			const pidsUsed = new Set();
			this.playersOnField[t] = {};

			for (const pos of helpers.keys(formation[side])) {
				const numPlayers = formation[side][pos]!;

				// Not sure why this adjustment is needed, but without it, basically only the top 3 WR play. Maybe because formations with fewer than 3 WR let some of them rest, so you'd need 3 WR sets called very frequently to ever get them all tired.
				const FATIGUE_MODIFIER = pos === "WR" ? 0.75 : 1;

				const depth = this.team[t].depth[pos];
				const players: PlayerGameSim[] = [];
				if (FATIGUE_POS.has(pos)) {
					for (let depthIndex = 0; depthIndex < depth.length; depthIndex++) {
						if (players.length >= numPlayers) {
							break;
						}

						const p = depth[depthIndex]!;
						if (p.injured || pidsUsed.has(p.id)) {
							continue;
						}

						if (
							Math.random() <
							FATIGUE_MODIFIER * fatigue(p.stat.energy, p.injured)
						) {
							players.push(p);
							pidsUsed.add(p.id);
						}
					}
				} else {
					for (let depthIndex = 0; depthIndex < depth.length; depthIndex++) {
						if (players.length >= numPlayers) {
							break;
						}

						const p = depth[depthIndex]!;
						if (!p.injured && !pidsUsed.has(p.id)) {
							players.push(p);
							pidsUsed.add(p.id);
						}
					}
				}
				this.playersOnField[t][pos] = players;

				if (players.length < numPlayers) {
					// Retry without ignoring fatigued players
					for (let depthIndex = 0; depthIndex < depth.length; depthIndex++) {
						const p = depth[depthIndex]!;
						if (players.length >= numPlayers) {
							break;
						}
						if (!p.injured && !pidsUsed.has(p.id)) {
							players.push(p);
							pidsUsed.add(p.id);
						}
					}

					// Retry without ignoring injured players
					if (players.length < numPlayers) {
						for (let depthIndex = 0; depthIndex < depth.length; depthIndex++) {
							const p = depth[depthIndex]!;
							if (players.length >= numPlayers) {
								break;
							}
							if (!pidsUsed.has(p.id)) {
								players.push(p);
								pidsUsed.add(p.id);
							}
						}
					}
				}

				for (const p of this.playersOnField[t][pos]) {
					if (playType === "starters") {
						this.recordStat(t, p, "gs");
					}
					this.recordStat(t, p, "gp");
				}
			}
		}

		this.updateTeamCompositeRatings();
	}

	doTimeout(t: TeamNum, toStopClock: boolean, clock = this.clock) {
		if (this.timeouts[t] <= 0) {
			return;
		}

		this.timeouts[t] -= 1;
		this.logTimeouts();
		this.isClockRunning = false;
		this.playByPlay.logEvent({
			type: "timeout",
			clock,
			offense: t === this.o,
			numLeft: this.timeouts[t],
			t,
			toStopClock,
		});
	}

	doKickoff(onside: boolean = false) {
		this.updatePlayersOnField("kickoff");
		const kicker = this.getTopPlayerOnField(this.o, "K");
		let dt = 0;

		if (onside) {
			dt = randInt(2, 5);
			const kickTo = randInt(40, 55);
			this.currentPlay.addEvent({
				type: "onsideKick",
				p: kicker,
				kickTo,
			});
			this.playByPlay.logEvent({
				type: "onsideKick",
				clock: this.clock,
				names: [kicker.name],
				t: this.o,
			});
			const success = Math.random() < 0.1 * g.get("onsideRecoveryFactor");

			const p = success ? this.pickPlayer(this.o) : this.pickPlayer(this.d);

			let yds = 0;
			if (!success) {
				this.currentPlay.addEvent({
					type: "possessionChange",
					subtype: "kickoff",
					yds: 0,
				});

				const rawLength = Math.random() < 0.003 ? 100 : randInt(0, 5);
				yds = this.currentPlay.boundedYds(rawLength);
				dt += Math.abs(yds) / 8;
			}

			const { td } = this.currentPlay.addEvent({
				type: "onsideKickRecovery",
				success,
				kicker,
				p,
				yds,
			});

			if (td) {
				this.currentPlay.addEvent({
					type: "krTD",
					p,
				});
			} else {
				this.doTackle({
					ydsFromScrimmage: undefined,
				});
			}

			this.playByPlay.logEvent({
				type: "onsideKickRecovery",
				clock: this.clock,
				names: [p.name],
				success,
				t: this.currentPlay.state.current.o,
				td,
			});
		} else {
			// Penalty of up to 30 yards for bad kickers
			const adjust =
				kicker.compositeRating.kickingPower < 0.7
					? Math.round(30 * (0.7 - kicker.compositeRating.kickingPower))
					: 0;

			let kickToRange: [number, number];
			if (this.awaitingAfterSafety) {
				kickToRange = [15 + adjust, 35 + adjust];
			} else {
				kickToRange = [-15 + adjust, 5 + adjust];

				// If kickToRange is possibly a touchback, adjust likelihood of that based on touchback settings.
				const scrimmageTouchbackKickoff = g.get("scrimmageTouchbackKickoff");
				if (scrimmageTouchbackKickoff > 25) {
					/**
					 * 25 -> -15
					 * 35 -> -5
					 * 40 -> -3
					 * continue increasing 2 per 5
					 */
					let maxMinKickToRange;
					if (scrimmageTouchbackKickoff < 35) {
						maxMinKickToRange = -15 + (scrimmageTouchbackKickoff - 25);
					} else {
						maxMinKickToRange = -5 + ((scrimmageTouchbackKickoff - 35) * 2) / 5;
					}

					maxMinKickToRange = Math.round(maxMinKickToRange);
					if (maxMinKickToRange > 10) {
						maxMinKickToRange = 10;
					}

					if (maxMinKickToRange > kickToRange[0]) {
						const diff = maxMinKickToRange - kickToRange[0];
						kickToRange[0] += diff;
						kickToRange[1] += diff;
					}
				}
			}

			const kickReturner = this.getTopPlayerOnField(this.d, "KR");
			const kickTo = randInt(...kickToRange);
			const touchback = kickTo <= -10 || (kickTo < 0 && Math.random() < 0.8);
			this.currentPlay.addEvent({
				type: "k",
				p: kicker,
				kickTo,
			});
			this.playByPlay.logEvent({
				type: "kickoff",
				clock: this.clock,
				names: [kicker.name],
				t: this.o,
				touchback,
				yds: kickTo,
			});

			this.currentPlay.addEvent({
				type: "possessionChange",
				subtype: "kickoff",
				yds: 0,
			});
			if (touchback) {
				this.currentPlay.addEvent({
					type: "touchbackKick",
					p: kicker,
				});
			} else {
				const meanYds = 15 + 10 * kickReturner.compositeRating.rushing;
				let ydsRaw = Math.round(truncGauss(meanYds, 5, -10, 109));

				if (Math.random() < kickReturner.compositeRating.speed ** 3 * 0.025) {
					ydsRaw += randInt(0, 109);
				}

				const returnLength = this.currentPlay.boundedYds(ydsRaw);
				dt = Math.abs(returnLength) / 8;

				this.checkPenalties("kickoffReturn", {
					ballCarrier: kickReturner,
					playYds: returnLength,
				});

				const { td } = this.currentPlay.addEvent({
					type: "kr",
					p: kickReturner,
					yds: returnLength,
				});

				if (td) {
					this.currentPlay.addEvent({
						type: "krTD",
						p: kickReturner,
					});
				} else {
					this.doTackle({
						ydsFromScrimmage: undefined,
					});
				}

				this.playByPlay.logEvent({
					type: "kickoffReturn",
					clock: this.clock,
					names: [kickReturner.name],
					t: this.currentPlay.state.current.o,
					td,
					yds: returnLength,
					totalKrTD: this.allStarGame
						? undefined
						: kickReturner.seasonStats["krTD"] + kickReturner.stat["krTD"],
				});
			}
		}

		return dt;
	}

	doPunt() {
		this.playByPlay.logEvent({
			type: "puntTeam",
			clock: this.clock,
			t: this.o,
		});

		this.updatePlayersOnField("punt");
		const penInfo = this.checkPenalties("beforeSnap");

		if (penInfo) {
			return 0;
		}

		const punter = this.getTopPlayerOnField(this.o, "P");
		const puntReturner = this.getTopPlayerOnField(this.d, "PR");
		const adjustment = (punter.compositeRating.puntingPower - 0.7) * 20; // 100 ratings - 6 yd bonus. 0 ratings - 14 yard penalty

		const maxDistance = 109 - this.scrimmage;
		const averageDistance = 50 + adjustment;
		const sigma = 8;

		// If close to endzone, try to avoid it. Otherwise, kick as far as possible
		let distance = Math.round(truncGauss(averageDistance, sigma, 25, 90));
		if (
			this.scrimmage + distance >= 100 &&
			Math.random() < punter.compositeRating.puntingAccuracy ** 1.5 * 0.95
		) {
			const target = randInt(99, Math.max(81, this.scrimmage));
			distance = target - this.scrimmage;
		}

		const distanceAccountingForFieldSize = Math.min(distance, maxDistance);

		let dt = randInt(5, 9);

		this.checkPenalties("punt");

		const { touchback } = this.currentPlay.addEvent({
			type: "p",
			p: punter,
			yds: distanceAccountingForFieldSize,
		});

		this.playByPlay.logEvent({
			type: "punt",
			clock: this.clock,
			names: [punter.name],
			t: this.o,
			touchback,
			yds: distance,
		});

		this.currentPlay.addEvent({
			type: "possessionChange",
			subtype: "punt",
			yds: 0,
		});

		if (touchback) {
			this.currentPlay.addEvent({
				type: "touchbackPunt",
				p: punter,
			});
		} else {
			const maxReturnLength = 100 - this.currentPlay.state.current.scrimmage;
			const meanYds = 4 + 10 * puntReturner.compositeRating.rushing;
			let ydsRaw = Math.round(truncGauss(meanYds, 10, -10, 109));

			if (Math.random() < puntReturner.compositeRating.speed ** 3 * 0.06) {
				ydsRaw += randInt(0, 109);
			}

			const returnLength = helpers.bound(ydsRaw, 0, maxReturnLength);
			dt += Math.abs(returnLength) / 8;
			this.checkPenalties("puntReturn", {
				ballCarrier: puntReturner,
				playYds: returnLength,
			});

			const { td } = this.currentPlay.addEvent({
				type: "pr",
				p: puntReturner,
				yds: returnLength,
			});

			if (td) {
				this.currentPlay.addEvent({
					type: "prTD",
					p: puntReturner,
				});
			} else {
				this.doTackle({
					ydsFromScrimmage: undefined,
				});
			}

			this.playByPlay.logEvent({
				type: "puntReturn",
				clock: this.clock,
				names: [puntReturner.name],
				t: this.currentPlay.state.current.o,
				td,
				yds: returnLength,
				totalPrTD: this.allStarGame
					? undefined
					: puntReturner.seasonStats["prTD"] + puntReturner.stat["prTD"],
			});
		}

		return dt;
	}

	probMadeFieldGoal(kickerInput?: PlayerGameSim) {
		const kicker =
			kickerInput !== undefined
				? kickerInput
				: this.team[this.o].depth.K.find((p) => !p.injured);
		let baseProb = 0;
		let distance =
			100 - this.scrimmage + FIELD_GOAL_DISTANCE_YARDS_ADDED_FROM_SCRIMMAGE;

		if (!kicker) {
			// Would take an absurd amount of injuries to get here, but technically possible
			return 0;
		}

		// Kickers with strong/weak legs effectively have adjusted distances: -5 yds for 100, +15 yds for 0
		distance += -(kicker.compositeRating.kickingPower - 0.75) * 20;

		if (distance < 20) {
			baseProb = 0.99;
		} else if (distance < 30) {
			baseProb = 0.98;
		} else if (distance < 35) {
			baseProb = 0.95;
		} else if (distance < 37) {
			baseProb = 0.94;
		} else if (distance < 38) {
			baseProb = 0.93;
		} else if (distance < 39) {
			baseProb = 0.92;
		} else if (distance < 40) {
			baseProb = 0.91;
		} else if (distance < 41) {
			baseProb = 0.89;
		} else if (distance < 42) {
			baseProb = 0.87;
		} else if (distance < 43) {
			baseProb = 0.85;
		} else if (distance < 44) {
			baseProb = 0.83;
		} else if (distance < 45) {
			baseProb = 0.81;
		} else if (distance < 46) {
			baseProb = 0.79;
		} else if (distance < 47) {
			baseProb = 0.77;
		} else if (distance < 48) {
			baseProb = 0.75;
		} else if (distance < 49) {
			baseProb = 0.73;
		} else if (distance < 50) {
			baseProb = 0.71;
		} else if (distance < 51) {
			baseProb = 0.69;
		} else if (distance < 52) {
			baseProb = 0.65;
		} else if (distance < 53) {
			baseProb = 0.61;
		} else if (distance < 54) {
			baseProb = 0.59;
		} else if (distance < 55) {
			baseProb = 0.55;
		} else if (distance < 56) {
			baseProb = 0.51;
		} else if (distance < 57) {
			baseProb = 0.47;
		} else if (distance < 58) {
			baseProb = 0.43;
		} else if (distance < 59) {
			baseProb = 0.39;
		} else if (distance < 60) {
			baseProb = 0.35;
		} else if (distance < 61) {
			baseProb = 0.3;
		} else if (distance < 62) {
			baseProb = 0.25;
		} else if (distance < 63) {
			baseProb = 0.2;
		} else if (distance < 64) {
			baseProb = 0.1;
		} else if (distance < 65) {
			baseProb = 0.05;
		} else if (distance < 70) {
			baseProb = 0.005;
		} else if (distance < 75) {
			baseProb = 0.0001;
		} else if (distance < 80) {
			baseProb = 0.000001;
		} else {
			baseProb = 0;
		}

		baseProb *= g.get("fgAccuracyFactor");
		if (baseProb > 0.99) {
			baseProb = 0.99;
		}

		// Accurate kickers get a boost. Max boost is the min of (.1, (1-baseProb)/2, and baseProb/2)
		const baseBoost = (kicker.compositeRating.kickingAccuracy - 0.7) / 3;
		const boost = Math.min(baseBoost, (1 - baseProb) / 2, baseProb / 2);

		return baseProb + boost;
	}

	doFieldGoal(playType: "extraPoint" | "fieldGoal" | "fieldGoalLate") {
		this.updatePlayersOnField("fieldGoal");

		const extraPoint = playType === "extraPoint";
		const distance =
			100 - this.scrimmage + FIELD_GOAL_DISTANCE_YARDS_ADDED_FROM_SCRIMMAGE;
		const kicker = this.getTopPlayerOnField(this.o, "K");

		this.playByPlay.logEvent({
			type: extraPoint ? "extraPointAttempt" : "fieldGoalAttempt",
			clock: this.clock,
			names: [kicker.name],
			t: this.o,
			yds: distance,
		});

		if (!extraPoint) {
			const penInfo = this.checkPenalties("beforeSnap");

			if (penInfo) {
				return 0;
			}
		}

		const made = Math.random() < this.probMadeFieldGoal(kicker);
		const dt = extraPoint ? 0 : randInt(4, 6);
		if (!extraPoint) {
			this.checkPenalties("fieldGoal");
		}

		if (extraPoint) {
			this.currentPlay.addEvent({
				type: "xp",
				p: kicker,
				made,
				distance,
			});
		} else {
			this.currentPlay.addEvent({
				type: "fg",
				p: kicker,
				made,
				distance,
				late: playType === "fieldGoalLate",
			});

			if (!made) {
				this.currentPlay.addEvent({
					type: "possessionChange",
					subtype: "missedFg",
					yds: -7,
				});
			}
		}

		this.playByPlay.logEvent({
			type: extraPoint ? "extraPoint" : "fieldGoal",
			clock: this.clock,
			made,
			names: [kicker.name],
			t: this.o,
			yds: distance,
		});

		return dt;
	}

	doTwoPointConversion() {
		const getPts = () =>
			this.currentPlay.state.current.pts[0] +
			this.currentPlay.state.current.pts[1];

		const twoPointConversionTeam = this.o;

		this.currentPlay.addEvent({
			type: "twoPointConversion",
			t: twoPointConversionTeam,
		});

		this.twoPointConversionTeam = twoPointConversionTeam;

		this.playByPlay.logEvent({
			type: "twoPointConversion",
			clock: this.clock,
			t: twoPointConversionTeam,
		});

		const ptsBefore = getPts();

		const probPass = 0.5 * g.get("passFactor");

		if (Math.random() < probPass) {
			this.doPass();
		} else {
			this.doRun();
		}

		const ptsAfter = getPts();

		const made = ptsAfter > ptsBefore;

		this.currentPlay.addEvent({
			type: "twoPointConversionDone",
			t: twoPointConversionTeam,
			made,
		});

		if (!made) {
			// Must have failed!
			this.playByPlay.logEvent({
				type: "twoPointConversionFailed",
				clock: this.clock,
				t: twoPointConversionTeam,
			});
		}

		this.twoPointConversionTeam = undefined;

		return 0;
	}

	probFumble(p: PlayerGameSim) {
		const { d, o } = this.currentPlay.state.current;
		const offenseHasBall =
			this.playersOnField[o].QB ||
			this.playersOnField[o].RB ||
			this.playersOnField[o].P ||
			this.playersOnField[o].K;
		let tacklingFactor;
		if (!offenseHasBall) {
			// Offense is on defense, after a turnover
			tacklingFactor = 0.5;
		} else {
			tacklingFactor =
				(this.team[d].compositeRating.tackling / AVERAGE_TACKLING_COMPOSITE) **
				2;
		}

		return (
			0.0125 *
			(1.5 - p.compositeRating.ballSecurity) *
			g.get("fumbleFactor") *
			tacklingFactor
		);
	}

	doFumble(pFumbled: PlayerGameSim, spotYds: number) {
		const { o, d } = this.currentPlay.state.current;
		const pForced = this.pickPlayer(d, "tackling");
		this.currentPlay.addEvent({
			type: "fmb",
			pFumbled,
			pForced,
			yds: spotYds,
		});

		this.playByPlay.logEvent({
			type: "fumble",
			clock: this.clock,
			names: [pFumbled.name, pForced.name],
			totalFmb: this.allStarGame
				? undefined
				: pFumbled.seasonStats["fmb"] + pFumbled.stat["fmb"],
			totalDefFmbFrc: this.allStarGame
				? undefined
				: pForced.seasonStats["defFmbFrc"] + pForced.stat["defFmbFrc"],
			t: o,
		});

		const lost = Math.random() > 0.5;
		const tRecovered = lost ? d : o;
		const pRecovered = this.pickPlayer(tRecovered);

		let ydsRaw = Math.round(truncGauss(2, 6, -5, 15));

		if (Math.random() < (lost ? 0.01 : 0.0001)) {
			ydsRaw += randInt(0, 109);
		}

		if (lost) {
			this.currentPlay.addEvent({
				type: "possessionChange",
				subtype: "turnover",
				yds: 0,
			});
		}

		const yds = this.currentPlay.boundedYds(ydsRaw);

		const { safety, td, touchback } = this.currentPlay.addEvent({
			type: "fmbRec",
			pFumbled,
			pRecovered,
			yds,
			lost,
		});

		let dt = Math.abs(yds) / 6;

		let fumble = false;

		if (!touchback) {
			if (td) {
				this.currentPlay.addEvent({
					type: "fmbTD",
					p: pRecovered,
				});
			} else if (safety) {
				this.doSafety();
			} else if (Math.random() < this.probFumble(pRecovered)) {
				fumble = true;
			} else {
				this.doTackle({
					ydsFromScrimmage: undefined,
				});
			}
		}
		this.playByPlay.logEvent({
			type: "fumbleRecovery",
			clock: this.clock,
			lost,
			names: [pRecovered.name],
			safety,
			t: tRecovered,
			td,
			touchback,
			twoPointConversionTeam: this.twoPointConversionTeam,
			yds,
			ydsBefore: spotYds,
		});

		if (fumble) {
			dt += this.doFumble(pRecovered, 0);
		}

		return dt;
	}

	doInterception(qb: PlayerGameSim, ydsPass: number, p: PlayerGameSim) {
		this.playByPlay.logEvent({
			type: "interception",
			clock: this.clock,
			names: [p.name],
			totalDefInt: this.allStarGame
				? undefined
				: p.seasonStats["defInt"] + p.stat["defInt"] + 1,
			totalPssInt: this.allStarGame
				? undefined
				: qb.seasonStats["pssInt"] + qb.stat["pssInt"] + 1,
			t: this.currentPlay.state.current.d,
			twoPointConversionTeam: this.twoPointConversionTeam,
			yds: ydsPass,
		});

		this.currentPlay.addEvent({
			type: "possessionChange",
			subtype: "turnover",
			yds: ydsPass,
		});

		let ydsRaw = Math.round(truncGauss(4, 6, -5, 15));

		if (Math.random() < 0.075) {
			ydsRaw += randInt(0, 109);
		}

		const yds = this.currentPlay.boundedYds(ydsRaw);
		let dt = Math.abs(yds) / 8;

		const { td, touchback } = this.currentPlay.addEvent({
			type: "int",
			qb,
			defender: p,
			ydsReturn: yds,
		});

		let fumble = false;

		if (touchback) {
			this.currentPlay.addEvent({
				type: "touchbackInt",
			});
		} else if (td) {
			this.currentPlay.addEvent({
				type: "intTD",
				p,
			});
		} else if (Math.random() < this.probFumble(p)) {
			fumble = true;
		} else {
			this.doTackle({
				ydsFromScrimmage: undefined,
			});
		}

		this.playByPlay.logEvent({
			type: "interceptionReturn",
			clock: this.clock,
			names: [p.name],
			t: this.currentPlay.state.current.o,
			td,
			touchback,
			twoPointConversionTeam: this.twoPointConversionTeam,
			yds,
		});

		if (fumble) {
			dt += this.doFumble(p, 0);
		}

		return dt;
	}

	doSafety(p?: PlayerGameSim) {
		if (!p) {
			p = this.pickPlayer(
				this.d,
				Math.random() < 0.5 ? "passRushing" : "runStopping",
			);
		}

		this.currentPlay.addEvent({
			type: "defSft",
			p,
		});
	}

	doSack(
		qb: PlayerGameSim,
		pbw: Map<PlayerGameSim, { type: "OL" | "Other"; won: boolean }>,
	) {
		const { d } = this.currentPlay.state.initial;

		const p = this.coachTactics?.rushers.length
			? this.chooseCoachPlayer(this.coachTactics.rushers, "passRushing")
			: this.pickPlayer(d, "passRushing", undefined, 5);
		const ydsRaw = randInt(-1, -12);
		const yds = this.currentPlay.boundedYds(ydsRaw);

		// Track skAlw only if this is a DL/LB sack
		let ol;
		const dl = this.playersOnField[d].DL;
		const lb = this.playersOnField[d].LB;
		if ((dl && dl.includes(p)) || (lb && lb.includes(p))) {
			// Get rid of Array.from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Iterator/map - Chrome 122, Firefox 131, Safari 18.4
			const passBlockLossPlayers = Array.from(pbw.entries())
				.filter(([p, { type, won }]) => !won && type === "OL")
				.map(([p]) => p);
			if (passBlockLossPlayers.length > 0) {
				ol = choice(passBlockLossPlayers);
			}

			// If no OL lost his pass block, then assume this was a coverage sack or QB's fault
		}

		const { safety } = this.currentPlay.addEvent({
			type: "sk",
			qb,
			p,
			ol,
			yds,
		});

		if (safety) {
			this.doSafety(p);
		}

		this.playByPlay.logEvent({
			type: "sack",
			clock: this.clock,
			names: [qb.name, p.name],
			totalDefSk: this.allStarGame
				? undefined
				: p.seasonStats["defSk"] + p.stat["defSk"],
			safety,
			t: this.currentPlay.state.initial.o,
			yds,
		});

		return randInt(3, 8);
	}

	probSack(qb: PlayerGameSim) {
		const probability =
			((0.06 * this.team[this.d].compositeRating.passRushing) /
				(0.5 *
					(qb.compositeRating.avoidingSacks +
						this.team[this.o].compositeRating.passBlocking))) *
			g.get("sackFactor");
		const tactics = this.coachTactics;
		if (!tactics?.route) {
			return probability;
		}
		// Longer designed dropbacks expose the passer to the existing sack hazard.
		return (
			1 -
			(1 - helpers.bound(probability, 0, 1)) **
				((tactics.route.seconds + (tactics.call?.setupSeconds ?? 0)) / 4)
		);
	}

	probInt(qb: PlayerGameSim, defender: PlayerGameSim) {
		return (
			((((0.004 * this.team[this.d].compositeRating.passCoverage +
				0.022 * defender.compositeRating.passCoverage) /
				(0.5 *
					(qb.compositeRating.passingVision +
						qb.compositeRating.passingAccuracy))) *
				this.team[this.d].compositeRating.passRushing) /
				this.team[this.o].compositeRating.passBlocking) *
			g.get("intFactor")
		);
	}

	probComplete(
		qb: PlayerGameSim,
		target: PlayerGameSim,
		defender: PlayerGameSim,
	) {
		const factor =
			((0.2 *
				(target.compositeRating.catching +
					target.compositeRating.gettingOpen +
					qb.compositeRating.passingAccuracy +
					qb.compositeRating.passingDeep +
					qb.compositeRating.passingVision)) /
				(0.5 *
					(defender.compositeRating.passCoverage +
						this.team[this.d].compositeRating.passCoverage))) *
			Math.sqrt(
				this.team[this.o].compositeRating.passBlocking /
					this.team[this.d].compositeRating.passRushing,
			);
		let p = (0.19 + 0.4 * factor ** 1.25) * g.get("completionFactor");
		if (this.coachTactics?.route) {
			// Explicit tactical depth tradeoff, not an empirical completion forecast.
			const depth = Math.max(0, this.coachTactics.route.depth);
			p *= Math.sqrt(
				(8.6 + 20 * qb.compositeRating.passingDeep) / (8.6 + depth),
			);
		}
		return helpers.bound(p, 0, 0.95);
	}

	probScramble(qb?: PlayerGameSim) {
		const qbOvrRB = qb?.ovrs.RB ?? 0;
		return (
			(0.01 + Math.max(0, (0.35 * (qbOvrRB - 30)) / 100)) *
			g.get("scrambleFactor")
		);
	}

	doPass() {
		const o = this.o;
		const d = this.d;

		this.updatePlayersOnField("pass");
		const penInfo = this.checkPenalties("beforeSnap");

		if (penInfo) {
			return 0;
		}
		const tactics = this.coachTactics;
		const qb = this.getTopPlayerOnField(
			o,
			tactics?.call?.passerPosition ?? "QB",
		);
		let coachTarget: PlayerGameSim | undefined;
		if (tactics) {
			const eligible = getPlayers(
				this.playersOnField[o],
				tactics.call?.targetPositions
					? [...tactics.call.targetPositions]
					: ["WR", "TE", "RB"],
			);
			coachTarget =
				eligible.find((p) => p.id === tactics.decision.targetPid) ??
				this.chooseCoachPlayer(eligible, "gettingOpen");
			const blockers = {
				...this.playersOnField[o],
				TE: (this.playersOnField[o].TE ?? []).filter(
					(p) => p !== coachTarget && p !== qb,
				),
				RB: (this.playersOnField[o].RB ?? []).filter(
					(p) => p !== coachTarget && p !== qb,
				),
			};
			this.team[o].compositeRating.passBlocking =
				getBlockingFactors(blockers)[0];
			if (this.lastCoachCall) {
				this.lastCoachCall.targetPid = coachTarget.id;
			}
		}

		const pbw = new Map<
			PlayerGameSim,
			{ type: "OL" | "Other"; won: boolean }
		>();
		const pbCounts = { aOL: 0, aOther: 0, wOL: 0, wOther: 0 };
		const addBlockAttempt = (
			p: PlayerGameSim,
			type: "OL" | "Other",
			baselineRatio: number,
		) => {
			// This roughly ranges from 1 to 1.25
			const ratio =
				p.compositeRating.passBlocking /
				this.team[d].compositeRating.passRushing;

			// Scale to roughly 50%-95%
			const probWin = helpers.bound(
				(ratio - baselineRatio) * (0.45 / 0.25) + 0.5,
				0,
				0.96,
			);
			const won = Math.random() < probWin;
			pbw.set(p, {
				type,
				won,
			});

			pbCounts[`a${type}`] += 1;
			if (won) {
				pbCounts[`w${type}`] += 1;
			}
		};

		// OL always block, TE and RB sometimes do
		const ol = this.playersOnField[o].OL;
		if (ol) {
			for (const p of ol) {
				addBlockAttempt(p, "OL", 1);
			}
		}
		const te = this.playersOnField[o].TE;
		if (te) {
			for (const p of te) {
				if (
					p !== coachTarget &&
					(!tactics || p !== qb) &&
					(tactics?.call?.protection === "max" ||
						(tactics?.call?.protection !== "screen" && Math.random() < 0.1))
				) {
					addBlockAttempt(p, "Other", 0.75);
				}
			}
		}
		const rb = this.playersOnField[o].RB;
		if (rb) {
			for (const p of rb) {
				if (
					p !== coachTarget &&
					(!tactics || p !== qb) &&
					(tactics?.call?.protection === "max" ||
						(tactics?.call?.protection !== "screen" && Math.random() < 0.5))
				) {
					addBlockAttempt(p, "Other", 0.5);
				}
			}
		}

		if (this.lastCoachCall) {
			this.lastCoachCall.passerPid = qb.id;
		}
		this.currentPlay.addEvent({
			type: "dropback",
			pbw,
		});
		this.playByPlay.logEvent({
			type: "dropback",
			clock: this.clock,
			names: [qb.name],
			t: o,
		});

		let dt = tactics?.route
			? tactics.route.seconds + (tactics.call?.setupSeconds ?? 0)
			: randInt(2, 6);

		if (Math.random() < 0.75 && Math.random() < this.probFumble(qb)) {
			const yds = this.currentPlay.boundedYds(randInt(-1, -10));
			return dt + this.doFumble(qb, yds);
		}

		const sack = Math.random() < this.probSack(qb);

		if (sack) {
			return this.doSack(qb, pbw);
		}

		if (
			this.probScramble(tactics ? qb : this.playersOnField[o].QB?.[0]) >
			Math.random()
		) {
			return this.doRun(true, tactics ? qb : undefined);
		}

		const target =
			coachTarget ??
			this.pickPlayer(
				o,
				Math.random() < 0.2 ? "catching" : "gettingOpen",
				["WR", "TE", "RB"],
				1.5,
			);

		// RB passes are often short, so 50% chance of a decrease in yardage, which is more severe for players with low gettingOpen
		const rbFactor =
			this.playersOnField[o].RB?.includes(target) && Math.random() < 0.75
				? target.compositeRating.gettingOpen
				: 1;

		let ydsRaw = Math.round(
			truncGauss(
				// Bound is so (in extreme contrived cases like 0 ovr teams) meanYds can't go too far above/below the truncGauss limits
				helpers.bound(
					rbFactor *
						8.6 *
						(this.team[o].compositeRating.passBlocking /
							this.team[d].compositeRating.passRushing),
					-5,
					100,
				),
				rbFactor * 7,
				-5,
				100,
			),
		);
		if (tactics?.route) {
			const airYards =
				this.sampleCoachReference("pass") ??
				truncGauss(tactics.route.depth, tactics.route.spread, -5, 65);
			const matchup =
				(target.compositeRating.gettingOpen +
					target.compositeRating.speed +
					qb.compositeRating.passingDeep) /
				Math.max(0.1, 3 * this.team[d].compositeRating.passCoverage);
			const afterCatch = Math.max(0, truncGauss(3 * matchup, 3, -5, 20));
			ydsRaw = Math.round(airYards + afterCatch);
		}

		if (
			!tactics?.route &&
			Math.random() < qb.compositeRating.passingDeep * 0.05
		) {
			ydsRaw += randInt(0, 109);
		}

		// Adjust for receiver speed
		ydsRaw += Math.round((target.compositeRating.speed - 0.5) * 6);
		if (Math.random() < target.compositeRating.speed * 0.025) {
			ydsRaw += randInt(0, 109);
		}

		// Fewer TFL
		if (ydsRaw < 0) {
			ydsRaw += randInt(0, 5);
		}

		ydsRaw = Math.round(ydsRaw * g.get("passYdsFactor"));

		const yds = this.currentPlay.boundedYds(ydsRaw);

		const defender = tactics
			? this.chooseCoachDefender(target)
			: this.pickPlayer(d, "passCoverage", undefined, 2);
		const complete = Math.random() < this.probComplete(qb, target, defender);
		const interception = Math.random() < this.probInt(qb, defender);

		this.checkPenalties("pass", {
			ballCarrier: target,
			playYds: yds,
			incompletePass: !complete && !interception,
		});

		this.currentPlay.addEvent({
			type: "pss",
			qb,
			target,
		});

		if (interception) {
			dt += this.doInterception(qb, yds, defender);
		} else {
			dt += Math.abs(yds) / 20;

			if (complete) {
				const { td, safety } = this.currentPlay.addEvent({
					type: "pssCmp",
					qb,
					target,
					yds,
				});

				// Don't log here, because we need to log all the stats first, otherwise live box score will update slightly out of order
				const completeEvent = {
					type: "passComplete" as const,
					clock: this.clock,
					names: [qb.name, target.name],
					safety,
					t: o,
					td,
					twoPointConversionTeam: this.twoPointConversionTeam,
					yds,
				};

				// Fumble after catch... only if nothing else is going on, too complicated otherwise
				if (!td && !safety) {
					if (Math.random() < this.probFumble(target)) {
						this.playByPlay.logEvent({
							totalPssTD: undefined,
							totalRecTD: undefined,
							...completeEvent,
						});
						return dt + this.doFumble(target, 0);
					}
				}

				if (td) {
					this.currentPlay.addEvent({
						type: "pssTD",
						qb,
						target,
					});
				}

				// Do safety before logging event, otherwise pts for safety show up on the next play (kickoff)
				if (safety) {
					this.doSafety();
				}

				this.playByPlay.logEvent({
					totalPssTD: this.allStarGame
						? undefined
						: qb.seasonStats["pssTD"] + qb.stat["pssTD"],
					totalRecTD: this.allStarGame
						? undefined
						: target.seasonStats["recTD"] + target.stat["recTD"],
					...completeEvent,
				});

				if (!td && !safety) {
					this.doTackle({
						ydsFromScrimmage: yds,
					});
				}
			} else {
				this.currentPlay.addEvent({
					type: "pssInc",
					defender: Math.random() < 0.28 ? defender : undefined,
				});

				this.playByPlay.logEvent({
					type: "passIncomplete",
					clock: this.clock,
					names: [qb.name, target.name],
					t: o,
					yds,
				});
			}
		}

		return dt;
	}

	doRun(qbScramble: boolean = false, scramblingPlayer?: PlayerGameSim) {
		const o = this.o;
		const d = this.d;
		const tactics = this.coachTactics;
		const style = !qbScramble ? tactics?.call?.runStyle : undefined;

		let rbw:
			| Map<PlayerGameSim, { type: "OL" | "Other"; won: boolean }>
			| undefined;
		const rbCounts = { aOL: 0, aOther: 0, wOL: 0, wOther: 0 };

		// Usually do normal run, but sometimes do special stuff
		let positions: Position[];
		if (qbScramble) {
			positions = ["QB"];
		} else if (
			tactics?.call?.runnerPosition ||
			tactics?.decision.runnerPid !== undefined
		) {
			positions = tactics.call?.runnerPosition
				? [tactics.call.runnerPosition]
				: ["RB", "QB", "WR"];
			this.updatePlayersOnField("run");
			if (this.checkPenalties("beforeSnap")) {
				return 0;
			}
		} else {
			positions = ["RB"];
			const rand = Math.random();

			const rbs = this.playersOnField[o].RB ?? [];

			if (rand < 0.5 || rbs.length === 0) {
				positions.push("QB");
			} else if (rand < 0.57 || rbs.length === 0) {
				positions.push("WR");
			}

			this.updatePlayersOnField("run");
			const penInfo = this.checkPenalties("beforeSnap");

			if (penInfo) {
				return 0;
			}
		}

		// Scrambles tend to be longer runs
		const scrambleModifier = qbScramble ? 3 : 1;

		const eligible = tactics
			? getPlayers(this.playersOnField[o], positions)
			: undefined;
		const p =
			scramblingPlayer ??
			(eligible
				? (eligible.find(
						(candidate) => candidate.id === tactics!.decision.runnerPid,
					) ?? this.chooseCoachPlayer(eligible, "rushing"))
				: this.pickPlayer(o, "rushing", positions));
		if (this.lastCoachCall) {
			this.lastCoachCall.runnerPid = p.id;
		}
		if (tactics && !qbScramble) {
			const blockers = {
				...this.playersOnField[o],
				RB: (this.playersOnField[o].RB ?? []).filter(
					(candidate) => candidate !== p,
				),
			};
			this.team[o].compositeRating.runBlocking =
				getBlockingFactors(blockers)[1];
		}

		if (!qbScramble) {
			rbw = new Map();

			const addBlockAttempt = (
				p: PlayerGameSim,
				type: "OL" | "Other",
				baselineRatio: number,
			) => {
				// This roughly ranges from 1 to 1.25
				const ratio =
					p.compositeRating.runBlocking /
					this.team[d].compositeRating.runStopping;

				// Scale to roughly 50%-95%
				const probWin = helpers.bound(
					(ratio - baselineRatio) * (0.65 / 0.25) + 0.3,
					0,
					0.96,
				);
				const won = Math.random() < probWin;
				rbw!.set(p, {
					type,
					won,
				});

				rbCounts[`a${type}`] += 1;
				if (won) {
					rbCounts[`w${type}`] += 1;
				}
			};

			// OL always block, TE and RB sometimes do
			const ol = this.playersOnField[o].OL;
			if (ol) {
				for (const p2 of ol) {
					addBlockAttempt(p2, "OL", 1);
				}
			}
			const te = this.playersOnField[o].TE;
			if (te) {
				for (const p2 of te) {
					if (p !== p2 && Math.random() < 0.75) {
						addBlockAttempt(p2, "Other", 0.85);
					}
				}
			}
			const rb = this.playersOnField[o].RB;
			if (rb) {
				for (const p2 of rb) {
					if (p !== p2 && Math.random() < 0.25) {
						addBlockAttempt(p2, "Other", 0.6);
					}
				}
			}
		}

		const qb = this.getTopPlayerOnField(o, "QB");
		this.playByPlay.logEvent({
			type: "handoff",
			clock: this.clock,
			t: o,
			names: p === qb ? [qb.name] : [qb.name, p.name],
		});

		// Bound is so (in extreme contrived cases like 0 ovr teams) meanYds can't go too far above/below the truncGauss limits
		let meanYds = helpers.bound(
			(scrambleModifier *
				(3.5 *
					0.5 *
					(p.compositeRating.rushing +
						this.team[o].compositeRating.runBlocking))) /
				this.team[d].compositeRating.runStopping,
			-5,
			15,
		);
		let spread = 6;
		if (style) {
			// Deliberate game-design adjustments, not claimed NFL coefficients. Each
			// concept changes the native rating matchup, personnel, timing, or spread.
			const front = this.playersOnField[d];
			const edge = [
				...(front.LB ?? []),
				...(front.CB ?? []),
				...(front.S ?? []),
			];
			const edgeSpeed =
				edge.reduce(
					(sum, defender) => sum + defender.compositeRating.speed,
					0,
				) / Math.max(1, edge.length);
			if (["outside", "toss", "reverse"].includes(style)) {
				meanYds += (p.compositeRating.speed - edgeSpeed) * 5;
				spread = style === "reverse" ? 9 : style === "toss" ? 8 : 7;
			} else if (style === "power" || style === "qbPower") {
				meanYds +=
					(this.team[o].compositeRating.runBlocking /
						Math.max(0.01, this.team[d].compositeRating.runStopping) -
						1) *
					2;
				spread = 4;
			} else if (style === "counter") {
				meanYds += (p.compositeRating.rushing - 0.5) * 2;
				spread = 8;
			} else if (style === "draw") {
				meanYds += (tactics!.defense.rushers - 4) * 0.75;
				spread = 5;
			} else if (style === "sneak") {
				meanYds = helpers.bound(meanYds / 3, -1, 3);
				spread = 1;
			}
		}
		const referenceYards =
			style && style !== "sneak" ? this.sampleCoachReference("run") : undefined;
		let ydsRaw = Math.round(
			referenceYards !== undefined
				? referenceYards + meanYds - 3.5
				: truncGauss(
						helpers.bound(meanYds, -5, 15),
						spread,
						-5,
						style === "sneak" ? 3 : 15,
					),
		);

		// Observed rushing yards already include breakaways and tackles for loss.
		// These corrections belong only to the native truncated-normal fallback.
		if (referenceYards === undefined) {
			if (style !== "sneak" && Math.random() < 0.01) {
				ydsRaw += randInt(0, 109);
			}

			// Fewer TFL
			if (ydsRaw < 0) {
				ydsRaw += randInt(0, 5);
			}
		}

		ydsRaw = Math.round(ydsRaw * g.get("rushYdsFactor"));

		const yds = this.currentPlay.boundedYds(ydsRaw);
		const dt =
			randInt(2, 4) +
			Math.abs(yds) / 10 +
			(qbScramble ? 0 : (tactics?.call?.setupSeconds ?? 0));

		this.checkPenalties("run", {
			ballCarrier: p,
			playYds: yds,
		});

		const { td, safety } = this.currentPlay.addEvent({
			type: "rus",
			p,
			yds,
			rbw,
		});

		if (td) {
			this.currentPlay.addEvent({
				type: "rusTD",
				p,
			});
		} else if (safety) {
			this.doSafety();
		} else {
			this.doTackle({
				ydsFromScrimmage: yds,
			});
		}

		this.playByPlay.logEvent({
			type: "run",
			clock: this.clock,
			names: [p.name],
			totalRusTD: this.allStarGame
				? undefined
				: p.seasonStats["rusTD"] + p.stat["rusTD"],
			safety,
			t: o,
			td,
			twoPointConversionTeam: this.twoPointConversionTeam,
			yds,
		});

		// Fumble after run... only if nothing else is going on, too complicated otherwise
		if (!td && !safety) {
			if (Math.random() < this.probFumble(p)) {
				this.awaitingAfterTouchdown = false; // In case set by this.advanceYds

				return dt + this.doFumble(p, 0);
			}
		}

		return dt;
	}

	doSpike() {
		this.updatePlayersOnField("pass");
		if (this.checkPenalties("beforeSnap")) {
			return 0;
		}
		const qb = this.getTopPlayerOnField(this.o, "QB");
		this.currentPlay.addEvent({ type: "spike", qb });
		this.playByPlay.logEvent({
			type: "spike",
			clock: this.clock,
			names: [qb.name],
			t: this.o,
		});
		this.lastCoachCall = { name: "Spike", play: "spike", passerPid: qb.id };
		return 2;
	}

	doKneel(separateRunoff = false) {
		const o = this.o;

		this.updatePlayersOnField("run");

		const qb = this.getTopPlayerOnField(o, "QB");

		const yds = randInt(0, -YARDS_NEEDED_TO_KNEEL);

		this.currentPlay.addEvent({
			type: "kneel",
			p: qb,
			yds,
		});

		this.playByPlay.logEvent({
			type: "kneel",
			clock: this.clock,
			names: [qb.name],
			t: o,
			yds,
		});

		if (separateRunoff) {
			// The native automatic kneel bundles its runoff into the play duration.
			// For a coach-selected kneel, leave that time available for a timeout.
			// Play.commit still stops the clock if this turns the ball over on downs.
			this.currentPlay.state.current.isClockRunning = true;
			return ESTIMATED_SECONDS_PER_KNEEL_TIMEOUT;
		}

		const dt = randInt(
			ESTIMATED_SECONDS_PER_KNEEL - 1,
			ESTIMATED_SECONDS_PER_KNEEL,
		);

		return dt;
	}

	// Call this before actually advancing the ball, because different logic will apply if it's a spot foul or not
	checkPenalties(
		playType: PenaltyPlayType,
		{
			ballCarrier,
			incompletePass = false,
			playYds = 0,
		}: {
			ballCarrier?: PlayerGameSim;
			incompletePass?: boolean;
			playYds?: number;
		} = {
			ballCarrier: undefined,
			incompletePass: false,
			playYds: 0,
		},
	): boolean {
		// No penalties during two-point conversion, because it is not handled well currently (no logic to support retrying conversion/xp)
		if (this.currentPlay.state.current.twoPointConversionTeam !== undefined) {
			return false;
		}

		// At most 2 penalties on a play, otherwise it can get tricky to figure out what to accept (need to consider the other coach as intelligent and anticipate what he would do, minimax)
		const maxNumPenaltiesAllowed = 2 - this.currentPlay.numPenalties;
		if (maxNumPenaltiesAllowed <= 0) {
			return false;
		}

		const foulRateFactor = g.get("foulRateFactor");

		let called = penaltiesByPlayType[playType].filter(
			(pen) => Math.random() < pen.probPerPlay * foulRateFactor,
		);

		if (called.length === 0) {
			// if (called.length === 0 && playType !== "puntReturn") {
			return false;
		}

		// Always do multiple penalties for testing
		/*called = penaltiesByPlayType[playType].slice();*/

		if (called.length > maxNumPenaltiesAllowed) {
			shuffle(called);
			called = called.slice(0, maxNumPenaltiesAllowed);
		}

		const scrimmage = this.currentPlay.state.current.scrimmage;

		const penInfos = called.map((pen) => {
			let spotYds: number | undefined;

			const t =
				pen.side === "offense"
					? this.currentPlay.state.current.o
					: this.currentPlay.state.current.d;

			const isReturn =
				playType === "kickoffReturn" || playType === "puntReturn";

			const tackOn =
				(pen.tackOn && playYds > 0 && !incompletePass) ||
				(isReturn && pen.side === "defense");

			if ((pen.spotFoul || (isReturn && pen.side === "offense")) && !tackOn) {
				if (pen.side === "offense" && playYds > 0) {
					// Offensive spot foul - only when past the line of scrimmage
					spotYds = randInt(1, playYds);

					// Don't let it be in the endzone, otherwise shit gets weird with safeties
					if (spotYds + scrimmage < 1) {
						spotYds = 1 - scrimmage;
					}
				} else if (pen.side === "defense" && !isReturn) {
					// Defensive spot foul - could be in secondary too
					spotYds = randInt(0, playYds);
				}

				if (spotYds !== undefined) {
					// On kickoff returns, penalties are very unlikely to occur extremely deep
					if (playType === "kickoffReturn" && spotYds + scrimmage <= 10) {
						spotYds += randInt(10, playYds);
					}
				}
			} else if (tackOn) {
				spotYds = playYds;
			}

			if (spotYds !== undefined) {
				if (spotYds + scrimmage > 99) {
					spotYds = 99 - scrimmage;
				}
			}

			return {
				automaticFirstDown: !!pen.automaticFirstDown,
				name: pen.name,
				penYds: pen.yds,
				posOdds: pen.posOdds,
				spotYds,
				t,
				tackOn,
			};
		});

		for (const penInfo of penInfos) {
			let p: PlayerGameSim | undefined;

			const posOdds = penInfo.posOdds;

			if (posOdds !== undefined) {
				const positionsOnField = helpers.keys(this.playersOnField[penInfo.t]);
				const positionsForPenalty = helpers.keys(posOdds);
				const positions = positionsOnField.filter((pos) =>
					positionsForPenalty.includes(pos),
				);

				if (positions.length > 0) {
					// https://github.com/microsoft/TypeScript/issues/21732
					// @ts-expect-error
					const pos = choice(positions, (pos2) => posOdds[pos2]);

					const players = this.playersOnField[penInfo.t][pos];

					if (players !== undefined && players.length > 0) {
						p = choice(players);
					}
				}

				if (!p) {
					p = this.pickPlayer(penInfo.t);
				}

				// Ideally, when notBallCarrier is set, we should ensure that p is not the ball carrier.
			}

			this.currentPlay.addEvent({
				type: "penalty",
				p,
				automaticFirstDown: penInfo.automaticFirstDown,
				name: penInfo.name,
				penYds: penInfo.penYds,
				spotYds: penInfo.spotYds,
				t: penInfo.t,
				tackOn: penInfo.tackOn,
			});

			this.playByPlay.logEvent({
				type: "flag",
				clock: this.clock,
			});
		}

		return true;
	}

	updatePlayingTime(possessionTime: number) {
		this.recordStat(this.o, undefined, "timePos", possessionTime);
		const onField = new Set();

		for (const t of teamNums) {
			// Get rid of this after making sure playersOnField is always set, even for special teams
			if (this.playersOnField[t] === undefined) {
				continue;
			}

			for (const players of Object.values(this.playersOnField[t])) {
				// Update minutes (overall, court, and bench)
				for (const p of players) {
					onField.add(p.id);
					p.stat.min += possessionTime;
					this.team[t].stat.min += possessionTime;
					p.stat.courtTime += possessionTime;

					// This used to be 0.04. Increase more to lower PT
					p.stat.energy += -0.08 * (1 - p.compositeRating.endurance);

					if (p.stat.energy < 0) {
						p.stat.energy = 0;
					}
				}
			}

			for (const p of this.team[t].player) {
				if (!onField.has(p.id)) {
					p.stat.benchTime += possessionTime;
					p.stat.energy += 0.5;

					if (p.stat.energy > 1) {
						p.stat.energy = 1;
					}
				}
			}
		}
	}

	injuries() {
		if (this.baseInjuryRate === 0) {
			return;
		}

		for (const t of teamNums) {
			// Get rid of this after making sure playersOnField is always set, even for special teams
			if (this.playersOnField[t] === undefined) {
				continue;
			}

			const onField = new Set<any>();

			for (const players of Object.values(this.playersOnField[t])) {
				for (const p of players) {
					onField.add(p);
				}
			}

			for (const p of onField) {
				// Modulate injuryRate by age - assume default is 25 yo, and increase/decrease by 3%
				const injuryRate = getInjuryRate(
					this.baseInjuryRate,
					p.age,
					p.injury.gamesRemaining > 0,
				);

				if (Math.random() < injuryRate) {
					// 50% as many injuries for some positions
					if (FEWER_INJURIES_POS.has(p.pos) && Math.random() < 0.5) {
						continue;
					}

					p.injured = true;
					p.newInjury = true;
					this.playByPlay.logEvent({
						type: "injury",
						clock: this.clock,
						injuredPID: p.id,
						names: [`${p.pos} ${p.name}`],
						t,
					});
				}
			}
		}
	}

	pickPlayer(
		t: TeamNum,
		rating?: CompositeRating,
		positions: Position[] = POSITIONS,
		power: number = 1,
	) {
		const players = getPlayers(this.playersOnField[t], positions);
		const weightFunc =
			rating !== undefined
				? (p: PlayerGameSim) =>
						(p.compositeRating[rating] * fatigue(p.stat.energy, p.injured)) **
						power
				: undefined;
		return choice(players, weightFunc);
	}

	// Pass undefined as p for some team-only stats
	recordStat(
		t: TeamNum,
		p: PlayerGameSim | undefined,
		s: string,
		amt: number = 1,
		remove?: boolean,
	) {
		const signedAmount = remove ? -amt : amt;

		const isLng = s.endsWith("Lng");

		if (p !== undefined) {
			if (s === "gs" || s === "gp") {
				// gs check is in case player starts on offense and defense, only record once
				p.stat[s] = 1;
			} else if (isLng) {
				p.stat[s] = this.lngTracker.log("player", p.id, s, amt, remove);
			} else {
				p.stat[s] += signedAmount;
			}
		}

		if (s !== "gs" && s !== "gp") {
			const teamStat = this.team[t].stat;

			if (isLng) {
				teamStat[s] = this.lngTracker.log("player", t, s, amt, remove);
			} else {
				teamStat[s] += signedAmount;
			}

			if (p !== undefined) {
				const logAmount = isLng ? p.stat[s] : signedAmount;
				this.playByPlay.logStat(t, p.id, s, logAmount);
			} else if (
				p === undefined &&
				(s === "pts" ||
					s === "pen" ||
					s === "penYds" ||
					s === "sPts" ||
					s === "sAtt")
			) {
				// Team points, and also team penalties like delay of game, for the team penalty display at the top
				this.playByPlay.logStat(t, undefined, s, signedAmount);

				if (s === "pts") {
					const qtr = teamStat.ptsQtrs.length - 1;
					teamStat.ptsQtrs[qtr] += signedAmount;
				}
			}
		}
	}
}

export default GameSim;
