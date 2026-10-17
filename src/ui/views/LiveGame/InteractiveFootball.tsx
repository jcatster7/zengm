import { Fragment, useEffect, useRef, useState } from "react";
import fastDeepEqual from "fast-deep-equal";
import type {
	FootballCoachDecision,
	FootballCoachLineupPlayer,
	FootballCoachPlay,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import {
	FOOTBALL_COACH_CALLS,
	FOOTBALL_COACH_DEFAULT_DEFENSES,
	FOOTBALL_COACH_DEFENSES,
	FOOTBALL_COACH_PERSONNEL,
	FOOTBALL_COACH_ROUTES,
	getFootballCoachDefense,
	getFootballCoachRoute,
	type FootballCoachCallDefinition,
	type FootballCoachCallId,
	type FootballCoachDefenseId,
	type FootballCoachFormation,
	type FootballCoachRoute,
} from "../../../common/footballCoachPlaybook.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { formatClock } from "../../../common/formatClock.ts";
import type { TeamNum } from "../../../common/types.ts";
import { TeamLogoInline } from "../../components/TeamLogoInline.tsx";
import { useBlocker } from "../../hooks/useBlocker.ts";
import { TEAM_NUMS_DISPLAY_ORDER } from "../../util/boxScoreDisplayOrder.ts";
import { helpers } from "../../util/helpers.ts";
import {
	formatDownAndDistance,
	getText,
	scrimmageToFieldPos,
} from "../../util/processLiveGameEvents.football.tsx";
import { toWorker } from "../../util/toWorker.ts";
import {
	CoachField,
	CoachPlayDiagram,
	matchesCoachRole,
	pinCoachPlayer,
} from "./CoachField.tsx";
import { CoachPlayerDetails, CoachRoster } from "./CoachRoster.tsx";
import { FootballCoachDataPanel } from "./FootballCoachDataPanel.tsx";

const playLabels: Record<
	FootballCoachPlay,
	{ label: string; description: string }
> = {
	run: { label: "Run", description: "Hand off and attack on the ground" },
	pass: { label: "Pass", description: "Drop back and find a receiver" },
	kneel: { label: "Kneel", description: "Protect possession and take a knee" },
	spike: {
		label: "Spike",
		description: "Stop the clock at the cost of a down",
	},
	punt: { label: "Punt", description: "Kick away and change field position" },
	fieldGoal: { label: "Field goal", description: "Attempt three points" },
	kickoff: { label: "Kick off", description: "Send the ball downfield" },
	onsideKick: {
		label: "Onside kick",
		description: "Try to recover the kickoff",
	},
	extraPoint: { label: "Extra point", description: "Kick for one point" },
	twoPointConversion: {
		label: "Go for two",
		description: "Try a two-point conversion",
	},
};
const groupLabels = { run: "Run", pass: "Pass", rpo: "RPO", trick: "Trick" };
const isFinished = (session: FootballCoachSession | null) =>
	session?.status === "complete" || session?.status === "error";
const statusOrder: Record<FootballCoachSession["status"], number> = {
	starting: 0,
	waiting: 1,
	running: 2,
	saving: 3,
	complete: 4,
	error: 4,
};

const lastSnapLineup = (
	players: FootballCoachSnapshot["playersOnField"][0],
): FootballCoachLineupPlayer[] => {
	const counts = new Map<string, number>();
	return players.map((player) => {
		const count = (counts.get(player.pos) ?? 0) + 1;
		counts.set(player.pos, count);
		return { ...player, slot: `${player.pos}${count}` };
	});
};

const RecentPlays = ({
	session,
	snapshot,
}: {
	session: FootballCoachSession;
	snapshot: FootballCoachSnapshot;
}) => (
	<section className="football-coach-panel football-coach-log">
		<h3 className="football-coach-panel-title">Play by play</h3>
		{snapshot.lastCall ? (
			<div className="football-coach-muted mb-2">
				Last call · {snapshot.lastCall.name}
				{snapshot.lastCall.route
					? ` · ${getFootballCoachRoute(snapshot.lastCall.route).name}`
					: ""}
			</div>
		) : null}
		<div
			className="football-coach-log-items"
			role="log"
			aria-label="Recent plays"
		>
			{snapshot.events.length === 0 ? (
				<p className="football-coach-muted mb-0">
					The opening kickoff is next.
				</p>
			) : null}
			{snapshot.events
				.map((event, i) => {
					if (event.type === "clock" || event.type === "timeouts") {
						return null;
					}
					return (
						<div className="football-coach-log-item" key={i}>
							<div className="football-coach-log-time">
								{"clock" in event ? formatClock(event.clock) : "—"}
								{"t" in event ? (
									<span className="d-block">
										{session.teams[event.t].abbrev}
									</span>
								) : null}
							</div>
							<div>
								{event.type === "removeLastScore"
									? "Penalty overturned the score."
									: getText(event, snapshot.numPeriods)}
							</div>
						</div>
					);
				})
				.reverse()}
		</div>
	</section>
);

export const InteractiveFootball = () => {
	const [session, setSession] = useState<FootballCoachSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [pollError, setPollError] = useState<string>();
	const [tab, setTab] = useState<"playbook" | "roster" | "data">("playbook");
	const [group, setGroup] =
		useState<FootballCoachCallDefinition["group"]>("run");
	const [personnel, setPersonnel] = useState<FootballCoachFormation | "all">(
		"all",
	);
	const [callId, setCallId] = useState<FootballCoachCallId>("insideZone");
	const [defenseId, setDefenseId] = useState<FootballCoachDefenseId>("base43");
	const [route, setRoute] = useState<FootballCoachRoute>();
	const [targetPid, setTargetPid] = useState<number>();
	const [runnerPid, setRunnerPid] = useState<number>();
	const [inspected, setInspected] = useState<{ team: TeamNum; pid: number }>();
	const mounted = useRef(false);
	const busyRef = useRef(false);
	const sessionRef = useRef<FootballCoachSession | null>(null);
	const { setDirty } = useBlocker({
		message:
			"This game is still in progress. Finish the game to save its result and player statistics before closing it.",
		okText: "Leave game",
		cancelText: "Keep playing",
	});

	const applySession = (next: FootballCoachSession | null) => {
		if (!mounted.current) {
			return;
		}
		const current = sessionRef.current;
		if (
			current &&
			next?.sessionId === current.sessionId &&
			(next.revision < current.revision ||
				(next.revision === current.revision &&
					statusOrder[next.status] < statusOrder[current.status]) ||
				(isFinished(current) && !isFinished(next)))
		) {
			return;
		}
		setPollError(undefined);
		// The worker returns detached clones. Preserve the current objects for
		// identical polls so the roster/data panels do not recompute their joins.
		// Compare all metadata too: reference availability can change at revision 0.
		if (
			current?.sessionId === next?.sessionId &&
			current?.revision === next?.revision &&
			current?.status === next?.status &&
			fastDeepEqual(current, next)
		) {
			return;
		}
		sessionRef.current = next;
		setSession(next);
	};

	useEffect(() => {
		mounted.current = true;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const next = await toWorker("actions", "getFootballCoach", undefined);
				if (!stopped) {
					applySession(next);
				}
			} catch (error_) {
				if (!stopped && mounted.current && !isFinished(sessionRef.current)) {
					setPollError(
						error_ instanceof Error
							? error_.message
							: "Could not load the game.",
					);
				}
			} finally {
				if (!stopped && mounted.current) {
					setLoading(false);
					if (!isFinished(sessionRef.current)) {
						timer = setTimeout(poll, 750);
					}
				}
			}
		};
		void poll();
		return () => {
			stopped = true;
			mounted.current = false;
			clearTimeout(timer);
		};
	}, []);

	useEffect(() => {
		setDirty(session !== null && !isFinished(session));
	}, [session, setDirty]);

	const act = async (action: () => Promise<unknown>) => {
		if (busyRef.current) {
			return;
		}
		busyRef.current = true;
		setBusy(true);
		setError(undefined);
		try {
			await action();
			applySession(await toWorker("actions", "getFootballCoach", undefined));
		} catch (error_) {
			if (mounted.current) {
				setError(
					error_ instanceof Error
						? error_.message
						: "The action could not be completed.",
				);
			}
		} finally {
			busyRef.current = false;
			if (mounted.current) {
				setBusy(false);
			}
		}
	};

	const submit = (decision: FootballCoachDecision) => {
		if (!session || session.status !== "waiting") {
			return;
		}
		void act(() =>
			toWorker("actions", "submitFootballCoach", {
				sessionId: session.sessionId,
				revision: session.revision,
				decision,
			}),
		);
	};

	if (loading) {
		return <p role="status">Preparing the game…</p>;
	}
	if (!session) {
		return (
			<>
				{error || pollError ? (
					<p className="text-danger" role="alert">
						{error ?? pollError}
					</p>
				) : null}
				<p>
					No active game. Open the weekly schedule and choose Sim game for your
					team.
				</p>
				<a href={helpers.leagueUrl(["daily_schedule"])}>Weekly schedule</a>
			</>
		);
	}

	const snapshot = session.snapshot;
	const controlledTeam = session.controlledTeam ?? 0;
	const ownOffense = snapshot?.offense === controlledTeam;
	const disabled = busy || session.status !== "waiting";
	const finished = isFinished(session);
	const period = snapshot
		? snapshot.quarter > snapshot.numPeriods
			? `OT${snapshot.quarter - snapshot.numPeriods}`
			: `Q${snapshot.quarter}`
		: "Pregame";
	const statusText = {
		starting: "Preparing the game…",
		waiting:
			snapshot?.stage === "clock"
				? "Manage the clock"
				: ownOffense
					? "Call your next play"
					: "Set your defense",
		running: "Play in progress…",
		saving: "Saving game results…",
		complete: "Final · Result and statistics saved",
		error: "Game stopped",
	}[session.status];
	const allowedCalls = ownOffense
		? FOOTBALL_COACH_CALLS.filter((entry) =>
				snapshot?.allowedCallIds?.includes(entry.id),
			)
		: [];
	const visibleCalls = allowedCalls.filter(
		(entry) =>
			entry.group === group &&
			(personnel === "all" || entry.formation === personnel),
	);
	const call:
		| (FootballCoachCallDefinition & { id: FootballCoachCallId })
		| undefined =
		visibleCalls.find((entry) => entry.id === callId) ?? visibleCalls[0];
	const allowedDefenses = FOOTBALL_COACH_DEFENSES.filter((entry) =>
		snapshot?.allowedDefenseIds?.includes(entry.id),
	);
	const defense =
		allowedDefenses.find((entry) => entry.id === defenseId) ??
		allowedDefenses[0];
	const preview = snapshot?.lineups?.offense[call?.formation ?? "11"] ?? [];
	const receivingRoles = call?.targetPositions ?? ["WR", "TE", "RB"];
	const runningRoles = call?.runnerPosition
		? [call.runnerPosition]
		: ["QB", "RB", "WR"];
	const eligibleReceivers =
		call && call.kind !== "run"
			? (snapshot?.eligibleReceivers ?? []).filter(
					(player) =>
						!player.injured &&
						matchesCoachRole(player, receivingRoles, preview),
				)
			: [];
	const eligibleRushers =
		call && call.kind !== "pass"
			? (snapshot?.eligibleRushers ?? []).filter(
					(player) =>
						!player.injured && matchesCoachRole(player, runningRoles, preview),
				)
			: [];
	const target =
		eligibleReceivers.find((player) => player.id === targetPid) ??
		eligibleReceivers.find((player) =>
			preview.some(
				(p) =>
					p.id === player.id &&
					receivingRoles.includes(
						p.slot.replace(/\d+$/, "") as "WR" | "TE" | "RB",
					),
			),
		) ??
		eligibleReceivers[0];
	const rushers = eligibleRushers.filter((player) => player.id !== target?.id);
	const runner =
		rushers.find((player) => player.id === runnerPid) ??
		rushers.find((player) =>
			preview.some(
				(p) =>
					p.id === player.id &&
					runningRoles.includes(p.slot.replace(/\d+$/, "")),
			),
		) ??
		rushers[0];
	const receivers = eligibleReceivers.filter(
		(player) => player.id !== runner?.id,
	);
	const selectedRoute =
		call?.kind !== "run" ? (route ?? call?.route) : undefined;
	const preSnap =
		!finished &&
		snapshot?.stage === "play" &&
		((ownOffense && allowedCalls.length > 0) ||
			(!ownOffense && allowedDefenses.length > 0));
	const lastClock = snapshot?.events.findLast(
		(event) => event.type === "clock",
	);
	const fieldSnapshot =
		snapshot && !preSnap && lastClock?.type === "clock"
			? {
					...snapshot,
					offense: lastClock.t,
					defense: (1 - lastClock.t) as TeamNum,
					scrimmage: lastClock.scrimmage,
					down: lastClock.down,
					toGo: lastClock.toGo,
					awaitingKickoff: lastClock.awaitingKickoff,
					awaitingAfterTouchdown: lastClock.awaitingAfterTouchdown,
				}
			: snapshot;
	const offenseLineup =
		snapshot && fieldSnapshot
			? preSnap
				? ownOffense
					? pinCoachPlayer(
							pinCoachPlayer(preview, target, receivingRoles),
							runner,
							runningRoles,
						)
					: preview
				: lastSnapLineup(snapshot.playersOnField[fieldSnapshot.offense])
			: [];
	const defenseLineup =
		snapshot && fieldSnapshot
			? preSnap
				? (snapshot.lineups?.defense[
						ownOffense
							? FOOTBALL_COACH_DEFAULT_DEFENSES[call?.formation ?? "11"]
							: (defense?.id ?? "base43")
					] ?? [])
				: lastSnapLineup(snapshot.playersOnField[fieldSnapshot.defense])
			: [];
	const inspectedPlayer = inspected
		? session.rosters?.[inspected.team]?.find(
				(player) => player.pid === inspected.pid,
			)
		: undefined;
	const chooseCall = (id: FootballCoachCallId) => {
		setCallId(id);
		setRoute(undefined);
		setTargetPid(undefined);
		setRunnerPid(undefined);
	};
	const chooseGroup = (next: FootballCoachCallDefinition["group"]) => {
		setGroup(next);
		const available = allowedCalls.filter((entry) => entry.group === next);
		const nextCall =
			available.find(
				(entry) => personnel === "all" || entry.formation === personnel,
			) ?? available[0];
		if (nextCall) {
			if (personnel !== "all" && nextCall.formation !== personnel) {
				setPersonnel("all");
			}
			chooseCall(nextCall.id);
		}
	};
	const choosePersonnel = (next: FootballCoachFormation | "all") => {
		setPersonnel(next);
		const available = allowedCalls.filter(
			(entry) => next === "all" || entry.formation === next,
		);
		const nextCall =
			available.find((entry) => entry.group === group) ?? available[0];
		if (nextCall) {
			setGroup(nextCall.group);
			chooseCall(nextCall.id);
		}
	};
	const selectFieldPlayer = (team: TeamNum, pid: number) => {
		setInspected({ team, pid });
		if (team === controlledTeam && ownOffense && preSnap && !disabled) {
			const canReceive = receivers.some((player) => player.id === pid);
			const canRun = rushers.some((player) => player.id === pid);
			const slotRole = offenseLineup
				.find((player) => player.id === pid)
				?.slot.replace(/\d+$/, "");
			if (
				canReceive &&
				(!canRun ||
					(slotRole && receivingRoles.includes(slotRole as "WR" | "TE" | "RB")))
			) {
				setTargetPid(pid);
			} else if (canRun) {
				setRunnerPid(pid);
			}
		}
	};
	const snap = () => {
		if (!snapshot || snapshot.stage !== "play") {
			return;
		}
		if (!ownOffense) {
			submit(defense ? { defenseId: defense.id } : { play: "auto" });
			return;
		}
		if (call) {
			submit({
				callId: call.id,
				...(target ? { targetPid: target.id, route: selectedRoute } : {}),
				...(runner ? { runnerPid: runner.id } : {}),
			});
		}
	};
	return (
		<div className="football-coach">
			<div className="football-coach-toolbar">
				<div>
					<div className="football-coach-eyebrow">Football GM · Game day</div>
					<h2 className="football-coach-heading">
						Coach {session.teams[controlledTeam].abbrev}
					</h2>
				</div>
				<div className="football-coach-toolbar-actions">
					{finished ? (
						<>
							{session.boxScoreUrl ? (
								<a
									className="football-coach-button is-primary"
									href={session.boxScoreUrl}
								>
									Box score
								</a>
							) : null}
							<a
								className="football-coach-button"
								href={helpers.leagueUrl(["daily_schedule"])}
							>
								Weekly schedule
							</a>
						</>
					) : (
						<>
							<button
								type="button"
								className="football-coach-button is-subtle"
								disabled={
									disabled ||
									!snapshot ||
									snapshot.quarter > snapshot.numPeriods ||
									(snapshot.quarter === snapshot.numPeriods &&
										snapshot.clock <= 2)
								}
								onClick={() =>
									void act(() =>
										toWorker("actions", "skipFootballCoach", {
											sessionId: session.sessionId,
											until: "twoMinute",
										}),
									)
								}
							>
								Final 2:00
							</button>
							<button
								type="button"
								className="football-coach-button is-subtle"
								disabled={disabled}
								onClick={() =>
									void act(() =>
										toWorker("actions", "finishFootballCoach", {
											sessionId: session.sessionId,
										}),
									)
								}
							>
								Finish automatically
							</button>
						</>
					)}
				</div>
			</div>
			{error || session.error || pollError ? (
				<div className="football-coach-error" role="alert">
					{error ?? session.error ?? pollError}
				</div>
			) : null}
			<div className="football-coach-scoreboard">
				{TEAM_NUMS_DISPLAY_ORDER.map((t, index) => (
					<Fragment key={t}>
						{index === 1 ? (
							<div className="football-coach-clock" aria-live="polite">
								<div className="football-coach-eyebrow">
									{session.status === "complete" ? "Final" : period}
								</div>
								<div className="football-coach-time">
									{session.status === "complete"
										? "FINAL"
										: snapshot
											? formatClock(snapshot.clock)
											: "—"}
								</div>
								<div className="football-coach-muted" style={{ fontSize: 10 }}>
									{!finished && snapshot?.isClockRunning
										? "Clock running"
										: "Clock stopped"}
								</div>
							</div>
						) : null}
						<div
							className="football-coach-team"
							style={{ borderTopColor: session.teams[t].colors[0] }}
						>
							<TeamLogoInline
								imgURL={session.teams[t].imgURL}
								imgURLSmall={session.teams[t].imgURLSmall}
								size={37}
							/>
							<div className="football-coach-team-copy">
								<div className="football-coach-team-meta">
									{t === 0 ? "Home" : "Away"}
									{t === controlledTeam ? " · Your team" : ""}
								</div>
								<div
									className="football-coach-team-name"
									title={`${session.teams[t].region} ${session.teams[t].name}`}
								>
									{session.teams[t].name}
								</div>
								<div
									className="football-coach-timeouts"
									aria-label={`${snapshot?.timeouts[t] ?? 3} timeouts remaining`}
								>
									{Array.from(
										{ length: Math.max(3, snapshot?.timeouts[t] ?? 3) },
										(_, i) => (
											<span
												key={i}
												className={
													i < (snapshot?.timeouts[t] ?? 3)
														? "is-available"
														: undefined
												}
											/>
										),
									)}
								</div>
							</div>
							<div>
								<div className="football-coach-score">
									{snapshot?.teams[t].pts ?? 0}
								</div>
								{snapshot?.teams[t].sPts !== undefined ? (
									<small>Shootout {snapshot.teams[t].sPts}</small>
								) : null}
							</div>
						</div>
					</Fragment>
				))}
			</div>
			<div className="football-coach-situation">
				{snapshot ? (
					<strong className="football-coach-possession">
						{session.teams[snapshot.offense].abbrev} ·{" "}
						{snapshot.awaitingKickoff !== undefined
							? "Kickoff"
							: snapshot.awaitingAfterTouchdown
								? "After touchdown"
								: formatDownAndDistance(
										snapshot.down,
										snapshot.toGo,
										snapshot.scrimmage,
									)}{" "}
						·{" "}
						{scrimmageToFieldPos(
							snapshot.scrimmage,
							session.teams[snapshot.offense].abbrev,
							session.teams[snapshot.defense].abbrev,
						)}
					</strong>
				) : (
					<span />
				)}
				<span className="football-coach-muted" role="status">
					{statusText}
				</span>
			</div>
			{snapshot ? (
				<div className="football-coach-layout">
					<div>
						<CoachField
							snapshot={fieldSnapshot ?? snapshot}
							preview={preSnap}
							session={session}
							call={preSnap && ownOffense ? call : undefined}
							route={selectedRoute}
							offense={offenseLineup}
							defense={defenseLineup}
							targetPid={preSnap && ownOffense ? target?.id : undefined}
							runnerPid={preSnap && ownOffense ? runner?.id : undefined}
							inspected={inspected}
							onSelect={selectFieldPlayer}
						/>
						<p
							className="football-coach-muted mt-2 mb-0"
							style={{ fontSize: 10 }}
						>
							{preSnap
								? "Formation preview. The opponent chooses its personnel at the snap. Routes show your call, not the completed play."
								: "Players from the last snap. The play log records the result."}
						</p>
						{inspectedPlayer ? (
							<details open className="football-coach-panel mt-3">
								<summary className="football-coach-panel-title">
									Player details
								</summary>
								<CoachPlayerDetails
									player={inspectedPlayer}
									energy={
										snapshot.eligibleReceivers?.find(
											(player) => player.id === inspectedPlayer.pid,
										)?.energy ??
										snapshot.eligibleRushers?.find(
											(player) => player.id === inspectedPlayer.pid,
										)?.energy
									}
								/>
							</details>
						) : null}
						<RecentPlays session={session} snapshot={snapshot} />
					</div>
					<div>
						<div
							className="football-coach-tabs"
							role="tablist"
							aria-label="Game controls"
						>
							{(["playbook", "roster", "data"] as const).map((value) => (
								<button
									type="button"
									key={value}
									className={`football-coach-tab${tab === value ? " is-active" : ""}`}
									role="tab"
									aria-selected={tab === value}
									onClick={() => setTab(value)}
								>
									{value === "playbook"
										? "Playbook"
										: value === "roster"
											? "Roster & ratings"
											: "Data"}
								</button>
							))}
						</div>
						{tab === "roster" ? (
							<div className="football-coach-panel">
								<CoachRoster
									session={session}
									inspected={inspected}
									onSelect={(team, pid) => setInspected({ team, pid })}
								/>
							</div>
						) : tab === "data" ? (
							<FootballCoachDataPanel session={session} />
						) : (
							<>
								{finished ? (
									<div className="football-coach-panel football-coach-empty">
										<h3 className="football-coach-panel-title">{statusText}</h3>
										{session.status === "complete" ? (
											<p className="mb-0">
												This result, player statistics, and injuries now count
												in your league.
											</p>
										) : (
											<p className="mb-0">
												{session.requiresRecovery
													? "Keep this league open and follow the error message to recover the game."
													: "Return to the weekly schedule to continue."}
											</p>
										)}
									</div>
								) : snapshot.stage === "clock" ? (
									<section className="football-coach-panel">
										<div className="football-coach-eyebrow">Between plays</div>
										<h3 className="football-coach-panel-title mt-1">
											Manage the clock
										</h3>
										<p className="football-coach-muted">
											{snapshot.isClockRunning
												? "Time is paused here so you can call a timeout before the next runoff."
												: "The clock is stopped. Continue to the next play."}
										</p>
										{ownOffense ? (
											<div className="football-coach-clock-actions">
												<button
													type="button"
													className="football-coach-button is-primary"
													disabled={disabled}
													onClick={() => submit({ tempo: "normal" })}
												>
													Huddle
												</button>
												<button
													type="button"
													className="football-coach-button"
													disabled={disabled}
													onClick={() => submit({ tempo: "hurryUp" })}
												>
													No huddle
												</button>
												<button
													type="button"
													className="football-coach-button"
													disabled={disabled}
													onClick={() => submit({ tempo: "chewClock" })}
												>
													Run the clock
												</button>
											</div>
										) : (
											<button
												type="button"
												className="football-coach-button is-primary"
												disabled={disabled}
												onClick={() => submit({})}
											>
												Continue · opponent controls tempo
											</button>
										)}
										<div className="football-coach-clock-actions">
											<button
												type="button"
												className="football-coach-button"
												disabled={
													disabled || !snapshot.canTimeout[controlledTeam]
												}
												onClick={() => submit({ timeout: controlledTeam })}
											>
												{session.teams[controlledTeam].abbrev} timeout ·{" "}
												{snapshot.timeouts[controlledTeam]} left
											</button>
										</div>
									</section>
								) : ownOffense ? (
									<>
										{allowedCalls.length > 0 ? (
											<>
												<div
													className="football-coach-category-tabs"
													aria-label="Play categories"
												>
													{(["run", "pass", "rpo", "trick"] as const).map(
														(value) => (
															<button
																type="button"
																className={`football-coach-category${group === value ? " is-active" : ""}`}
																aria-pressed={group === value}
																disabled={
																	disabled ||
																	!allowedCalls.some(
																		(entry) => entry.group === value,
																	)
																}
																key={value}
																onClick={() => chooseGroup(value)}
															>
																{groupLabels[value]}
															</button>
														),
													)}
												</div>
												<div
													className="football-coach-chip-row mb-3"
													aria-label="Personnel packages"
												>
													<button
														type="button"
														className={`football-coach-chip${personnel === "all" ? " is-active" : ""}`}
														aria-pressed={personnel === "all"}
														disabled={disabled}
														onClick={() => choosePersonnel("all")}
													>
														All personnel
													</button>
													{(
														Object.keys(
															FOOTBALL_COACH_PERSONNEL,
														) as FootballCoachFormation[]
													).map((value) => (
														<button
															type="button"
															key={value}
															className={`football-coach-chip${personnel === value ? " is-active" : ""}`}
															aria-pressed={personnel === value}
															disabled={
																disabled ||
																!allowedCalls.some(
																	(entry) => entry.formation === value,
																)
															}
															title={`${FOOTBALL_COACH_PERSONNEL[value].positions.RB} RB, ${FOOTBALL_COACH_PERSONNEL[value].positions.TE} TE`}
															onClick={() => choosePersonnel(value)}
														>
															{value}
														</button>
													))}
												</div>
												<div className="football-coach-playcards">
													{visibleCalls.map((entry) => (
														<button
															type="button"
															key={entry.id}
															className={`football-coach-playcard${call?.id === entry.id ? " is-selected" : ""}`}
															aria-pressed={call?.id === entry.id}
															disabled={disabled}
															onClick={() => chooseCall(entry.id)}
															title={entry.description}
														>
															<span className="football-coach-playcard-name">
																{entry.name}
															</span>
															<CoachPlayDiagram call={entry} />
															<span className="football-coach-playcard-meta">
																{entry.formation} personnel
															</span>
														</button>
													))}
												</div>
												{call ? (
													<p className="football-coach-play-description">
														{call.description}
													</p>
												) : (
													<p className="football-coach-muted">
														Choose another category or personnel package.
													</p>
												)}
												{call && (target || runner) ? (
													<section className="football-coach-panel football-coach-receiver-detail">
														<h3 className="football-coach-panel-title">
															{call.kind === "option"
																? "Read-option personnel"
																: call.kind === "run"
																	? "Ball carrier"
																	: "Target & route"}
														</h3>
														{target ? (
															<>
																<label
																	className="football-coach-label"
																	htmlFor="football-coach-receiver"
																>
																	Target receiver · tap a receiver on the field
																	to select
																</label>
																<select
																	id="football-coach-receiver"
																	className="football-coach-select"
																	value={target.id}
																	disabled={disabled}
																	onChange={(event) => {
																		const pid = Number(event.target.value);
																		setTargetPid(pid);
																		setInspected({ team: controlledTeam, pid });
																	}}
																>
																	{receivers.map((player) => (
																		<option key={player.id} value={player.id}>
																			{player.pos} {player.name}
																			{!preview.some((p) => p.id === player.id)
																				? " · substitute"
																				: ""}
																		</option>
																	))}
																</select>
																<div className="football-coach-label mt-3">
																	Receiver route
																</div>
																<div className="football-coach-route-grid">
																	{FOOTBALL_COACH_ROUTES.map((entry) => (
																		<button
																			type="button"
																			key={entry.id}
																			className={`football-coach-chip${selectedRoute === entry.id ? " is-active" : ""}`}
																			aria-pressed={selectedRoute === entry.id}
																			disabled={disabled}
																			onClick={() => setRoute(entry.id)}
																		>
																			{entry.name}
																		</button>
																	))}
																</div>
															</>
														) : null}
														{runner ? (
															<div className={target ? "mt-3" : undefined}>
																<label
																	className="football-coach-label"
																	htmlFor="football-coach-runner"
																>
																	Runner
																</label>
																<select
																	id="football-coach-runner"
																	className="football-coach-select"
																	value={runner.id}
																	disabled={disabled}
																	onChange={(event) => {
																		const pid = Number(event.target.value);
																		setRunnerPid(pid);
																		setInspected({ team: controlledTeam, pid });
																	}}
																>
																	{rushers.map((player) => (
																		<option key={player.id} value={player.id}>
																			{player.pos} {player.name}
																			{!preview.some((p) => p.id === player.id)
																				? " · substitute"
																				: ""}
																		</option>
																	))}
																</select>
															</div>
														) : null}
													</section>
												) : null}
											</>
										) : (
											<div className="football-coach-panel">
												<div className="football-coach-eyebrow">
													Special teams
												</div>
												<h3 className="football-coach-panel-title mt-1">
													Choose the next play
												</h3>
												<p className="football-coach-muted mb-0">
													Your kicker, punter, and return units come from this
													league's depth charts.
												</p>
											</div>
										)}
										<div className="football-coach-specials">
											{snapshot.allowedPlays
												.filter(
													(play) =>
														allowedCalls.length === 0 ||
														(play !== "run" && play !== "pass"),
												)
												.map((play) => (
													<button
														type="button"
														key={play}
														className="football-coach-button"
														title={playLabels[play].description}
														disabled={disabled}
														onClick={() => submit({ play })}
													>
														{playLabels[play].label}
														{play === "fieldGoal"
															? ` · ${117 - snapshot.scrimmage} yd`
															: ""}
													</button>
												))}
										</div>
										{allowedCalls.length > 0 ? (
											<div className="football-coach-snapbar">
												<div>
													<strong>{call?.name ?? "Choose a play"}</strong>
													<div className="football-coach-muted">
														{call
															? `${call.formation} personnel${selectedRoute ? ` · ${getFootballCoachRoute(selectedRoute).name}` : ""}`
															: ""}
													</div>
												</div>
												<button
													type="button"
													className="football-coach-snap"
													disabled={disabled || !call}
													onClick={snap}
												>
													{busy ? "Playing…" : "Snap ball"}
												</button>
											</div>
										) : null}
										<button
											type="button"
											className="football-coach-button is-subtle mt-3"
											disabled={disabled}
											onClick={() => submit({ play: "auto" })}
										>
											Let the coach call this play
										</button>
									</>
								) : (
									<section className="football-coach-panel">
										<div className="football-coach-eyebrow">
											{session.teams[controlledTeam].abbrev} defense
										</div>
										<h3 className="football-coach-panel-title mt-1">
											Make the stop
										</h3>
										<p className="football-coach-muted">
											Choose your front and coverage.{" "}
											{session.teams[snapshot.offense].abbrev} calls its own
											offense.
										</p>
										<div className="football-coach-defense-cards">
											{allowedDefenses.map((entry) => (
												<button
													type="button"
													key={entry.id}
													className={`football-coach-defense${defense?.id === entry.id ? " is-selected" : ""}`}
													aria-pressed={defense?.id === entry.id}
													disabled={disabled}
													onClick={() => setDefenseId(entry.id)}
												>
													<strong>{entry.name}</strong>
													<small>
														{entry.rushers} rushers · {entry.coverage}
													</small>
												</button>
											))}
										</div>
										{defense ? (
											<p className="football-coach-play-description">
												{getFootballCoachDefense(defense.id).description}
											</p>
										) : null}
										<div className="football-coach-snapbar">
											<div>
												<strong>
													{defense?.name ?? "Opponent special teams"}
												</strong>
												<div className="football-coach-muted">
													{session.teams[controlledTeam].abbrev} controls the
													defense
												</div>
											</div>
											<button
												type="button"
												className="football-coach-snap"
												disabled={disabled}
												onClick={snap}
											>
												{busy ? "Playing…" : "Ready"}
											</button>
										</div>
										<button
											type="button"
											className="football-coach-button is-subtle mt-3"
											disabled={disabled}
											onClick={() => submit({ play: "auto" })}
										>
											Let the coach set the defense
										</button>
									</section>
								)}
							</>
						)}
					</div>
				</div>
			) : (
				<div className="football-coach-empty" role="status">
					{statusText}
				</div>
			)}
		</div>
	);
};
