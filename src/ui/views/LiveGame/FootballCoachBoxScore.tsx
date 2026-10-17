import { memo } from "react";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import { DEFAULT_TEAM_COLORS } from "../../../common/constants.ts";
import type { TeamNum } from "../../../common/types.ts";
import { FootballBoxScoreStats } from "../../components/BoxScore.football.tsx";
import BoxScoreRow from "../../components/BoxScoreRow.football.tsx";

type BoxScore = Parameters<typeof FootballBoxScoreStats>[0]["boxScore"];

// Adapt detached native totals to the same rows used by ordinary Watch game.
// Never reconstruct statistics from the capped recent-play log.
export const getFootballCoachBoxScore = (
	session: FootballCoachSession,
): BoxScore | undefined => {
	const snapshot = session.snapshot;
	const totals = snapshot?.boxScore;
	if (!snapshot || !totals) {
		return undefined;
	}
	const team = (index: TeamNum): BoxScore["teams"][TeamNum] => {
		const metadata = session.teams[index];
		const roster = new Map(
			session.rosters?.[index].map((player) => [player.pid, player]),
		);
		return {
			...metadata,
			tid: totals.teams[index].id,
			colors: [
				metadata.colors[0] ?? DEFAULT_TEAM_COLORS[0],
				metadata.colors[1] ?? DEFAULT_TEAM_COLORS[1],
				metadata.colors[2] ?? DEFAULT_TEAM_COLORS[2],
			],
			imgURL: metadata.imgURL ?? "",
			imgURLSmall: metadata.imgURLSmall,
			players: totals.teams[index].players.map((player) => ({
				...player.stat,
				pid: player.id,
				name: player.name,
				pos: player.pos,
				jerseyNumber:
					player.jerseyNumber ?? roster.get(player.id)?.jerseyNumber,
				skills: player.skills,
				injury: player.injury,
			})),
		};
	};
	return {
		gid: session.gid,
		season: totals.season,
		numPeriods: snapshot.numPeriods,
		neutralSite: totals.neutralSite,
		scoringSummary: totals.scoringSummary,
		teams: [team(0), team(1)],
	};
};

export const FootballCoachBoxScore = memo(
	({ session }: { session: FootballCoachSession }) => {
		const boxScore = getFootballCoachBoxScore(session);
		if (!boxScore) {
			return null;
		}
		return (
			<section
				className="mt-4"
				style={{ maxWidth: 1500 }}
				aria-label="Game player statistics"
			>
				<p className="text-body-secondary">
					{session.status === "complete"
						? "Final game statistics."
						: "Game statistics update after each play."}
				</p>
				<FootballBoxScoreStats
					key={session.sessionId}
					boxScore={boxScore}
					Row={BoxScoreRow}
				/>
			</section>
		);
	},
);
