import { Fragment, useId } from "react";
import type {
	FootballCoachLineupPlayer,
	FootballCoachSnapshot,
} from "../../../common/footballCoach.ts";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import {
	getFootballCoachRoute,
	type FootballCoachCallDefinition,
	type FootballCoachRoute,
} from "../../../common/footballCoachPlaybook.ts";
import type { TeamNum } from "../../../common/types.ts";

type Marker = FootballCoachLineupPlayer & { x: number; y: number };

const roleOf = (player: FootballCoachLineupPlayer) =>
	player.slot.replace(/\d+$/, "");

export const matchesCoachRole = (
	player: { id: number; pos: string },
	roles: readonly string[],
	lineup: FootballCoachLineupPlayer[],
) =>
	roles.includes(player.pos) ||
	lineup.some((p) => p.id === player.id && roles.includes(roleOf(p)));

// A custom depth chart can put a player in a different role from his natural
// position. Keep that role when eligible, and keep every player ID unique when
// moving a natural receiver out of another position in a sparse roster.
export const pinCoachPlayer = (
	lineup: FootballCoachLineupPlayer[],
	player: { id: number; name: string; pos: string } | undefined,
	roles: readonly string[],
) => {
	if (!player) {
		return lineup;
	}
	const currentIndex = lineup.findIndex((p) => p.id === player.id);
	const current = lineup[currentIndex];
	if (current && roles.includes(roleOf(current))) {
		return lineup;
	}
	if (!roles.includes(player.pos)) {
		return lineup;
	}
	const destination = lineup.findIndex((p) => roleOf(p) === player.pos);
	const displaced = lineup[destination];
	if (!displaced) {
		return lineup;
	}
	return lineup.map((p, index) =>
		index === destination
			? { ...player, slot: p.slot }
			: index === currentIndex
				? { ...displaced, slot: p.slot }
				: p,
	);
};

const positionPlayers = (
	players: FootballCoachLineupPlayer[],
	defense: boolean,
): Marker[] => {
	const counts = new Map<string, number>();
	return players.map((player) => {
		const role = roleOf(player);
		const index = counts.get(role) ?? 0;
		counts.set(role, index + 1);
		const total = players.filter((p) => roleOf(p) === role).length;
		const centered = (spacing: number) =>
			280 + (index - (total - 1) / 2) * spacing;
		let x = centered(35);
		let y = defense ? -28 : 0;
		if (role === "QB") {
			x = 280;
			y = 42;
		} else if (role === "RB") {
			x = total > 1 ? 245 + index * 70 : 315;
			y = 88;
		} else if (role === "WR") {
			x = [86, 474, 150, 410][index] ?? centered(90);
			y = index < 2 ? -3 : 20;
		} else if (role === "TE") {
			x = [385, 175, 430][index] ?? centered(55);
			y = 0;
		} else if (role === "OL") {
			x = centered(33);
			y = 0;
		} else if (role === "DL") {
			x = centered(42);
			y = -32;
		} else if (role === "LB") {
			x = centered(72);
			y = -93;
		} else if (role === "CB") {
			x = [88, 472, 155, 405][index] ?? centered(70);
			y = -46;
		} else if (role === "S") {
			x = centered(125);
			y = -162;
		} else if (role === "K" || role === "P") {
			x = 280;
			y = 85;
		} else if (role === "KR" || role === "PR") {
			x = centered(100);
			y = -220;
		}
		return { ...player, x, y: 550 + y };
	});
};

const routePoints = (
	route: FootballCoachRoute,
	x: number,
	y: number,
	minY = 55,
) => {
	const direction = x >= 280 ? 1 : -1;
	return getFootballCoachRoute(route).shape.map(([dx, dy]) => [
		Math.max(58, Math.min(502, x + dx * 8 * direction)),
		Math.max(minY, Math.min(720, y - dy * 11)),
	]);
};

const pointsToPath = (points: number[][]) =>
	points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");

const runPoints = (call: FootballCoachCallDefinition, x: number, y: number) => {
	const style = call.runStyle;
	const outside =
		style === "outside" || style === "toss" || style === "reverse";
	const offset = outside
		? 165
		: style === "counter"
			? -95
			: style === "power" || style === "qbPower"
				? 55
				: 0;
	return [
		[x, y],
		[280 + offset * 0.4, 565],
		[280 + offset, style === "sneak" ? 525 : 450],
	];
};

export const CoachPlayDiagram = ({
	call,
}: {
	call: FootballCoachCallDefinition;
}) => {
	const points =
		call.kind === "run"
			? runPoints(
					call,
					call.runnerPosition === "QB" ? 280 : 315,
					call.runnerPosition === "QB" ? 592 : 638,
				)
			: routePoints(call.route ?? "slant", 474, 547);
	const miniPoints = points.map(([x, y]) => [
		x!,
		y! < 550 ? 550 - (550 - y!) * 0.4 : y!,
	]);
	return (
		<svg viewBox="0 0 560 285" aria-hidden="true">
			<g transform="translate(0 -380)">
				<path
					d="M40 550H520"
					stroke="#4c6d67"
					strokeWidth="3"
					strokeDasharray="8 7"
				/>
				{[214, 247, 280, 313, 346].map((x) => (
					<circle key={x} cx={x} cy="550" r="9" fill="#9fb6bd" />
				))}
				<circle cx="280" cy="592" r="10" fill="#dde9e9" />
				<circle
					cx="315"
					cy="638"
					r="10"
					fill={call.kind === "run" ? "#f3ba4b" : "#a5bac5"}
				/>
				<circle cx="86" cy="547" r="10" fill="#a5bac5" />
				<circle
					cx="474"
					cy="547"
					r="10"
					fill={call.kind !== "run" ? "#81d4eb" : "#a5bac5"}
				/>
				<path
					d={pointsToPath(miniPoints)}
					stroke={call.kind === "run" ? "#f3ba4b" : "#81d4eb"}
					strokeWidth="6"
					fill="none"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				{call.kind === "option" ? (
					<path
						d={pointsToPath(runPoints(call, 315, 638))}
						stroke="#f3ba4b"
						strokeWidth="5"
						strokeDasharray="9 6"
						fill="none"
					/>
				) : null}
			</g>
		</svg>
	);
};

export const CoachField = ({
	snapshot,
	session,
	call,
	route,
	offense,
	defense,
	preview,
	targetPid,
	runnerPid,
	inspected,
	onSelect,
}: {
	snapshot: FootballCoachSnapshot;
	session: FootballCoachSession;
	call?: FootballCoachCallDefinition;
	route?: FootballCoachRoute;
	offense: FootballCoachLineupPlayer[];
	defense: FootballCoachLineupPlayer[];
	preview: boolean;
	targetPid?: number;
	runnerPid?: number;
	inspected?: { team: TeamNum; pid: number };
	onSelect: (team: TeamNum, pid: number) => void;
}) => {
	const markerId = useId().replaceAll(":", "");
	const offMarkers = positionPlayers(offense, false);
	const defMarkers = positionPlayers(defense, true);
	const yForYard = (yard: number) => 550 - (yard - snapshot.scrimmage) * 11;
	const goalY = yForYard(100);
	const ownGoalY = yForYard(0);
	const passTarget = offMarkers.find((player) => player.id === targetPid);
	const runner = offMarkers.find((player) => player.id === runnerPid);
	const planned = preview;
	const drawPlayer = (player: Marker, team: TeamNum, defensive: boolean) => {
		const roster = session.rosters?.[team]?.find((p) => p.pid === player.id);
		const selected = inspected?.team === team && inspected.pid === player.id;
		const target =
			!defensive && (player.id === targetPid || player.id === runnerPid);
		const label = roster?.jerseyNumber ?? player.slot;
		const surname = player.name.trim().split(" ").at(-1) ?? player.name;
		return (
			<g
				key={`${team}-${player.slot}-${player.id}`}
				className="football-coach-player"
				role="button"
				tabIndex={0}
				aria-label={`${player.slot}, ${player.name}${target ? ", selected target" : ""}`}
				aria-pressed={selected}
				onClick={() => onSelect(team, player.id)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onSelect(team, player.id);
					}
				}}
			>
				<title>
					{player.name} · {player.slot}
					{roster?.ovr !== undefined ? ` · ${roster.ovr} OVR` : ""}
				</title>
				{target ? (
					<circle
						cx={player.x}
						cy={player.y}
						r="22"
						fill="none"
						stroke="#f3ba4b"
						strokeWidth="2"
						strokeDasharray="3 3"
					/>
				) : null}
				<circle
					className="football-coach-player-ring"
					cx={player.x}
					cy={player.y}
					r="16"
					fill={selected ? "#f3ba4b" : defensive ? "#823e3c" : "#e9f0ed"}
					stroke={selected ? "#fff" : defensive ? "#e8aaa0" : "#305b4b"}
					strokeWidth={selected ? 3 : 2}
				/>
				<text
					x={player.x}
					y={player.y + 4}
					fill={selected || !defensive ? "#152b24" : "#fff"}
					fontSize={String(label).length > 2 ? 8 : 11}
					fontWeight="800"
					textAnchor="middle"
					pointerEvents="none"
				>
					{label}
				</text>
				<text
					x={player.x}
					y={player.y + 31}
					fill={selected ? "#ffe8a7" : "#e0eee5"}
					stroke="#173b2b"
					strokeWidth="3"
					paintOrder="stroke"
					fontSize="10"
					fontWeight={selected ? 800 : 600}
					textAnchor="middle"
					pointerEvents="none"
				>
					{surname.slice(0, 15)}
				</text>
			</g>
		);
	};
	return (
		<div className="football-coach-field-panel">
			<svg
				viewBox="0 0 560 780"
				className="football-coach-field"
				role="group"
				aria-label="Interactive pre-snap formation. Select a player to inspect ratings or edit a receiving route."
			>
				<defs>
					<pattern
						id={`${markerId}turf`}
						width="40"
						height="110"
						patternUnits="userSpaceOnUse"
					>
						<rect width="40" height="110" fill="#24523d" />
						<rect width="40" height="55" fill="#214b38" />
					</pattern>
					<marker
						id={`${markerId}arrow`}
						viewBox="0 0 10 10"
						refX="8"
						refY="5"
						markerWidth="5"
						markerHeight="5"
						orient="auto-start-reverse"
					>
						<path d="M0 0L10 5L0 10Z" fill="#81d4eb" />
					</marker>
					<marker
						id={`${markerId}run`}
						viewBox="0 0 10 10"
						refX="8"
						refY="5"
						markerWidth="5"
						markerHeight="5"
						orient="auto-start-reverse"
					>
						<path d="M0 0L10 5L0 10Z" fill="#f3ba4b" />
					</marker>
					<clipPath id={`${markerId}clip`}>
						<rect x="39" y="40" width="482" height="700" />
					</clipPath>
				</defs>
				<rect width="560" height="780" fill="#122e23" />
				<rect
					x="40"
					y="40"
					width="480"
					height="700"
					fill={`url(#${markerId}turf)`}
				/>
				<g clipPath={`url(#${markerId}clip)`}>
					{goalY >= 40 && goalY <= 850 ? (
						<>
							<rect
								x="40"
								y={goalY - 110}
								width="480"
								height="110"
								fill={session.teams[snapshot.defense].colors[0] ?? "#233a4f"}
							/>
							<text
								x="280"
								y={goalY - 43}
								textAnchor="middle"
								fill="#fff"
								opacity=".8"
								fontSize="29"
								fontWeight="800"
								letterSpacing="5"
							>
								{session.teams[snapshot.defense].abbrev}
							</text>
						</>
					) : null}
					{ownGoalY >= -70 && ownGoalY <= 740 ? (
						<rect
							x="40"
							y={ownGoalY}
							width="480"
							height="110"
							fill={session.teams[snapshot.offense].colors[0] ?? "#233a4f"}
						/>
					) : null}
					{Array.from({ length: 21 }, (_, i) => i * 5).map((yard) => (
						<Fragment key={yard}>
							<line
								x1="40"
								x2="520"
								y1={yForYard(yard)}
								y2={yForYard(yard)}
								stroke="#e1ede2"
								strokeWidth={yard % 10 === 0 ? 2 : 1}
								opacity={yard % 10 === 0 ? 0.5 : 0.25}
							/>
							{yard > 0 && yard < 100 && yard % 10 === 0 ? (
								<>
									<text
										x="65"
										y={yForYard(yard) - 8}
										fill="#d3e3d7"
										opacity=".6"
										fontSize="20"
										fontWeight="750"
									>
										{Math.min(yard, 100 - yard)}
									</text>
									<text
										x="495"
										y={yForYard(yard) - 8}
										textAnchor="end"
										fill="#d3e3d7"
										opacity=".6"
										fontSize="20"
										fontWeight="750"
									>
										{Math.min(yard, 100 - yard)}
									</text>
								</>
							) : null}
						</Fragment>
					))}
					{Array.from({ length: 101 }, (_, i) => i).map((yard) => (
						<path
							key={yard}
							d={`M218 ${yForYard(yard)}h9M333 ${yForYard(yard)}h9`}
							stroke="#d5e6d8"
							opacity=".45"
						/>
					))}
					{snapshot.awaitingKickoff === undefined &&
					!snapshot.awaitingAfterTouchdown ? (
						<line
							x1="40"
							x2="520"
							y1={yForYard(Math.min(100, snapshot.scrimmage + snapshot.toGo))}
							y2={yForYard(Math.min(100, snapshot.scrimmage + snapshot.toGo))}
							stroke="#f0c952"
							strokeWidth="3"
						/>
					) : null}
					<line
						x1="40"
						x2="520"
						y1="550"
						y2="550"
						stroke="#78b8e3"
						strokeWidth="3"
					/>
					{planned && call && passTarget && call.kind !== "run" ? (
						<path
							d={pointsToPath(
								routePoints(
									route ?? call.route ?? "slant",
									passTarget.x,
									passTarget.y,
									Math.max(55, goalY - 95),
								),
							)}
							fill="none"
							stroke="#81d4eb"
							strokeWidth="5"
							strokeLinecap="round"
							strokeLinejoin="round"
							markerEnd={`url(#${markerId}arrow)`}
						/>
					) : null}
					{planned && call && runner && call.kind !== "pass" ? (
						<path
							d={pointsToPath(runPoints(call, runner.x, runner.y))}
							fill="none"
							stroke="#f3ba4b"
							strokeWidth="5"
							strokeDasharray={call.kind === "option" ? "9 6" : undefined}
							strokeLinecap="round"
							strokeLinejoin="round"
							markerEnd={`url(#${markerId}run)`}
						/>
					) : null}
					{defMarkers.map((player) =>
						drawPlayer(player, snapshot.defense, true),
					)}
					{offMarkers.map((player) =>
						drawPlayer(player, snapshot.offense, false),
					)}
				</g>
				<rect
					x="40"
					y="40"
					width="480"
					height="700"
					fill="none"
					stroke="#bed3c4"
					strokeWidth="2"
					opacity=".6"
				/>
				<text
					x="280"
					y="25"
					fill="#c2d8ca"
					fontSize="11"
					textAnchor="middle"
					fontWeight="700"
					letterSpacing="2"
				>
					{session.teams[snapshot.offense].abbrev} ATTACKING ↑
				</text>
				<text x="280" y="765" fill="#b3cbbb" fontSize="10" textAnchor="middle">
					{planned
						? "PRE-SNAP DIAGRAM · TAP A PLAYER"
						: "PERSONNEL FROM THE LAST SNAP"}
				</text>
			</svg>
			<div className="football-coach-field-caption">
				<span>Blue · scrimmage</span>
				<span>Gold · first down</span>
				<span>Cyan · target route</span>
			</div>
		</div>
	);
};
