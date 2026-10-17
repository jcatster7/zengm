import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { csvParseRows } from "d3-dsv";

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const BY = "https://creativecommons.org/licenses/by/4.0/";
const BY_SA = "https://creativecommons.org/licenses/by-sa/4.0/";
const LABELS = {
	runInside: "Inside runs (middle or guard)",
	runOutside: "Outside runs (tackle or end)",
	runDraw: "Draw runs explicitly named in play descriptions",
	passShort: "Passes under 10 air yards",
	passMedium: "Passes 10–19 air yards",
	passDeep: "Passes 20+ air yards",
	passScreen: "FTN-charted screen passes",
	rpo: "FTN-charted run-pass options",
	trick: "FTN-charted trick plays",
};
type ProfileId = keyof typeof LABELS;
type Row = Record<string, string>;
type Charting = { screen: boolean; rpo: boolean; trick: boolean };

const number = (value: string | undefined) => {
	if (value === undefined || value.trim() === "" || value === "NA") {
		return undefined;
	}
	const result = Number(value);
	return Number.isFinite(result) ? result : undefined;
};
const flag = (value: string | undefined) => value === "1" || value === "TRUE";

/** Parse one row at a time; don't retain the 372-column, ~100MB source table. */
const eachCsv = (
	text: string,
	columns: readonly string[],
	visit: (row: Row) => void,
) => {
	let indexes: number[] = [];
	csvParseRows(text, (cells, index) => {
		if (index === 0) {
			indexes = columns.map((column) => {
				const found = cells.indexOf(column);
				if (found < 0) {
					throw new Error(`Source CSV is missing required column ${column}`);
				}
				return found;
			});
		} else if (cells.length > 1) {
			const row: Row = {};
			for (const [i, column] of columns.entries()) {
				row[column] = cells[indexes[i]!] ?? "";
			}
			visit(row);
		}
		return null;
	});
	if (indexes.length === 0) {
		throw new Error("Source CSV is empty");
	}
};

const key = (season: number, game: string, play: string) => {
	const id = number(play);
	if (!game || !Number.isInteger(id)) {
		throw new Error(`Invalid play identity in season ${season}`);
	}
	return `${season}:${game}:${id}`;
};

export const parseCharting = (text: string, season: number) => {
	const charting = new Map<string, Charting>();
	eachCsv(
		text,
		[
			"season",
			"nflverse_game_id",
			"nflverse_play_id",
			"is_screen_pass",
			"is_rpo",
			"is_trick_play",
		],
		(row) => {
			if (number(row.season) !== season) {
				throw new Error(`FTN row has unexpected season ${row.season}`);
			}
			const id = key(season, row.nflverse_game_id!, row.nflverse_play_id!);
			if (charting.has(id)) {
				throw new Error(`Duplicate FTN play ${id}`);
			}
			charting.set(id, {
				screen: flag(row.is_screen_pass),
				rpo: flag(row.is_rpo),
				trick: flag(row.is_trick_play),
			});
		},
	);
	return charting;
};

export const classifyPlay = (row: Row, chart?: Charting): ProfileId[] => {
	const ids: ProfileId[] = [];
	if (row.play_type === "run" && !flag(row.qb_scramble)) {
		if (row.run_location === "middle" || row.run_gap === "guard") {
			ids.push("runInside");
		} else if (row.run_gap === "tackle" || row.run_gap === "end") {
			ids.push("runOutside");
		}
		// No structured draw field exists. A shotgun run is not evidence of a draw.
		if (/\bdraw\b/i.test(row.desc ?? "")) {
			ids.push("runDraw");
		}
	}
	const air = number(row.air_yards);
	if (row.play_type === "pass" && !flag(row.sack) && air !== undefined) {
		ids.push(air < 10 ? "passShort" : air < 20 ? "passMedium" : "passDeep");
	}
	if (chart?.screen && row.play_type === "pass") {
		ids.push("passScreen");
	}
	if (chart?.rpo) {
		ids.push("rpo");
	}
	if (chart?.trick) {
		ids.push("trick");
	}
	return ids;
};

type Accumulator = {
	n: number;
	yards: number;
	turnovers: number;
	dropbacks: number;
	attempts: number;
	completions: number;
	air: Map<number, number>;
	rush: Map<number, number>;
};
export const createAccumulators = () =>
	new Map<ProfileId, Accumulator>(
		(Object.keys(LABELS) as ProfileId[]).map((id) => [
			id,
			{
				n: 0,
				yards: 0,
				turnovers: 0,
				dropbacks: 0,
				attempts: 0,
				completions: 0,
				air: new Map(),
				rush: new Map(),
			},
		]),
	);
const countValue = (map: Map<number, number>, value: number) => {
	if (!Number.isInteger(value)) {
		throw new Error(
			`Expected whole-yard source measurement, received ${value}`,
		);
	}
	map.set(value, (map.get(value) ?? 0) + 1);
};

export const aggregateSeason = (
	text: string,
	season: number,
	charting: Map<string, Charting>,
	profiles: ReturnType<typeof createAccumulators>,
) => {
	const seen = new Set<string>();
	let eligible = 0;
	let matchedCharting = 0;
	eachCsv(
		text,
		[
			"season",
			"game_id",
			"play_id",
			"play_type",
			"play_deleted",
			"qb_kneel",
			"qb_spike",
			"qb_scramble",
			"qb_dropback",
			"penalty",
			"two_point_attempt",
			"sack",
			"pass_attempt",
			"complete_pass",
			"rush_attempt",
			"air_yards",
			"run_location",
			"run_gap",
			"desc",
			"yards_gained",
			"interception",
			"fumble_lost",
		],
		(row) => {
			if (number(row.season) !== season) {
				throw new Error(`PBP row has unexpected season ${row.season}`);
			}
			if (
				(row.play_type !== "run" && row.play_type !== "pass") ||
				flag(row.play_deleted) ||
				flag(row.penalty) ||
				flag(row.qb_kneel) ||
				flag(row.qb_spike) ||
				flag(row.two_point_attempt)
			) {
				return;
			}
			const yards = number(row.yards_gained);
			if (yards === undefined) {
				return;
			}
			const id = key(season, row.game_id!, row.play_id!);
			if (seen.has(id)) {
				throw new Error(`Duplicate eligible PBP play ${id}`);
			}
			seen.add(id);
			eligible += 1;
			const chart = charting.get(id);
			if (chart) {
				matchedCharting += 1;
			}
			for (const profileId of classifyPlay(row, chart)) {
				const acc = profiles.get(profileId)!;
				acc.n += 1;
				acc.yards += yards;
				acc.turnovers += Number(
					flag(row.interception) || flag(row.fumble_lost),
				);
				acc.dropbacks += Number(flag(row.qb_dropback));
				const attempt = flag(row.pass_attempt) && !flag(row.sack);
				if (attempt) {
					acc.attempts += 1;
					acc.completions += Number(flag(row.complete_pass));
					const air = number(row.air_yards);
					if (air !== undefined) {
						countValue(acc.air, air);
					}
				}
				if (flag(row.rush_attempt)) {
					countValue(acc.rush, yards);
				}
			}
		},
	);
	if (eligible === 0 || matchedCharting === 0) {
		throw new Error(
			`No eligible PBP/FTN join for ${season}; refusing empty reference`,
		);
	}
	return { eligible, matchedCharting };
};

const histogram = (map: Map<number, number>) =>
	Array.from(map, ([yards, count]) => ({ yards, count })).sort(
		(a, b) => a.yards - b.yards,
	);
const total = (map: Map<number, number>) =>
	Array.from(map.values()).reduce((sum, value) => sum + value, 0);
const round = (value: number) => Number(value.toFixed(8));

export const finishProfiles = (
	accumulators: ReturnType<typeof createAccumulators>,
) =>
	Array.from(accumulators).flatMap(([id, acc]) => {
		if (acc.n === 0) {
			return []; // No fabricated estimates for unobserved classifications.
		}
		const airCount = total(acc.air);
		const rushCount = total(acc.rush);
		return [
			{
				id,
				label: LABELS[id],
				sampleSize: acc.n,
				completionRate: acc.attempts
					? round(acc.completions / acc.attempts)
					: null,
				turnoverRate: round(acc.turnovers / acc.n),
				meanYards: round(acc.yards / acc.n),
				meanAirYards: airCount
					? round(
							Array.from(acc.air, ([yards, count]) => yards * count).reduce(
								(sum, value) => sum + value,
								0,
							) / airCount,
						)
					: null,
				passRate: round(acc.dropbacks / acc.n),
				passAttempts: acc.attempts,
				airYardsSampleSize: airCount,
				rushSampleSize: rushCount,
				...(airCount > 0 ? { airYardsDistribution: histogram(acc.air) } : {}),
				...(rushCount > 0
					? { rushYardsDistribution: histogram(acc.rush) }
					: {}),
			},
		];
	});

const playerFromRow = (row: Row) => {
	const birthYear = /^\d{4}-\d{2}-\d{2}$/.test(row.birth_date ?? "")
		? Number(row.birth_date!.slice(0, 4))
		: undefined;
	return {
		gsisId: row.gsis_id!,
		name: row.display_name!,
		...(row.pfr_id ? { pfrId: row.pfr_id } : {}),
		...(row.position ? { position: row.position } : {}),
		...(row.latest_team ? { team: row.latest_team } : {}),
		...(birthYear ? { birthYear } : {}),
	};
};

const loadPlayers = (text: string, earliestSeason: number) => {
	const players: ReturnType<typeof playerFromRow>[] = [];
	const seen = new Set<string>();
	// Public identity boundary: retain NFL IDs/names for local linking only; never read or upload league/spreadsheet data.
	eachCsv(
		text,
		[
			"gsis_id",
			"pfr_id",
			"display_name",
			"position",
			"latest_team",
			"birth_date",
			"rookie_season",
			"last_season",
		],
		(row) => {
			if (
				(number(row.last_season) ?? 0) < earliestSeason &&
				(number(row.rookie_season) ?? 0) < earliestSeason
			) {
				return;
			}
			if (!row.gsis_id || !row.display_name || seen.has(row.gsis_id)) {
				throw new Error("Missing or duplicate public player identity");
			}
			seen.add(row.gsis_id);
			players.push(playerFromRow(row));
		},
	);
	return players.sort((a, b) => a.gsisId.localeCompare(b.gsisId));
};

const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const atomicWrite = async (filename: string, content: string | Uint8Array) => {
	await mkdir(path.dirname(filename), { recursive: true });
	const temporary = `${filename}.${process.pid}.tmp`;
	await writeFile(temporary, content);
	await rename(temporary, filename);
};
const download = async (url: string, cache: string) => {
	const filename = path.join(cache, new URL(url).pathname.split("/").at(-1)!);
	let bytes: Buffer | undefined;
	try {
		const metadata = JSON.parse(await readFile(`${filename}.json`, "utf8"));
		const cached = await readFile(filename);
		if (metadata.url !== url || metadata.sha256 !== digest(cached)) {
			throw new Error(
				`Cache integrity check failed for ${filename}; remove this cache entry and retry`,
			);
		}
		bytes = cached;
	} catch (error) {
		if (error.code !== "ENOENT") {
			throw error;
		}
	}
	if (!bytes) {
		console.log(`Downloading ${url}`);
		const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
		if (!response.ok) {
			throw new Error(`Download failed: HTTP ${response.status} ${url}`);
		}
		bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > 50000000) {
			throw new Error(`Unexpected source size ${bytes.length} for ${url}`);
		}
		await atomicWrite(filename, bytes);
		await atomicWrite(
			`${filename}.json`,
			JSON.stringify({ url, sha256: digest(bytes) }),
		);
	}
	return { bytes, sha256: digest(bytes) };
};

const main = async () => {
	const { values } = parseArgs({
		options: {
			seasons: { type: "string", default: "2023,2024,2025" },
			cache: {
				type: "string",
				default: path.join(tmpdir(), "football-coach-nflverse"),
			},
			out: {
				type: "string",
				default: "public/files/football-coach-reference.json",
			},
		},
	});
	const seasons = [...new Set(values.seasons!.split(",").map(Number))].sort(
		(a, b) => a - b,
	);
	if (
		!seasons.length ||
		seasons.some(
			(season) =>
				!Number.isInteger(season) ||
				season < 2022 ||
				season >= new Date().getUTCFullYear(),
		)
	) {
		throw new Error(
			"--seasons must be comma-separated completed NFL seasons from 2022 onward",
		);
	}
	const sources: {
		name: string;
		url: string;
		license: string;
		sha256: string;
	}[] = [];
	const profiles = createAccumulators();
	for (const season of seasons) {
		const ftnUrl = `${RELEASE}/ftn_charting/ftn_charting_${season}.csv`;
		const pbpUrl = `${RELEASE}/pbp/play_by_play_${season}.csv.gz`;
		const [ftn, pbp] = await Promise.all([
			download(ftnUrl, values.cache!),
			download(pbpUrl, values.cache!),
		]);
		const charting = parseCharting(ftn.bytes.toString("utf8"), season);
		const counts = aggregateSeason(
			gunzipSync(pbp.bytes).toString("utf8"),
			season,
			charting,
			profiles,
		);
		console.log(
			`${season}: ${counts.eligible} eligible plays; ${counts.matchedCharting} matched to FTN`,
		);
		sources.push(
			{
				name: `nflverse play-by-play ${season}`,
				url: pbpUrl,
				license: BY,
				sha256: pbp.sha256,
			},
			{
				name: `FTN Data via nflverse ${season}`,
				url: ftnUrl,
				license: BY_SA,
				sha256: ftn.sha256,
			},
		);
	}
	const playersUrl = `${RELEASE}/players/players.csv`;
	const playersSource = await download(playersUrl, values.cache!);
	sources.push({
		name: "nflverse players V2",
		url: playersUrl,
		license: BY,
		sha256: playersSource.sha256,
	});
	const output = {
		schemaVersion: 1 as const,
		generatedAt: new Date().toISOString(),
		seasons,
		sources,
		players: loadPlayers(playersSource.bytes.toString("utf8"), seasons[0]!),
		profiles: finishProfiles(profiles),
	};
	await atomicWrite(values.out!, `${JSON.stringify(output)}\n`);
	console.log(
		`Wrote ${output.players.length} public identities and ${output.profiles.length} measured profiles to ${values.out}`,
	);
};

if (import.meta.main) {
	await main();
}
