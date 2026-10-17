import { MoreLinks } from "../components/MoreLinks.tsx";
import useTitleBar from "../hooks/useTitleBar.tsx";
import type { View } from "../../common/types.ts";
import { toWorker } from "../util/toWorker.ts";
import { useLocal } from "../util/local.ts";
import { DAILY_SCHEDULE } from "../../common/constants.ts";
import { NoGamesMessage } from "./GameLog.tsx";
import allowForceTie from "../../common/allowForceTie.ts";
import { ForceWin } from "../components/ForceWin.tsx";
import { ScoreBox } from "../components/ScoreBox/index.tsx";
import { useEffect, useRef, useState } from "react";
import { helpers } from "../util/helpers.ts";

const DailySchedule = ({
	cid,
	cids,
	completed,
	day,
	days,
	elam,
	elamASG,
	isToday,
	season,
	ties,
	topPlayers,
	upcoming,
}: View<"dailySchedule">) => {
	const [simulationError, setSimulationError] = useState<string>();
	const [startingGame, setStartingGame] = useState(false);
	const [canResumeCoaching, setCanResumeCoaching] = useState(false);
	const startingGameRef = useRef(false);
	const simulateGame = async (gid: number, interactive: boolean) => {
		if (startingGameRef.current) {
			return;
		}
		startingGameRef.current = true;
		setStartingGame(true);
		setSimulationError(undefined);
		try {
			await toWorker(
				"actions",
				interactive ? "interactiveGame" : "simGame",
				gid,
			);
		} catch (error) {
			setSimulationError(
				error instanceof Error ? error.message : "Unable to start the game.",
			);
		} finally {
			startingGameRef.current = false;
			setStartingGame(false);
		}
	};

	useTitleBar({
		title: DAILY_SCHEDULE,
		dropdownView: "daily_schedule",
		dropdownFields: { seasons: season, days: day, cids: cid ?? "all" },
		dropdownCustomOptions: {
			cids,
			days,
		},
	});

	const {
		gameSimInProgress,
		phase,
		season: currentSeason,
		userTid,
		spectator,
	} = useLocal([
		"gameSimInProgress",
		"phase",
		"season",
		"userTid",
		"spectator",
	]);

	useEffect(() => {
		let cancelled = false;
		setCanResumeCoaching(false);
		if (__SPORT === "football" && gameSimInProgress) {
			toWorker("actions", "getFootballCoach", undefined)
				.then((session) => {
					if (!cancelled) {
						setCanResumeCoaching(
							session !== null &&
								session.status !== "complete" &&
								session.status !== "error",
						);
					}
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [gameSimInProgress]);

	let simToDay = null;
	if (upcoming.length > 0 && !isToday) {
		const minGid = Math.min(...upcoming.map((game) => game.gid));
		simToDay = (
			<div className="mb-3">
				<button
					className="btn btn-secondary"
					disabled={gameSimInProgress}
					onClick={() => {
						toWorker("actions", "simToGame", minGid);
					}}
				>
					Sim to day
				</button>
			</div>
		);
	}

	const upcomingAndCompleted = upcoming.length > 0 && completed.length > 0;

	const tradeDeadline =
		upcoming.length === 1 &&
		upcoming[0]!.teams[0].tid === -3 &&
		upcoming[0]!.teams[1].tid === -3;

	let noGamesMessage;
	if (days.length === 0) {
		noGamesMessage = (
			<NoGamesMessage warnAboutDelete={season < currentSeason} />
		);
	}

	return (
		<>
			<MoreLinks type="schedule" page="daily_schedule" />
			{canResumeCoaching ? (
				<div className="alert alert-info">
					Your game is still in progress.{" "}
					<a href={helpers.leagueUrl(["live_game"])}>Resume play calling</a>
				</div>
			) : null}
			{simulationError ? (
				<div className="alert alert-danger" role="alert">
					{simulationError}
				</div>
			) : null}

			{noGamesMessage ? (
				noGamesMessage
			) : (
				<>
					{simToDay}

					{tradeDeadline ? (
						<p>
							Sim one day to move past the trade deadline, and then the next
							day's games will be available here.
						</p>
					) : null}

					{upcoming.length > 0 ? (
						<>
							{upcomingAndCompleted ? <h2>Upcoming Games</h2> : null}
							{__SPORT === "football" && isToday && !tradeDeadline ? (
								<p className="text-body-secondary">
									Sim game lets you coach your selected team on offense and
									defense. Other matchups simulate automatically. Quick sim
									finishes your game automatically.
								</p>
							) : null}
							<div className="d-flex flex-wrap" style={{ gap: "1rem 2rem" }}>
								{upcoming.map((game) => {
									const actions =
										isToday && !tradeDeadline
											? [
													{
														disabled: gameSimInProgress || startingGame,
														highlight:
															game.teams[0].tid === userTid ||
															game.teams[1].tid === userTid,
														text: (
															<>
																Watch
																<br />
																game
															</>
														),
														onClick: () =>
															toWorker("actions", "liveGame", game.gid),
													},
													{
														disabled: gameSimInProgress || startingGame,
														highlight:
															game.teams[0].tid === userTid ||
															game.teams[1].tid === userTid,
														text: (
															<>
																Sim
																<br />
																game
															</>
														),
														onClick: () =>
															simulateGame(
																game.gid,
																__SPORT === "football" &&
																	!spectator &&
																	game.teams.every((team) => team.tid >= 0) &&
																	game.teams.some(
																		(team) => team.tid === userTid,
																	),
															),
													},
												]
											: undefined;

									const allowTie = allowForceTie({
										homeTid: game.teams[0].tid,
										awayTid: game.teams[1].tid,
										elam,
										elamASG,
										phase,
										ties,
									});

									let playersUpcoming: [any, any] | undefined;
									if (topPlayers.type === "byGid") {
										playersUpcoming = topPlayers.playersByGid[game.gid];
									} else {
										const x0 = topPlayers.playersByTid[game.teams[0].tid];
										const x1 = topPlayers.playersByTid[game.teams[1].tid];

										// Undefined for ASG
										if (x0 && x1) {
											playersUpcoming = [x0[0], x1[0]];
										}
									}

									return (
										<div
											className="flex-grow-1"
											key={game.gid}
											style={{ maxWidth: 510 }}
										>
											<ScoreBox
												game={{
													// Leave out forceTie, since ScoreBox wants the value for finished games
													finals: game.finals,
													gid: game.gid,
													season: game.season,
													teams: game.teams,
												}}
												playersUpcoming={playersUpcoming}
												actions={actions}
											/>
											<ForceWin allowTie={allowTie} game={game} />
											{__SPORT === "football" && isToday && !tradeDeadline ? (
												<button
													className="btn btn-link btn-sm p-0 mt-1"
													disabled={gameSimInProgress || startingGame}
													onClick={() => simulateGame(game.gid, false)}
												>
													Quick sim
												</button>
											) : null}
										</div>
									);
								})}
							</div>
						</>
					) : null}

					{completed.length > 0 ? (
						<>
							{upcomingAndCompleted ? (
								<h2 className="mt-3">Completed Games</h2>
							) : null}

							<div className="d-flex flex-wrap" style={{ gap: "1rem 2rem" }}>
								{completed.map((game) => {
									return (
										<div
											className="flex-grow-1"
											key={game.gid}
											style={{ maxWidth: 510 }}
										>
											<ScoreBox game={game} />
										</div>
									);
								})}
							</div>
						</>
					) : null}
				</>
			)}
		</>
	);
};

export default DailySchedule;
