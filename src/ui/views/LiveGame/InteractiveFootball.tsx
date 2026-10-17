import { Fragment, useEffect, useRef, useState } from "react";
import type {
	FootballCoachDecision,
	FootballCoachPlay,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { formatClock } from "../../../common/formatClock.ts";
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

const playLabels: Record<
	FootballCoachPlay,
	{ label: string; description: string }
> = {
	run: { label: "Run", description: "Hand off and attack on the ground" },
	pass: { label: "Pass", description: "Drop back and find a receiver" },
	kneel: { label: "Kneel", description: "Protect possession and take a knee" },
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

const Field = ({
	snapshot,
	teams,
}: {
	snapshot: FootballCoachSnapshot;
	teams: FootballCoachSession["teams"];
}) => {
	const x = (yards: number) =>
		100 + (snapshot.offense === 1 ? yards : 100 - yards) * 10;
	const ballX = x(snapshot.scrimmage);
	const firstDownX = x(Math.min(100, snapshot.scrimmage + snapshot.toGo));
	const possession = teams[snapshot.offense].abbrev;
	const fieldPosition = scrimmageToFieldPos(
		snapshot.scrimmage,
		possession,
		teams[snapshot.defense].abbrev,
	);

	return (
		<svg
			viewBox="0 0 1200 360"
			className="w-100 rounded border"
			role="img"
			aria-label={`${possession} ball at ${fieldPosition}. ${formatDownAndDistance(snapshot.down, snapshot.toGo, snapshot.scrimmage)}.`}
		>
			<rect width="1200" height="360" fill="#195635" />
			<rect width="100" height="360" fill={teams[1].colors[0]} />
			<rect x="1100" width="100" height="360" fill={teams[0].colors[0]} />
			{Array.from({ length: 21 }, (_, i) => i * 5).map((yards) => (
				<Fragment key={yards}>
					<line
						x1={100 + yards * 10}
						x2={100 + yards * 10}
						y1="12"
						y2="348"
						stroke="white"
						strokeOpacity={yards % 10 === 0 ? 0.65 : 0.2}
						strokeWidth={yards % 10 === 0 ? 2 : 1}
					/>
					{yards > 0 && yards < 100 && yards % 10 === 0 ? (
						<>
							<text
								x={100 + yards * 10}
								y="49"
								textAnchor="middle"
								fill="white"
								fontSize="24"
							>
								{Math.min(yards, 100 - yards)}
							</text>
							<text
								x={100 + yards * 10}
								y="328"
								textAnchor="middle"
								fill="white"
								fontSize="24"
							>
								{Math.min(yards, 100 - yards)}
							</text>
						</>
					) : null}
				</Fragment>
			))}
			<text
				transform="translate(61 180) rotate(-90)"
				textAnchor="middle"
				fill="white"
				fontSize="32"
				fontWeight="bold"
			>
				{teams[1].abbrev}
			</text>
			<text
				transform="translate(1139 180) rotate(90)"
				textAnchor="middle"
				fill="white"
				fontSize="32"
				fontWeight="bold"
			>
				{teams[0].abbrev}
			</text>
			{snapshot.awaitingKickoff === undefined &&
			!snapshot.awaitingAfterTouchdown ? (
				<line
					x1={firstDownX}
					x2={firstDownX}
					y1="12"
					y2="348"
					stroke="#ffcd00"
					strokeWidth="5"
				/>
			) : null}
			<line
				x1={ballX}
				x2={ballX}
				y1="12"
				y2="348"
				stroke="#80bdff"
				strokeWidth="5"
			/>
			<ellipse
				cx={ballX}
				cy="180"
				rx="18"
				ry="11"
				fill="#824923"
				stroke="white"
				strokeWidth="2"
			/>
			<path d={`M ${ballX - 7} 180 h 14`} stroke="white" strokeWidth="2" />
			<text
				x="600"
				y="105"
				textAnchor="middle"
				fill="white"
				fontSize="24"
				fontWeight="bold"
			>
				{possession}{" "}
				{snapshot.awaitingKickoff !== undefined ? "kicking" : "possession"}
				{snapshot.offense === 1 ? " →" : " ←"}
			</text>
		</svg>
	);
};

export const InteractiveFootball = () => {
	const [session, setSession] = useState<FootballCoachSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
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
				if (!stopped && mounted.current) {
					setError(
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
				{error ? (
					<p className="text-danger" role="alert">
						{error}
					</p>
				) : null}
				<p>No active game. Open the weekly schedule and choose Sim game.</p>
				<a href={helpers.leagueUrl(["daily_schedule"])}>Weekly schedule</a>
			</>
		);
	}

	const snapshot = session.snapshot;
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
			snapshot?.stage === "clock" ? "Manage the clock" : "Call the next play",
		running: "Simulating…",
		saving: "Saving game results…",
		complete: "Final · Result and statistics saved",
		error: "Game stopped",
	}[session.status];

	return (
		<div style={{ maxWidth: 1400 }}>
			<div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
				<div>
					<h2 className="mb-1">Play calling</h2>
					<div className="text-body-secondary">
						You call plays for both teams. Each result counts in this league.
					</div>
				</div>
				<div className="d-flex flex-wrap gap-2">
					{finished ? (
						<>
							{session.boxScoreUrl ? (
								<a className="btn btn-success" href={session.boxScoreUrl}>
									Box score
								</a>
							) : null}
							<a
								className="btn btn-light-bordered"
								href={helpers.leagueUrl(["daily_schedule"])}
							>
								Weekly schedule
							</a>
						</>
					) : (
						<>
							<button
								className="btn btn-light-bordered"
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
								Jump to final 2:00
							</button>
							<button
								className="btn btn-light-bordered"
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
			{error || session.error ? (
				<div className="alert alert-danger" role="alert">
					{error ?? session.error}
				</div>
			) : null}
			<div className="border rounded p-3 mb-3">
				<div className="row align-items-center g-3">
					{TEAM_NUMS_DISPLAY_ORDER.map((t) => (
						<div className="col-6 col-md-4" key={t}>
							<div className="d-flex align-items-center gap-2">
								<TeamLogoInline
									imgURL={session.teams[t].imgURL}
									imgURLSmall={session.teams[t].imgURLSmall}
									size={44}
								/>
								<div className="flex-grow-1">
									<div className="fw-bold">
										{session.teams[t].region} {session.teams[t].name}
									</div>
									<small className="text-body-secondary">
										{t === 0 ? "Home" : "Away"} · {snapshot?.timeouts[t] ?? 3}{" "}
										timeouts
									</small>
								</div>
								<div className="text-end">
									<strong className="fs-1">
										{snapshot?.teams[t].pts ?? 0}
									</strong>
									{snapshot?.teams[t].sPts !== undefined ? (
										<small className="d-block">
											Shootout: {snapshot.teams[t].sPts}
										</small>
									) : null}
								</div>
							</div>
						</div>
					))}
					<div className="col-12 col-md-4 text-md-end" aria-live="polite">
						<div className="fs-3 fw-bold">
							{session.status === "complete"
								? "FINAL"
								: `${period} · ${snapshot ? formatClock(snapshot.clock) : "—"}`}
						</div>
						<div>{statusText}</div>
					</div>
				</div>
			</div>
			{snapshot ? (
				<div className="row g-3">
					<div className="col-lg-8">
						<div className="d-flex flex-wrap justify-content-between gap-2 mb-2">
							<strong>
								{session.teams[snapshot.offense].abbrev} ·{" "}
								{snapshot.awaitingKickoff !== undefined
									? "Kickoff"
									: snapshot.awaitingAfterTouchdown
										? "After touchdown"
										: formatDownAndDistance(
												snapshot.down,
												snapshot.toGo,
												snapshot.scrimmage,
											)}
							</strong>
							<span>
								{scrimmageToFieldPos(
									snapshot.scrimmage,
									session.teams[snapshot.offense].abbrev,
									session.teams[snapshot.defense].abbrev,
								)}
							</span>
						</div>
						<Field snapshot={snapshot} teams={session.teams} />
						<div className="d-flex gap-3 small text-body-secondary mt-1 mb-3">
							<span>Blue: line of scrimmage</span>
							<span>Yellow: first down</span>
						</div>
						{!finished ? (
							<div className="border rounded p-3 mb-3">
								<h3 className="h5">
									{snapshot.stage === "clock"
										? "Before the next snap"
										: `${session.teams[snapshot.offense].abbrev}: choose a play`}
								</h3>
								{snapshot.stage === "play" ? (
									<div className="row g-2">
										{snapshot.allowedPlays.map((play) => (
											<div className="col-6 col-sm-4" key={play}>
												<button
													className={`btn ${play === "run" || play === "pass" ? "btn-success" : "btn-light-bordered"} text-start w-100 h-100 p-3`}
													disabled={disabled}
													onClick={() => submit({ play })}
												>
													<strong className="d-block">
														{playLabels[play].label}
														{play === "fieldGoal"
															? ` · ${117 - snapshot.scrimmage} yd`
															: ""}
													</strong>
													<small>{playLabels[play].description}</small>
												</button>
											</div>
										))}
									</div>
								) : (
									<>
										<p className="text-body-secondary">
											{snapshot.isClockRunning
												? "The clock is running. Choose your tempo or call a timeout before time runs off."
												: "The clock is stopped. Continue to call the next play."}
										</p>
										<div className="d-flex flex-wrap gap-2">
											<button
												className="btn btn-success"
												disabled={disabled}
												onClick={() => submit({ tempo: "normal" })}
											>
												Normal tempo
											</button>
											<button
												className="btn btn-light-bordered"
												disabled={disabled}
												onClick={() => submit({ tempo: "hurryUp" })}
											>
												Hurry-up
											</button>
											<button
												className="btn btn-light-bordered"
												disabled={disabled}
												onClick={() => submit({ tempo: "chewClock" })}
											>
												Run clock
											</button>
										</div>
										<div className="d-flex flex-wrap gap-2 mt-3">
											{TEAM_NUMS_DISPLAY_ORDER.map((t) => (
												<button
													key={t}
													className="btn btn-light-bordered"
													disabled={disabled || !snapshot.canTimeout[t]}
													onClick={() => submit({ timeout: t })}
												>
													{session.teams[t].abbrev} timeout (
													{snapshot.timeouts[t]})
												</button>
											))}
										</div>
									</>
								)}
								<button
									className="btn btn-link p-0 mt-3"
									disabled={disabled}
									onClick={() =>
										submit(snapshot.stage === "play" ? { play: "auto" } : {})
									}
								>
									{snapshot.stage === "play"
										? "Let the coach call this play"
										: "Continue without a timeout"}
								</button>
							</div>
						) : null}
						<details className="border rounded p-3">
							<summary className="fw-bold">Players from the last snap</summary>
							{snapshot.playersOnField.every(
								(players) => players.length === 0,
							) ? (
								<p className="text-body-secondary mt-3 mb-0">
									Personnel will be available after the opening kickoff.
								</p>
							) : null}
							<div className="row mt-3">
								{TEAM_NUMS_DISPLAY_ORDER.map((t) => (
									<div key={t} className="col-sm-6">
										<h3 className="h6">{session.teams[t].abbrev}</h3>
										<ul className="list-unstyled mb-0">
											{snapshot.playersOnField[t].map((player) => (
												<li key={player.id}>
													<span className="text-body-secondary me-2">
														{player.pos}
													</span>
													{player.name}
												</li>
											))}
										</ul>
									</div>
								))}
							</div>
						</details>
					</div>
					<div className="col-lg-4">
						<h3 className="h5">Recent plays</h3>
						<div
							className="border rounded overflow-auto"
							style={{ maxHeight: 690 }}
						>
							{snapshot.events.length === 0 ? (
								<p className="p-3 mb-0 text-body-secondary">
									The opening kickoff is next.
								</p>
							) : null}
							{snapshot.events
								.map((event, i) => {
									if (event.type === "clock" || event.type === "timeouts") {
										return null;
									}
									return (
										<div className="p-3 border-bottom" key={i}>
											{"clock" in event ? (
												<small className="text-body-secondary d-block">
													{formatClock(event.clock)}
													{"t" in event
														? ` · ${session.teams[event.t].abbrev}`
														: ""}
												</small>
											) : null}
											{event.type === "removeLastScore" ? (
												<span className="text-warning">
													Penalty overturned the score.
												</span>
											) : (
												getText(event, snapshot.numPeriods)
											)}
										</div>
									);
								})
								.reverse()}
						</div>
					</div>
				</div>
			) : (
				<p role="status">{statusText}</p>
			)}
		</div>
	);
};
