import { readFileSync, statSync } from "node:fs";
import { csvFormat } from "d3-dsv";
import { describe, expect, test } from "vitest";
import type reference from "../../public/files/football-coach-reference.json";
import {
	aggregateSeason,
	classifyPlay,
	createAccumulators,
	finishProfiles,
	parseCharting,
} from "./buildNflverseReference.ts";

// Deliberate small test fixtures; none of these rows enter the published dataset.
const base = {
	season: "2025",
	game_id: "2025_01_TEST_HOME",
	play_id: "1",
	play_type: "run",
	play_deleted: "0",
	qb_kneel: "0",
	qb_spike: "0",
	qb_scramble: "0",
	qb_dropback: "0",
	penalty: "0",
	two_point_attempt: "0",
	sack: "0",
	pass_attempt: "0",
	complete_pass: "0",
	rush_attempt: "1",
	air_yards: "",
	run_location: "middle",
	run_gap: "guard",
	desc: "Runner up the middle",
	yards_gained: "3",
	interception: "0",
	fumble_lost: "0",
};
const pass = {
	play_type: "pass",
	qb_dropback: "1",
	pass_attempt: "1",
	rush_attempt: "0",
	run_location: "",
	run_gap: "",
};
const row = (id: number, overrides: Partial<typeof base> = {}) => ({
	...base,
	play_id: String(id),
	...overrides,
});
const chartCsv = (
	rows: ReturnType<typeof row>[],
	flags: Record<
		string,
		Partial<{ is_screen_pass: string; is_rpo: string; is_trick_play: string }>
	> = {},
) =>
	csvFormat(
		rows.map((play) => ({
			season: play.season,
			nflverse_game_id: play.game_id,
			nflverse_play_id: play.play_id,
			is_screen_pass: "FALSE",
			is_rpo: "FALSE",
			is_trick_play: "FALSE",
			...flags[play.play_id],
		})),
	);

describe("offline nflverse reference aggregation", () => {
	test("joins numeric IDs, excludes nonstandard samples and preserves distinct denominators", () => {
		const rows = [
			row(1, {
				...pass,
				air_yards: "3",
				yards_gained: "8",
				complete_pass: "1",
			}),
			row(2, {
				...pass,
				air_yards: "5",
				yards_gained: "0",
				interception: "1",
				fumble_lost: "1",
			}),
			row(3, {
				...pass,
				air_yards: "12",
				yards_gained: "17",
				complete_pass: "1",
			}),
			row(4, { ...pass, air_yards: "25", yards_gained: "0" }),
			row(5, { ...pass, sack: "1", yards_gained: "-7" }),
			row(6),
			row(7, {
				run_location: "right",
				run_gap: "end",
				yards_gained: "8",
				fumble_lost: "1",
			}),
			row(8, { desc: "Runner on a draw", yards_gained: "-1" }),
			row(9, { qb_scramble: "1", qb_dropback: "1", yards_gained: "11" }),
			row(10, { penalty: "1", yards_gained: "99" }),
			row(11, { play_deleted: "1", yards_gained: "99" }),
			row(12, { qb_kneel: "1" }),
			row(13, { ...pass, qb_spike: "1" }),
			row(14, { two_point_attempt: "1" }),
			row(15, { play_type: "no_play" }),
			row(16, { yards_gained: "NA" }),
		];
		const charting = parseCharting(
			chartCsv(rows, {
				1: { is_screen_pass: "TRUE", is_rpo: "TRUE" },
				3: { is_trick_play: "TRUE" },
				5: { is_screen_pass: "TRUE" },
				6: { is_rpo: "TRUE" },
				7: { is_trick_play: "TRUE" },
				9: { is_rpo: "TRUE" },
			}),
			2025,
		);
		rows[0]!.play_id = "1.0";
		const accumulator = createAccumulators();
		expect(
			aggregateSeason(csvFormat(rows), 2025, charting, accumulator),
		).toEqual({ eligible: 9, matchedCharting: 9 });
		const result = new Map(
			finishProfiles(accumulator).map((profile) => [profile.id, profile]),
		);
		expect(result.get("runInside")).toMatchObject({
			sampleSize: 2,
			meanYards: 1,
			completionRate: null,
			airYardsSampleSize: 0,
			rushSampleSize: 2,
		});
		expect(result.get("runInside")!.rushYardsDistribution).toEqual([
			{ yards: -1, count: 1 },
			{ yards: 3, count: 1 },
		]);
		expect(result.get("runOutside")).toMatchObject({
			sampleSize: 1,
			meanYards: 8,
			turnoverRate: 1,
		});
		expect(result.get("runDraw")).toMatchObject({
			sampleSize: 1,
			meanYards: -1,
		});
		expect(result.get("passShort")).toMatchObject({
			sampleSize: 2,
			passAttempts: 2,
			completionRate: 0.5,
			turnoverRate: 0.5,
			meanAirYards: 4,
		});
		expect(result.get("passMedium")).toMatchObject({
			sampleSize: 1,
			meanAirYards: 12,
		});
		expect(result.get("passDeep")).toMatchObject({
			sampleSize: 1,
			meanAirYards: 25,
		});
		expect(result.get("passScreen")).toMatchObject({
			sampleSize: 2,
			passAttempts: 1,
			completionRate: 1,
			meanYards: 0.5,
			airYardsSampleSize: 1,
		});
		expect(result.get("rpo")).toMatchObject({
			sampleSize: 3,
			passAttempts: 1,
			rushSampleSize: 2,
			completionRate: 1,
		});
		expect(result.get("rpo")!.passRate).toBeCloseTo(2 / 3, 7);
		expect(result.get("trick")).toMatchObject({
			sampleSize: 2,
			meanYards: 12.5,
			turnoverRate: 0.5,
			passAttempts: 1,
		});
	});

	test("does not invent a draw or RPO from a shotgun run, or depth from missing air yards", () => {
		expect(classifyPlay({ ...base, shotgun: "1" })).toEqual(["runInside"]);
		expect(classifyPlay({ ...base, desc: "A penalty was drawn" })).toEqual([
			"runInside",
		]);
		expect(classifyPlay({ ...base, ...pass, air_yards: "NA" })).toEqual([]);
		expect(classifyPlay({ ...base, ...pass, air_yards: "-4" })).toEqual([
			"passShort",
		]);
		expect(classifyPlay({ ...base, ...pass, air_yards: "10" })).toEqual([
			"passMedium",
		]);
		expect(classifyPlay({ ...base, ...pass, air_yards: "20" })).toEqual([
			"passDeep",
		]);
		expect(finishProfiles(createAccumulators())).toEqual([]);
	});

	test("rejects incomplete schemas, duplicate identities, wrong seasons and disconnected joins", () => {
		const one = row(1);
		expect(() => parseCharting("season\n2025\n", 2025)).toThrow(
			"missing required column",
		);
		expect(() => parseCharting(chartCsv([one, one]), 2025)).toThrow(
			"Duplicate FTN",
		);
		expect(() => parseCharting(chartCsv([one]), 2024)).toThrow(
			"unexpected season",
		);
		expect(() =>
			parseCharting(chartCsv([row(1, { play_id: "bad" })]), 2025),
		).toThrow("Invalid play identity");
		const chart = parseCharting(chartCsv([one]), 2025);
		expect(() =>
			aggregateSeason(csvFormat([one, one]), 2025, chart, createAccumulators()),
		).toThrow("Duplicate eligible PBP");
		expect(() =>
			aggregateSeason(csvFormat([one]), 2024, chart, createAccumulators()),
		).toThrow("unexpected season");
		expect(() =>
			aggregateSeason(csvFormat([row(2)]), 2025, chart, createAccumulators()),
		).toThrow("No eligible PBP/FTN join");
	});

	test("missing individual FTN rows stay unclassified rather than borrowing flags", () => {
		const rows = [row(1), row(2)];
		const chart = parseCharting(
			chartCsv([rows[0]!], { 1: { is_rpo: "TRUE" } }),
			2025,
		);
		const acc = createAccumulators();
		expect(aggregateSeason(csvFormat(rows), 2025, chart, acc)).toEqual({
			eligible: 2,
			matchedCharting: 1,
		});
		expect(
			finishProfiles(acc).find((profile) => profile.id === "rpo")!.sampleSize,
		).toBe(1);
	});

	test("published JSON has valid identities, provenance, rates and exact histogram totals", () => {
		const filename = new URL(
			"../../public/files/football-coach-reference.json",
			import.meta.url,
		);
		const data = JSON.parse(readFileSync(filename, "utf8")) as typeof reference;
		expect(statSync(filename).size).toBeLessThan(2000000);
		expect(data.schemaVersion).toBe(1);
		expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
		expect(data.seasons).toEqual([2023, 2024, 2025]);
		expect(data.sources).toHaveLength(7);
		expect(new Set(data.sources.map((source) => source.url)).size).toBe(7);
		for (const source of data.sources) {
			expect(source.url).toMatch(
				/^ht{2}ps:\/{2}github\.com(?:\/nflverse){2}-data\/releases\/download\//,
			);
			expect(source.sha256).toMatch(/^[\da-f]{64}$/);
			expect([
				"https://creativecommons.org/licenses/by/4.0/",
				"https://creativecommons.org/licenses/by-sa/4.0/",
			]).toContain(source.license);
		}
		expect(data.players.length).toBeGreaterThan(4000);
		expect(new Set(data.players.map((player) => player.gsisId)).size).toBe(
			data.players.length,
		);
		for (const player of data.players) {
			expect(player.gsisId).toBeTruthy();
			expect(player.name).toBeTruthy();
			if (player.birthYear !== undefined) {
				expect(Number.isInteger(player.birthYear)).toBe(true);
			}
		}
		expect(data.profiles.map((profile) => profile.id)).toEqual([
			"runInside",
			"runOutside",
			"passShort",
			"passMedium",
			"passDeep",
			"passScreen",
			"rpo",
			"trick",
		]);
		for (const profile of data.profiles) {
			expect(
				Number.isInteger(profile.sampleSize) && profile.sampleSize > 0,
			).toBe(true);
			expect(Number.isFinite(profile.meanYards)).toBe(true);
			for (const rate of [
				profile.completionRate,
				profile.turnoverRate,
				profile.passRate,
			]) {
				if (rate !== null) {
					expect(Number.isFinite(rate) && rate >= 0 && rate <= 1).toBe(true);
				}
			}
			expect(profile.completionRate === null).toBe(profile.passAttempts === 0);
			for (const [field, countField] of [
				["airYardsDistribution", "airYardsSampleSize"],
				["rushYardsDistribution", "rushSampleSize"],
			] as const) {
				const distribution = profile[field] ?? [];
				expect(distribution.reduce((sum, item) => sum + item.count, 0)).toBe(
					profile[countField],
				);
				expect(new Set(distribution.map((item) => item.yards)).size).toBe(
					distribution.length,
				);
				for (const item of distribution) {
					expect(Number.isInteger(item.yards)).toBe(true);
					expect(Number.isInteger(item.count) && item.count > 0).toBe(true);
				}
			}
			if (profile.airYardsSampleSize) {
				const mean =
					profile.airYardsDistribution!.reduce(
						(sum, item) => sum + item.yards * item.count,
						0,
					) / profile.airYardsSampleSize;
				expect(profile.meanAirYards).toBeCloseTo(mean, 7);
			} else {
				expect(profile.meanAirYards).toBeNull();
			}
		}
	});
});
