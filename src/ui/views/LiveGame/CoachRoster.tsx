import { useState } from "react";
import type {
	FootballCoachRosterPlayer,
	FootballCoachSession,
} from "../../../common/footballCoachSession.ts";
import posRatings from "../../../common/posRatings.football.ts";
import type { TeamNum } from "../../../common/types.ts";

const ratingNames: Record<string, string> = {
	hgt: "Height",
	stre: "Strength",
	spd: "Speed",
	endu: "Endurance",
	thv: "Vision",
	thp: "Throw power",
	tha: "Throw accuracy",
	bsc: "Ball security",
	elu: "Elusiveness",
	rtr: "Route running",
	hnd: "Hands",
	rbk: "Run blocking",
	pbk: "Pass blocking",
	pcv: "Coverage",
	tck: "Tackling",
	prs: "Pass rush",
	rns: "Run stopping",
	kpw: "Kick power",
	kac: "Kick accuracy",
	ppw: "Punt power",
	pac: "Punt accuracy",
};

export const CoachPlayerDetails = ({
	player,
	energy,
}: {
	player: FootballCoachRosterPlayer;
	energy?: number;
}) => {
	const keys = ["spd", "stre", "endu", ...posRatings(player.pos)];
	return (
		<>
			<div className="football-coach-receiver">
				<div className="football-coach-player-number">
					{player.jerseyNumber ?? player.pos}
				</div>
				<div className="flex-grow-1">
					<div className="football-coach-player-name">{player.name}</div>
					<div className="football-coach-muted">
						{player.pos}
						{player.ovr !== undefined ? ` · ${player.ovr} OVR` : ""}
						{energy !== undefined
							? ` · ${Math.round(energy * 100)}% energy`
							: ""}
					</div>
				</div>
			</div>
			{player.injury ? (
				<p className="football-coach-muted mb-0">{player.injury}</p>
			) : null}
			{player.ratings ? (
				<div className="football-coach-ratings">
					{keys.map((key) =>
						player.ratings?.[key] !== undefined ? (
							<div key={key}>
								<div className="football-coach-rating-label">
									<span>{ratingNames[key] ?? key}</span>
									<strong>{player.ratings[key]}</strong>
								</div>
								<div className="football-coach-rating-track">
									<span
										style={{
											width: `${Math.max(0, Math.min(100, player.ratings[key]))}%`,
										}}
									/>
								</div>
							</div>
						) : null,
					)}
				</div>
			) : (
				<div className="football-coach-muted">
					Ratings are hidden in this league.
				</div>
			)}
		</>
	);
};

export const CoachRoster = ({
	session,
	inspected,
	onSelect,
}: {
	session: FootballCoachSession;
	inspected?: { team: TeamNum; pid: number };
	onSelect: (team: TeamNum, pid: number) => void;
}) => {
	const [team, setTeam] = useState<TeamNum>(session.controlledTeam ?? 0);
	const players = session.rosters?.[team] ?? [];
	const selected =
		inspected?.team === team
			? players.find((player) => player.pid === inspected.pid)
			: undefined;
	return (
		<>
			<div className="football-coach-chip-row mb-3">
				{([0, 1] as const).map((t) => (
					<button
						type="button"
						key={t}
						className={`football-coach-chip${team === t ? " is-active" : ""}`}
						aria-pressed={team === t}
						onClick={() => setTeam(t)}
					>
						{session.teams[t].abbrev}
					</button>
				))}
			</div>
			{selected ? (
				<div className="football-coach-panel mb-3">
					<CoachPlayerDetails player={selected} />
				</div>
			) : null}
			<div className="football-coach-roster-list">
				{players.length === 0 ? (
					<p className="football-coach-muted">
						Roster details are unavailable for this session.
					</p>
				) : (
					players.map((player) => (
						<button
							type="button"
							className={`football-coach-roster-player${selected?.pid === player.pid ? " is-selected" : ""}`}
							aria-pressed={selected?.pid === player.pid}
							key={player.pid}
							onClick={() => onSelect(team, player.pid)}
						>
							<span className="football-coach-muted">
								{player.jerseyNumber ?? "—"}
							</span>
							<span>{player.pos}</span>
							<span>
								{player.name}
								{player.injury ? (
									<small className="d-block football-coach-muted">
										{player.injury}
									</small>
								) : null}
							</span>
							<strong className="text-end">{player.ovr ?? "—"}</strong>
						</button>
					))
				)}
			</div>
		</>
	);
};
