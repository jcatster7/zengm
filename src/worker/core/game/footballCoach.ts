import type {
	FootballCoachDecision,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import type { Game } from "../../../common/types.ts";
import { validateFootballCoachDecision } from "../../../common/footballCoachPlaybook.ts";

// Only this worker owns the live native simulator. The UI gets detached snapshots
// and submits a revision token, never a replacement score, roster, or game result.
export class FootballCoachController {
	private session: FootballCoachSession | undefined;
	private resolveDecision:
		| ((decision: FootballCoachDecision | undefined) => void)
		| undefined;
	private automaticUntil: "end" | "twoMinute" | undefined;
	private completion: Promise<void> | undefined;
	private saveStarted = false;

	assertCanSimulate(lid: number) {
		if (this.session?.lid === lid && this.session.requiresRecovery) {
			throw new Error(this.session.error);
		}
	}

	isActive() {
		return (
			this.session !== undefined &&
			!["complete", "error"].includes(this.session.status)
		);
	}

	get(lid: number) {
		return this.session?.lid === lid ? structuredClone(this.session) : null;
	}

	start(
		input: Pick<
			FootballCoachSession,
			"lid" | "gid" | "teams" | "rosters" | "controlledTeam"
		>,
	) {
		this.assertCanSimulate(input.lid);
		if (input.controlledTeam !== 0 && input.controlledTeam !== 1) {
			throw new Error("Choose your team before starting a coached game.");
		}
		if (this.isActive()) {
			throw new Error("Finish the current coached game first.");
		}
		this.session = {
			...structuredClone(input),
			controlledTeam: input.controlledTeam,
			controlledTid: input.teams[input.controlledTeam].tid,
			sessionId: crypto.randomUUID(),
			revision: 0,
			status: "starting",
		};
		this.resolveDecision = undefined;
		this.automaticUntil = undefined;
		this.completion = undefined;
		this.saveStarted = false;
		return this.get(input.lid)!;
	}

	track(completion: Promise<void>) {
		this.completion = completion;
	}

	setReference(
		lid: number,
		reference: NonNullable<FootballCoachSession["reference"]>,
	) {
		if (this.session?.lid === lid) {
			this.session.reference = structuredClone(reference);
		}
	}

	private requireSession(lid: number, sessionId: string) {
		if (
			!this.session ||
			this.session.lid !== lid ||
			this.session.sessionId !== sessionId
		) {
			throw new Error(
				"This coaching session belongs to a different game or league.",
			);
		}
		return this.session;
	}

	async next(
		lid: number,
		snapshot: FootballCoachSnapshot,
	): Promise<FootballCoachDecision | undefined> {
		const session = this.session;
		if (
			!session ||
			session.lid !== lid ||
			session.gid !== snapshot.gid ||
			!this.isActive()
		) {
			throw new Error(
				"The active coaching game no longer matches this league.",
			);
		}
		if (this.resolveDecision) {
			throw new Error("A coaching decision is already pending.");
		}
		if (this.automaticUntil === "end") {
			return;
		}
		if (this.automaticUntil === "twoMinute") {
			if (
				snapshot.quarter < snapshot.numPeriods ||
				(snapshot.quarter === snapshot.numPeriods && snapshot.clock > 2)
			) {
				return;
			}
			this.automaticUntil = undefined;
		}
		// The league's chosen club is captured when the game starts. UI payloads
		// cannot change ownership, even after a possession change or a refresh.
		if (snapshot.offense !== session.controlledTeam) {
			if (snapshot.stage === "play" && !snapshot.allowedPlays.includes("run")) {
				return;
			}
			if (
				snapshot.stage === "clock" &&
				!snapshot.canTimeout[session.controlledTeam]
			) {
				return;
			}
		}
		session.snapshot = {
			...structuredClone(snapshot),
			controlledTeam: session.controlledTeam,
		};
		session.revision += 1;
		session.status = "waiting";
		return await new Promise((resolve) => {
			this.resolveDecision = resolve;
		});
	}

	submit(
		lid: number,
		input: {
			sessionId: string;
			revision: number;
			decision: FootballCoachDecision;
		},
	) {
		const session = this.requireSession(lid, input.sessionId);
		if (
			session.status !== "waiting" ||
			!this.resolveDecision ||
			input.revision !== session.revision
		) {
			throw new Error(
				"That play has already advanced. Use the current decision.",
			);
		}
		const snapshot = session.snapshot!;
		const decision = input.decision;
		if (decision === undefined) {
			throw new Error("Invalid coaching decision.");
		}
		validateFootballCoachDecision(decision, snapshot);
		const resolve = this.resolveDecision;
		this.resolveDecision = undefined;
		session.status = "running";
		resolve(structuredClone(decision));
		return this.get(lid);
	}

	automate(lid: number, sessionId: string, until: "end" | "twoMinute") {
		const session = this.requireSession(lid, sessionId);
		if (until !== "end" && until !== "twoMinute") {
			throw new Error("Invalid simulation target.");
		}
		if (!this.isActive()) {
			return;
		}
		if (session.status === "saving") {
			return;
		}
		this.automaticUntil = until;
		session.status = "running";
		const resolve = this.resolveDecision;
		this.resolveDecision = undefined;
		resolve?.(undefined);
	}

	saving(lid: number) {
		if (this.session?.lid === lid && this.isActive()) {
			this.saveStarted = true;
			this.session.status = "saving";
		}
	}

	updateFinalSnapshot(lid: number, snapshot: FootballCoachSnapshot) {
		if (
			this.session?.lid !== lid ||
			this.session.gid !== snapshot.gid ||
			!this.isActive()
		) {
			throw new Error(
				"The final game does not match the active coaching session.",
			);
		}
		this.session.snapshot = {
			...structuredClone(snapshot),
			controlledTeam: this.session.controlledTeam,
		};
		this.session.revision += 1;
	}

	complete(
		lid: number,
		boxScoreUrl: string,
		savedGame?: Pick<Game, "gid" | "teams">,
	) {
		if (this.session?.lid !== lid) {
			return;
		}
		if (savedGame) {
			if (savedGame.gid !== this.session.gid) {
				throw new Error("The saved game does not match the coaching session.");
			}
			// Native persistence diagnoses injuries after the final simulation
			// snapshot. Reconcile only that metadata, keeping live totals intact.
			for (const team of this.session.snapshot?.boxScore?.teams ?? []) {
				const savedTeam = savedGame.teams.find((t) => t.tid === team.id);
				const savedPlayers = new Map(
					savedTeam?.players.map((player) => [player.pid, player]),
				);
				for (const player of team.players) {
					const savedPlayer = savedPlayers.get(player.id);
					if (savedPlayer) {
						player.injury = {
							...structuredClone(savedPlayer.injury),
							playingThrough: !!savedPlayer.injury.playingThrough,
						};
					}
				}
			}
		}
		this.session.status = "complete";
		this.session.boxScoreUrl = boxScoreUrl;
		this.resolveDecision = undefined;
	}

	fail(lid: number, error: unknown) {
		if (this.session?.lid !== lid) {
			return;
		}
		this.session.status = "error";
		this.session.error =
			error instanceof Error
				? error.message
				: "The coached game could not be completed.";
		if (this.saveStarted) {
			this.session.requiresRecovery = true;
			this.session.error +=
				" Saving may have partially changed league statistics. Simulation is blocked to prevent duplicate results. Reload the app and restore this league from a known-good export before simulating again.";
		}
		const resolve = this.resolveDecision;
		this.resolveDecision = undefined;
		resolve?.(undefined);
	}

	async finishBeforeClosingLeague() {
		if (!this.session) {
			return;
		}
		if (this.isActive()) {
			this.automate(this.session.lid, this.session.sessionId, "end");
		}
		await this.completion;
		if (this.session.requiresRecovery) {
			throw new Error(this.session.error);
		}
	}
}

export const footballCoach = new FootballCoachController();
