import { csvParseRows, tsvParseRows } from "d3-dsv";
import type { FootballCoachReferencePlayer } from "./footballCoachReference.ts";
import type { FootballCoachRosterPlayer } from "./footballCoachSession.ts";

export type FootballCoachPlayerLink = {
	pid: number;
	gsisId: string;
	name: string;
	birthYear?: number;
};

export type FootballCoachLinkFile = {
	version: 1;
	filename: string;
	updatedAt: string;
	links: FootballCoachPlayerLink[];
};

export type FootballCoachCsvRow = {
	row: number;
	name: string;
	status: "matched" | "unmatched" | "ambiguous" | "invalid";
	reason: string;
	link?: FootballCoachPlayerLink;
};

// Player identity processing boundary: names and identifiers stay in the local
// game. They are never sent to the reference site or a remote matching service.
const normalizeName = (value: string) =>
	value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^\da-z]/g, "");
const normalizeHeader = (value: string) =>
	value.toLowerCase().replace(/[^\da-z]/g, "");
const positionGroup = (position: string | undefined) => {
	const pos = position?.toUpperCase();
	if (
		["OT", "T", "G", "C", "OG", "LT", "RT", "LG", "RG", "OL"].includes(
			pos ?? "",
		)
	) {
		return "OL";
	}
	if (["DT", "DE", "NT", "DL"].includes(pos ?? "")) {
		return "DL";
	}
	if (["OLB", "ILB", "MLB", "LB"].includes(pos ?? "")) {
		return "LB";
	}
	if (["FS", "SS", "S"].includes(pos ?? "")) {
		return "S";
	}
	if (pos === "FB") {
		return "RB";
	}
	return pos;
};

export const findFootballReferenceMatches = (
	roster: Pick<FootballCoachRosterPlayer, "name" | "pos" | "birthYear">,
	players: FootballCoachReferencePlayer[],
) => {
	const name = normalizeName(roster.name);
	if (!name) {
		return [];
	}
	return players.filter((player) => {
		if (normalizeName(player.name) !== name) {
			return false;
		}
		// Positions are mutable and source-specific. A matching known birth year
		// is stronger identity evidence; collisions still return multiple matches.
		if (roster.birthYear !== undefined && player.birthYear !== undefined) {
			return roster.birthYear === player.birthYear;
		}
		return (
			!player.position ||
			positionGroup(player.position) === positionGroup(roster.pos)
		);
	});
};

export const autoLinkFootballRoster = (
	roster: FootballCoachRosterPlayer[],
	players: FootballCoachReferencePlayer[],
) => {
	const links = roster.flatMap((player) => {
		const matches = findFootballReferenceMatches(player, players);
		return matches.length === 1
			? [
					{
						pid: player.pid,
						gsisId: matches[0]!.gsisId,
						name: player.name,
						birthYear: player.birthYear,
					},
				]
			: [];
	});
	const pids = new Map<number, number>();
	const ids = new Map<string, number>();
	for (const link of links) {
		pids.set(link.pid, (pids.get(link.pid) ?? 0) + 1);
		ids.set(link.gsisId, (ids.get(link.gsisId) ?? 0) + 1);
	}
	return links.filter(
		(link) => pids.get(link.pid) === 1 && ids.get(link.gsisId) === 1,
	);
};

// d3's CSV parser accepts unterminated quotes and uneven rows. Validate the
// spreadsheet shape before constructing identity objects or choosing aliases.
const readIdentityTable = (text: string) => {
	const clean = text.replace(/^\uFEFF/, "");
	let quoted = false;
	let commas = 0;
	let tabs = 0;
	for (let i = 0; i < clean.length; i++) {
		const char = clean[i];
		if (char === '"') {
			if (quoted && clean[i + 1] === '"') {
				i += 1;
			} else {
				quoted = !quoted;
			}
		} else if (!quoted) {
			if (char === "\r" || char === "\n") {
				break;
			}
			if (char === ",") {
				commas += 1;
			}
			if (char === "\t") {
				tabs += 1;
			}
		}
	}
	const delimiter = tabs > commas ? "\t" : ",";
	quoted = false;
	let fieldStart = true;
	let closedQuote = false;
	for (let i = 0; i < clean.length; i++) {
		const char = clean[i];
		if (quoted) {
			if (char === '"') {
				if (clean[i + 1] === '"') {
					i += 1;
				} else {
					quoted = false;
					closedQuote = true;
				}
			}
		} else if (char === delimiter || char === "\r" || char === "\n") {
			fieldStart = true;
			closedQuote = false;
		} else if (char === '"' && fieldStart && !closedQuote) {
			quoted = true;
			fieldStart = false;
		} else {
			if (closedQuote || char === '"') {
				throw new Error(
					"Malformed CSV quoting. Export the spreadsheet as CSV or TSV again.",
				);
			}
			fieldStart = false;
		}
	}
	if (quoted) {
		throw new Error(
			"Unclosed CSV quote. Export the spreadsheet as CSV or TSV again.",
		);
	}
	const records =
		delimiter === "\t" ? tsvParseRows(clean) : csvParseRows(clean);
	const headers = records[0];
	if (!headers?.length || headers.every((header) => !header.trim())) {
		throw new Error("The spreadsheet has no header row.");
	}
	const normalized = headers.map(normalizeHeader);
	if (
		normalized.some((header) => !header) ||
		new Set(normalized).size !== normalized.length
	) {
		throw new Error(
			"CSV headers must be nonempty and unique, including spaces and punctuation variants.",
		);
	}
	const rows: { row: number; values: Record<string, string> }[] = [];
	for (let i = 1; i < records.length; i++) {
		const record = records[i]!;
		if (record.length === 1 && record[0] === "") {
			continue;
		}
		if (record.length !== headers.length) {
			throw new Error(
				`CSV row ${i + 1} has ${record.length} fields; expected ${headers.length}.`,
			);
		}
		rows.push({
			row: i + 1,
			values: Object.fromEntries(
				headers.map((header, index) => [header, record[index]!]),
			),
		});
	}
	return { headers, rows };
};

export const previewFootballCoachCsv = (
	text: string,
	roster: FootballCoachRosterPlayer[],
	players: FootballCoachReferencePlayer[],
): FootballCoachCsvRow[] => {
	if (new TextEncoder().encode(text).length > 2_000_000) {
		throw new Error("Use a CSV under 2 MB containing player identity columns.");
	}
	const { headers, rows } = readIdentityTable(text);
	if (rows.length > 5000) {
		throw new Error("Use at most 5,000 player rows per file.");
	}
	const columns = new Map(
		headers.map((column) => [normalizeHeader(column), column]),
	);
	const column = (...aliases: string[]) => {
		const matches = aliases.flatMap((alias) =>
			columns.has(alias) ? [columns.get(alias)!] : [],
		);
		if (matches.length > 1) {
			throw new Error(
				`Use one column for ${aliases[0]}, not conflicting aliases: ${matches.join(", ")}.`,
			);
		}
		return matches[0];
	};
	const nameColumn = column(
		"name",
		"player",
		"playername",
		"fullname",
		"displayname",
	);
	const firstNameColumn = column("firstname");
	const lastNameColumn = column("lastname");
	const pidColumn = column("pid", "fbgmpid");
	const gsisColumn = column("gsisid", "nflverseid");
	const pfrColumn = column("pfrid");
	const posColumn = column("position", "pos", "gameposition");
	const birthYearColumn = column("birthyear", "bornyear");
	if (
		!nameColumn &&
		!firstNameColumn &&
		!pidColumn &&
		!gsisColumn &&
		!pfrColumn
	) {
		throw new Error("Include pid, gsis_id, pfr_id, or player name columns.");
	}
	const byGsis = new Map(players.map((player) => [player.gsisId, player]));
	const result = rows.map(
		({ row: rowNumber, values: row }): FootballCoachCsvRow => {
			const name = (
				nameColumn
					? (row[nameColumn] ?? "")
					: `${firstNameColumn ? (row[firstNameColumn] ?? "") : ""} ${lastNameColumn ? (row[lastNameColumn] ?? "") : ""}`
			).trim();
			const pidText = pidColumn ? row[pidColumn]?.trim() : undefined;
			const gsis = gsisColumn ? row[gsisColumn]?.trim() : undefined;
			const pfr = pfrColumn ? row[pfrColumn]?.trim() : undefined;
			const base = {
				row: rowNumber,
				name: name || gsis || pfr || pidText || "Unnamed row",
			};
			if (
				pidText &&
				(!/^\d+$/.test(pidText) || !Number.isSafeInteger(Number(pidText)))
			) {
				return {
					...base,
					status: "invalid",
					reason: "Football GM pid must be a nonnegative safe integer.",
				};
			}
			const birthText = birthYearColumn
				? row[birthYearColumn]?.trim()
				: undefined;
			if (birthText && !/^\d{4}$/.test(birthText)) {
				return {
					...base,
					status: "invalid",
					reason: "Birth year must have four digits.",
				};
			}
			const birthYear = birthText ? Number(birthText) : undefined;
			let references = gsis
				? players.filter((player) => player.gsisId === gsis)
				: pfr
					? players.filter((player) => player.pfrId === pfr)
					: [];
			if ((gsis || pfr) && references.length !== 1) {
				return {
					...base,
					status: references.length > 1 ? "ambiguous" : "invalid",
					reason:
						"The supplied NFL identifier is not unique in the verified reference data.",
				};
			}
			if (gsis && pfr && references[0]?.pfrId !== pfr) {
				return {
					...base,
					status: "invalid",
					reason: "GSIS and PFR identifiers refer to different players.",
				};
			}
			let candidates = pidText
				? roster.filter((player) => player.pid === Number(pidText))
				: roster.filter(
						(player) =>
							normalizeName(player.name) ===
							normalizeName(name || references[0]?.name || ""),
					);
			if (!pidText) {
				const expectedYear = birthYear ?? references[0]?.birthYear;
				if (expectedYear !== undefined) {
					candidates = candidates.filter(
						(player) =>
							player.birthYear === undefined ||
							player.birthYear === expectedYear,
					);
				}
			}
			const suppliedPosition = posColumn ? row[posColumn]?.trim() : undefined;
			if (suppliedPosition && !pidText && candidates.length > 1) {
				candidates = candidates.filter(
					(player) =>
						positionGroup(player.pos) === positionGroup(suppliedPosition),
				);
			}
			if (candidates.length !== 1) {
				return {
					...base,
					status: candidates.length > 1 ? "ambiguous" : "unmatched",
					reason: pidText
						? "This player ID is not in this game's rosters."
						: "A unique player in this game's rosters could not be identified. Add pid and gsis_id.",
				};
			}
			const candidate = candidates[0]!;
			if (
				birthYear !== undefined &&
				((candidate.birthYear !== undefined &&
					birthYear !== candidate.birthYear) ||
					(references[0]?.birthYear !== undefined &&
						birthYear !== references[0].birthYear))
			) {
				return {
					...base,
					status: "invalid",
					reason:
						"The birth year conflicts with the player's verified identity.",
				};
			}
			if (name && normalizeName(name) !== normalizeName(candidate.name)) {
				return {
					...base,
					status: "invalid",
					reason: "The player name conflicts with the Football GM player ID.",
				};
			}
			if (references.length === 0) {
				references = findFootballReferenceMatches(candidate, players);
			}
			if (references.length !== 1) {
				return {
					...base,
					status: references.length > 1 ? "ambiguous" : "unmatched",
					reason:
						"No unique NFL identity match. Add a verified gsis_id; names are never guessed.",
				};
			}
			const reference = references[0]!;
			if (
				normalizeName(reference.name) !== normalizeName(candidate.name) ||
				(candidate.birthYear &&
					reference.birthYear &&
					candidate.birthYear !== reference.birthYear)
			) {
				return {
					...base,
					status: "invalid",
					reason:
						"The NFL identifier conflicts with the league player's identity.",
				};
			}
			if (!byGsis.has(reference.gsisId)) {
				return {
					...base,
					status: "invalid",
					reason: "Unknown NFL identifier.",
				};
			}
			return {
				...base,
				name: candidate.name,
				status: "matched",
				reason: "Verified identity match",
				link: {
					pid: candidate.pid,
					name: candidate.name,
					birthYear: candidate.birthYear,
					gsisId: reference.gsisId,
				},
			};
		},
	);
	const counts = new Map<number, number>();
	const gsisCounts = new Map<string, number>();
	for (const row of result) {
		if (row.link) {
			counts.set(row.link.pid, (counts.get(row.link.pid) ?? 0) + 1);
			gsisCounts.set(
				row.link.gsisId,
				(gsisCounts.get(row.link.gsisId) ?? 0) + 1,
			);
		}
	}
	return result.map((row) =>
		row.link &&
		(counts.get(row.link.pid)! > 1 || gsisCounts.get(row.link.gsisId)! > 1)
			? {
					...row,
					status: "invalid",
					reason:
						"Duplicate rows target the same league player or NFL identity. Keep one verified row.",
					link: undefined,
				}
			: row,
	);
};

export const validateFootballCoachLinks = (
	links: FootballCoachPlayerLink[],
	roster: FootballCoachRosterPlayer[],
	players: FootballCoachReferencePlayer[],
) => {
	if (!Array.isArray(links) || links.length > 5000) {
		throw new Error("Invalid player links.");
	}
	const pids = new Set<number>();
	const gsisIds = new Set<string>();
	const verified: FootballCoachPlayerLink[] = [];
	for (const link of links) {
		if (
			!link ||
			!Number.isSafeInteger(link.pid) ||
			link.pid < 0 ||
			typeof link.gsisId !== "string" ||
			!link.gsisId ||
			link.gsisId !== link.gsisId.trim() ||
			typeof link.name !== "string" ||
			!normalizeName(link.name) ||
			(link.birthYear !== undefined && !Number.isInteger(link.birthYear)) ||
			pids.has(link.pid) ||
			gsisIds.has(link.gsisId)
		) {
			throw new Error("Invalid or duplicate player link.");
		}
		pids.add(link.pid);
		gsisIds.add(link.gsisId);
		const rosterMatches = roster.filter((player) => player.pid === link.pid);
		const referenceMatches = players.filter(
			(player) => player.gsisId === link.gsisId,
		);
		if (rosterMatches.length !== 1 || referenceMatches.length !== 1) {
			throw new Error("A saved link has an unknown or ambiguous identity.");
		}
		const player = rosterMatches[0]!;
		const reference = referenceMatches[0]!;
		if (
			!player ||
			!reference ||
			normalizeName(player.name) !== normalizeName(link.name) ||
			normalizeName(player.name) !== normalizeName(reference.name) ||
			(player.birthYear &&
				reference.birthYear &&
				player.birthYear !== reference.birthYear) ||
			(link.birthYear !== undefined && link.birthYear !== player.birthYear)
		) {
			throw new Error(
				"A saved link does not match this league player's verified identity.",
			);
		}
		verified.push({
			pid: player.pid,
			gsisId: reference.gsisId,
			name: player.name,
			birthYear: player.birthYear,
		});
	}
	return verified;
};
