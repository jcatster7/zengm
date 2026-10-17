import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDB, type IDBPDatabase } from "@dumbmatter/idb";
import * as fake from "fake-indexeddb";
import type { MetaDB } from "../db/connectMeta.ts";
import { SafeIdb } from "../db/SafeIdb.ts";
import { idb } from "../db/index.ts";
import { g } from "../util/index.ts";
import { footballCoach } from "../core/game/footballCoach.ts";
import * as referenceLoader from "../core/game/footballCoachReference.ts";
import type { FootballCoachReference } from "../../common/footballCoachReference.ts";
import type { FootballCoachRosterPlayer } from "../../common/footballCoachSession.ts";
import actions from "./actions.ts";

const lid = 70001;
const roster: FootballCoachRosterPlayer[] = [
	{ pid: 0, name: "Test First", pos: "QB", team: "T", birthYear: 1998 },
	{ pid: 1, name: "Test Second", pos: "WR", team: "T", birthYear: 1999 },
	{ pid: 2, name: "Test First", pos: "QB", team: "T", birthYear: 1998 },
];
const links = [
	{ pid: 0, name: "Test First", birthYear: 1998, gsisId: "00-0000001" },
	{ pid: 1, name: "Test Second", birthYear: 1999, gsisId: "00-0000002" },
];
const reference: FootballCoachReference = {
	schemaVersion: 1,
	generatedAt: "2026-01-01T00:00:00.000Z",
	seasons: [2025],
	sources: [],
	profiles: [],
	players: links.map((link) => ({
		name: link.name,
		birthYear: link.birthYear,
		gsisId: link.gsisId,
	})),
};
const start = () =>
	footballCoach.start({
		lid,
		gid: 123,
		controlledTeam: 0,
		teams: [
			{ tid: 0, abbrev: "T", region: "Test", name: "Home", colors: [] },
			{ tid: 1, abbrev: "O", region: "Test", name: "Away", colors: [] },
		],
		rosters: [roster, []],
	});
let database: IDBPDatabase<MetaDB>;
let originalMeta: typeof idb.meta;
let originalLid: number;
let sessionId: string;

beforeEach(async () => {
	for (const [name, value] of Object.entries(fake)) {
		if (name.startsWith("IDB")) {
			vi.stubGlobal(name, value);
		}
	}
	vi.stubGlobal("indexedDB", new fake.IDBFactory());
	database = await openDB<MetaDB>("football-coach-link-test", 1, {
		upgrade(db) {
			db.createObjectStore("attributes");
		},
	});
	originalMeta = idb.meta;
	originalLid = g.get("lid");
	idb.meta = new SafeIdb(() => Promise.resolve(database));
	// The test factory returns one connection; production connectMeta opens a new
	// connection per call. Warm this fixture before testing transaction concurrency.
	await idb.meta.get("attributes", `footballCoachLinks:${lid}`);
	g.setWithoutSavingToDB("lid", lid);
	sessionId = start().sessionId;
	vi.spyOn(referenceLoader, "loadFootballCoachReference").mockResolvedValue(
		reference,
	);
});

afterEach(() => {
	footballCoach.complete(lid, "/test-cleanup");
	idb.meta = originalMeta;
	g.setWithoutSavingToDB("lid", originalLid);
	database.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("concurrent imports serialize their native metadata transactions without losing links", async () => {
	await Promise.all(
		links.map((link) =>
			actions.saveFootballCoachLinks({
				sessionId,
				filename: "test.csv",
				links: [link],
			}),
		),
	);
	const saved = await actions.getFootballCoachLinks();
	expect(saved?.links.map((link) => link.pid).sort()).toEqual([0, 1]);
	expect(saved?.links).toHaveLength(2);
	expect(
		await database.get("attributes", `footballCoachLinks:${lid + 1}`),
	).toBeUndefined();
});

test("reassigning a GSIS identity removes its previous native pid and preserves other links", async () => {
	await actions.saveFootballCoachLinks({
		sessionId,
		filename: "first.csv",
		links,
	});
	const result = await actions.saveFootballCoachLinks({
		sessionId,
		filename: "second.csv",
		links: [{ ...links[0]!, pid: 2 }],
	});
	expect(result.links.map((link) => link.pid).sort()).toEqual([1, 2]);
	expect(new Set(result.links.map((link) => link.gsisId)).size).toBe(2);
	expect(await actions.getFootballCoachLinks()).toEqual(result);
});

test("a same-league session switch during reference loading rejects the stale save", async () => {
	let resolve!: (value: FootballCoachReference) => void;
	vi.mocked(referenceLoader.loadFootballCoachReference).mockReturnValue(
		new Promise((value) => {
			resolve = value;
		}),
	);
	const pending = actions.saveFootballCoachLinks({
		sessionId,
		filename: "stale.csv",
		links: [links[0]!],
	});
	footballCoach.complete(lid, "/test-next-game");
	start();
	resolve(reference);
	await expect(pending).rejects.toThrow("game or league changed");
	expect(await actions.getFootballCoachLinks()).toBeNull();
});

test("worker validation rejects tampered links before opening a write transaction", async () => {
	const transaction = vi.spyOn(idb.meta, "transaction");
	await expect(
		actions.saveFootballCoachLinks({
			sessionId,
			filename: "bad.csv",
			links: [{ ...links[0]!, gsisId: links[1]!.gsisId }],
		}),
	).rejects.toThrow("identity");
	expect(transaction).not.toHaveBeenCalled();
	expect(await actions.getFootballCoachLinks()).toBeNull();
});
