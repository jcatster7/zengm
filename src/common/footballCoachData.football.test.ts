import { describe, expect, test } from "vitest";
import type { FootballCoachRosterPlayer } from "./footballCoachSession.ts";
import type { FootballCoachReferencePlayer } from "./footballCoachReference.ts";
import {
	autoLinkFootballRoster,
	findFootballReferenceMatches,
	previewFootballCoachCsv,
	validateFootballCoachLinks,
	type FootballCoachPlayerLink,
} from "./footballCoachData.ts";

// Invented identity fixtures used only by tests, never shipped as reference data.
const roster: FootballCoachRosterPlayer[] = [
	{ pid: 0, name: "Alex One", pos: "QB", team: "A", birthYear: 1998 },
	{ pid: 1, name: "Dan Two", pos: "OL", team: "A", birthYear: 1995 },
	{ pid: 2, name: "Sam Same", pos: "WR", team: "A", birthYear: 1993 },
	{ pid: 3, name: "Sam Same", pos: "WR", team: "B", birthYear: 2001 },
	{ pid: 4, name: "Chris Clone", pos: "CB", team: "B", birthYear: 1997 },
	{ pid: 5, name: "José O'Neil", pos: "CB", team: "B", birthYear: 1996 },
];
const players: FootballCoachReferencePlayer[] = roster.map((player, index) => ({
	gsisId: `00-000000${index + 1}`,
	pfrId: `Test${index}00`,
	name: player.name,
	position: player.pos === "OL" ? "OT" : player.pos,
	birthYear: player.birthYear,
}));
const valid: FootballCoachPlayerLink = {
	pid: 0,
	name: "Alex One",
	birthYear: 1998,
	gsisId: "00-0000001",
};
const preview = (text: string, localRoster = roster, reference = players) =>
	previewFootballCoachCsv(text, localRoster, reference);

describe("Football Coach local identity previews", () => {
	test("supports BOM, normalized headers, numeric pid zero, accents and position groups", () => {
		expect(
			preview(
				"\uFEFF FBGM PID ,GSIS_ID,Full Name\r\n0,00-0000001,Alex One\r\n",
			)[0],
		).toMatchObject({ status: "matched", link: valid });
		expect(preview("name,position\nDan Two, OT \n")[0]).toMatchObject({
			status: "matched",
			link: { pid: 1, gsisId: "00-0000002" },
		});
		expect(preview("first_name,last_name\nJose,ONeil\n")[0]).toMatchObject({
			status: "matched",
			link: { pid: 5 },
		});
	});

	test("supports TSV, quoted multiline values and delimiters inside quoted headers", () => {
		expect(preview("name\tpfr_id\nAlex One\tTest000\n")[0]!.status).toBe(
			"matched",
		);
		expect(
			preview('name,gsis_id\n"José\nO\'Neil",00-0000006\n')[0]!.status,
		).toBe("matched");
		expect(preview('"na\tme",gsis_id\nAlex One,00-0000001\n')[0]!.status).toBe(
			"matched",
		);
		expect(() =>
			preview('name,gsis_id\n"An ""escaped"" name",\n'),
		).not.toThrow();
	});

	test("leaves same-name players ambiguous until a verified ID or birth year distinguishes them", () => {
		expect(preview("name\nSam Same\n")[0]!.status).toBe("ambiguous");
		expect(preview("name,birth_year\nSam Same,1993\n")[0]).toMatchObject({
			status: "matched",
			link: { pid: 2, gsisId: "00-0000003" },
		});
		expect(preview("gsis_id\n00-0000004\n")[0]).toMatchObject({
			status: "matched",
			link: { pid: 3 },
		});
		expect(
			findFootballReferenceMatches({ name: "Sam Same", pos: "WR" }, players),
		).toHaveLength(2);
		expect(
			findFootballReferenceMatches(
				{ name: "Sam Same", pos: "WR", birthYear: 1993 },
				players,
			),
		).toHaveLength(1);
	});

	test.each([
		"pid,name\n0,Dan Two\n",
		"pid,gsis_id\n0,00-0000002\n",
		"pid,gsis_id,pfr_id\n0,00-0000001,Test100\n",
		"pid,birth_year\n0,1999\n",
		"pid,birth_year\n0,1998.0\n",
		"gsis_id\n00-9999999\n",
		"pfr_id\nUnknown00\n",
	])("rejects conflicting or unknown supplied identities: %s", (text) => {
		const result = preview(text)[0]!;
		expect(result.status).toBe("invalid");
		expect(result.link).toBeUndefined();
	});

	test.each(["-1", "1.0", "1e0", "9007199254740993", "NaN", "Infinity"])(
		"rejects malformed native IDs: %s",
		(pid) => {
			expect(preview(`pid\n${pid}\n`)[0]!.status).toBe("invalid");
		},
	);

	test("rejects duplicate source identifiers, duplicate player rows, and shared GSIS assignments", () => {
		expect(
			preview("gsis_id\n00-0000001\n", roster, [...players, players[0]!])[0]!
				.status,
		).toBe("ambiguous");
		const duplicates = preview("pid,gsis_id\n0,00-0000001\n0,00-0000001\n");
		expect(
			duplicates.every(
				(item) => item.status === "invalid" && item.link === undefined,
			),
		).toBe(true);
		const cloneRoster = [...roster, { ...roster[4]!, pid: 6 }];
		const shared = preview(
			"pid,gsis_id\n4,00-0000005\n6,00-0000005\n",
			cloneRoster,
		);
		expect(
			shared.every(
				(item) => item.status === "invalid" && item.link === undefined,
			),
		).toBe(true);
		expect(
			autoLinkFootballRoster(cloneRoster, players).some(
				(link) => link.gsisId === "00-0000005",
			),
		).toBe(false);
	});

	test.each([
		'name,gsis_id\n"Alex One,00-0000001',
		'name,gsis_id\n"Alex One"extra,00-0000001',
		'name,gsis_id\nAlex "One",00-0000001',
		"name,gsis_id\nAlex One,00-0000001,unexpected",
		"name,gsis_id\nAlex One",
		"name,Name\nAlex One,Alex One",
		"gsis_id,GSIS ID\n00-0000001,00-0000001",
		"name,full_name\nAlex One,Dan Two",
		",name\n0,Alex One",
		"",
	])("rejects malformed spreadsheet shape before matching: %s", (text) => {
		expect(() => preview(text)).toThrow();
	});

	test("requires identity columns, keeps record numbers and enforces byte/row limits", () => {
		expect(() => preview("position\nQB\n")).toThrow("Include pid");
		expect(preview("name\n\nAlex One\n")[0]!.row).toBe(3);
		expect(() => preview(`name\n${"é".repeat(1000000)}`)).toThrow("under 2 MB");
		expect(() => preview(`name\n${"Alex One\n".repeat(5001)}`)).toThrow(
			"5,000",
		);
	});

	test("uses birth year across position changes, with a position fallback when age is unknown", () => {
		expect(
			findFootballReferenceMatches({ name: "", pos: "QB" }, [
				{ gsisId: "x", name: "" },
			]),
		).toEqual([]);
		expect(
			findFootballReferenceMatches({ name: "Alex One", pos: "WR" }, players),
		).toEqual([]);
		expect(
			findFootballReferenceMatches(
				{ name: "Alex One", pos: "WR", birthYear: 1998 },
				players,
			),
		).toHaveLength(1);
		expect(
			findFootballReferenceMatches(
				{ name: "Alex One", pos: "QB", birthYear: 1999 },
				players,
			),
		).toEqual([]);
		const duplicatePid = [{ ...roster[0]! }, { ...roster[1]!, pid: 0 }];
		expect(autoLinkFootballRoster(duplicatePid, players)).toEqual([]);
	});
});

describe("worker-side identity validation", () => {
	test("revalidates canonical names and returns detached links", () => {
		const input = [{ ...valid, name: "ALEX ONE" }];
		const verified = validateFootballCoachLinks(input, roster, players);
		expect(verified).toEqual([valid]);
		expect(verified).not.toBe(input);
		expect(verified[0]).not.toBe(input[0]);
		verified[0]!.name = "Changed";
		expect(input[0]!.name).toBe("ALEX ONE");
	});

	test.each([
		null,
		{},
		[null],
		[{ ...valid, pid: -1 }],
		[{ ...valid, pid: 0.5 }],
		[{ ...valid, pid: "0" }],
		[{ ...valid, pid: Number.MAX_SAFE_INTEGER + 1 }],
		[{ ...valid, gsisId: "" }],
		[{ ...valid, gsisId: " 00-0000001" }],
		[{ ...valid, gsisId: 1 }],
		[{ ...valid, name: "" }],
		[{ ...valid, name: "Dan Two" }],
		[{ ...valid, birthYear: 1999 }],
		[{ ...valid, birthYear: Number.NaN }],
		[{ ...valid, birthYear: "1998" }],
		[{ ...valid, gsisId: "00-0000002" }],
		[{ ...valid, pid: 999 }],
		[valid, valid],
		[valid, { ...valid, pid: 1 }],
	])("rejects tampered, stale or duplicate payload %#", (payload) => {
		expect(() =>
			validateFootballCoachLinks(payload as never, roster, players),
		).toThrow();
	});

	test("rejects ambiguous underlying identifiers and inconsistent league/reference birth years", () => {
		expect(() =>
			validateFootballCoachLinks([valid], [...roster, roster[0]!], players),
		).toThrow("ambiguous");
		expect(() =>
			validateFootballCoachLinks([valid], roster, [...players, players[0]!]),
		).toThrow("ambiguous");
		expect(() =>
			validateFootballCoachLinks([valid], roster, [
				{ ...players[0]!, birthYear: 1999 },
			]),
		).toThrow("identity");
		expect(() =>
			validateFootballCoachLinks(
				Array.from({ length: 5001 }, () => valid),
				roster,
				players,
			),
		).toThrow("Invalid player links");
	});
});
