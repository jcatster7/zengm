import { assert, expect, test, vi } from "vitest";
// @ts-expect-error Test-only Node module is outside the browser project's ambient types.
import fs from "node:fs/promises";
import * as fakeIndexedDB from "fake-indexeddb";
import api from "../../api/index.ts";
import actions from "../../api/actions.ts";
import leagueFileUpload, {
	decompressStreamIfNecessary,
	parseJSON,
} from "../../api/leagueFileUpload.ts";
import { Cache, connectLeague, connectMeta, idb } from "../../db/index.ts";
import { SafeIdb } from "../../db/SafeIdb.ts";
import { league, player, season } from "../index.ts";
import { g, helpers, local, lock } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import { getDefaultSettings } from "../../views/newLeague.ts";
import gameLog from "../../views/gameLog.ts";
import { unwrapGameAttribute } from "../../../common/unwrapGameAttribute.ts";
import { LEAGUE_DATABASE_VERSION } from "../../../common/constants.ts";
import type { FootballCoachDecision } from "../../../common/footballCoach.ts";
import {
	FOOTBALL_COACH_CALLS,
	FOOTBALL_COACH_DEFENSES,
} from "../../../common/footballCoachPlaybook.ts";
import type {
	Game,
	GamePlayer,
	Player,
	ScheduleGameWithoutKey,
} from "../../../common/types.ts";
import { footballCoach } from "./footballCoach.ts";
import loadTeams from "./loadTeams.ts";

/**
 * Native upload -> createLeague/createStream -> coaching API -> game save ->
 * disconnect/reopen. All IndexedDB operations use a fresh in-memory factory;
 * no browser database or source export is changed. Opt in with a local export:
 *
 * FOOTBALL_COACH_FULL_IMPORT_FILE='/absolute/path/league.json.gz' \
 * NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run \
 * --project football src/worker/core/game/footballCoachFullImport.football.test.ts
 *
 * This proves the worker/database path, not the browser file chooser, rendering,
 * browser-specific IndexedDB behavior, or the realism of a single game's score.
 */
const sourcePath = (
	globalThis as unknown as {
		process: { env: Record<string, string | undefined> };
	}
).process.env.FOOTBALL_COACH_FULL_IMPORT_FILE;

const digest = async (input: Uint8Array) => {
	const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(input));
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};

const finite = (value: unknown) => {
	if (typeof value === "number") {
		assert.isTrue(Number.isFinite(value));
	} else if (value && typeof value === "object") {
		Object.values(value).forEach(finite);
	}
};

test.skipIf(!sourcePath)(
	"full native local export import, coached save, and database reopen",
	async () => {
		const original = {
			league: idb.league,
			cache: idb.cache,
			meta: idb.meta,
			g: { ...g },
			local: { ...local },
			fetch: globalThis.fetch,
		};
		const lid = 72031;
		let database: typeof idb.league | undefined;
		const random = vi.spyOn(Math, "random");
		let rng = 92738521;
		random.mockImplementation(() => {
			rng = (1664525 * rng + 1013904223) >>> 0;
			return rng / 2 ** 32;
		});
		try {
			for (const [name, value] of Object.entries(fakeIndexedDB)) {
				if (name.startsWith("IDB")) {
					vi.stubGlobal(name, value);
				}
			}
			vi.stubGlobal("indexedDB", new fakeIndexedDB.IDBFactory());
			// Route only the bundled same-origin reference to disk, as test setup
			// already does for native static data. No network or browser file access.
			vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0]) => {
				if (url === "/files/football-coach-reference.json") {
					return new Response(
						await fs.readFile(
							new URL(
								"../../../../public/files/football-coach-reference.json",
								import.meta.url,
							),
							"utf8",
						),
					);
				}
				return original.fetch(url);
			});
			idb.meta = new SafeIdb(connectMeta);
			idb.league = undefined as unknown as typeof idb.league;
			idb.cache = new Cache();
			resetG();
			local.reset();
			lock.reset();
			// PII processing boundary: user roster data stays in local memory and the
			// isolated database. Output contains aggregate counts and a source hash.
			const bytes: Uint8Array = await fs.readFile(sourcePath!);
			const sourceHash = await digest(bytes);
			const file = new File(
				[Uint8Array.from(bytes)],
				"native-compatibility.json.gz",
			);
			const { basicInfo, schemaErrors } = await leagueFileUpload.initialCheck(
				{
					file,
					includePlayersInBasicInfo: true,
					leagueCreationID: "native-compatibility",
				},
				{},
			);
			assert.lengthOf(
				schemaErrors,
				0,
				"Native upload schema validation must pass",
			);
			const sourcePlayers = basicInfo.players as Player[];
			const selectedTid = unwrapGameAttribute(
				basicInfo.gameAttributes,
				"userTid",
			);
			const sourceSeason = unwrapGameAttribute(
				basicInfo.gameAttributes,
				"season",
			);
			const sourceSchedule: ScheduleGameWithoutKey[] = [];
			const reader = (await decompressStreamIfNecessary(file.stream()))
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(parseJSON())
				.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value.key === "schedule") {
					sourceSchedule.push(value.value as ScheduleGameWithoutKey);
				}
			}
			// Same attribute-to-settings mapping as the NewLeague upload UI. Keeping
			// defaults alone would silently overwrite settings from the source file.
			const settings = getDefaultSettings();
			for (const key of helpers.keys(settings)) {
				if (
					key === "noStartingInjuries" ||
					key === "randomization" ||
					key === "realStats" ||
					key === "giveMeWorstRoster"
				) {
					continue;
				}
				const value = unwrapGameAttribute(basicInfo.gameAttributes, key);
				if (value !== undefined) {
					(settings as unknown as Record<string, unknown>)[key] =
						key === "repeatSeason" ? (value as { type: string })?.type : value;
				}
			}
			settings.noStartingInjuries = false;
			await api.main.createLeague(
				{
					name: "Isolated native file compatibility",
					tid: selectedTid,
					file,
					url: undefined,
					keptKeys: [...basicInfo.keys],
					shuffleRosters: false,
					importLid: lid,
					getLeagueOptions: undefined,
					startingSeasonFromInput: undefined,
					confs: unwrapGameAttribute(basicInfo.gameAttributes, "confs"),
					divs: unwrapGameAttribute(basicInfo.gameAttributes, "divs"),
					teamsFromInput: helpers.addPopRank(basicInfo.teams!),
					settings,
					fromFile: {
						gameAttributes: basicInfo.gameAttributes,
						maxGid: basicInfo.maxGid,
						hasRookieContracts: basicInfo.hasRookieContracts,
						startingSeason: basicInfo.startingSeason,
						teams: basicInfo.teams,
						version: basicInfo.version,
					},
					leagueCreationID: "native-compatibility",
				},
				{},
			);
			database = idb.league;
			// Entering a newly created league loads its saved attributes and fills
			// native compatibility defaults before any game or view can run.
			await league.loadGameAttributes();
			assert.equal(database.version, LEAGUE_DATABASE_VERSION);
			assert.isTrue(local.leagueLoaded);
			assert.equal(g.get("userTid"), selectedTid);
			assert.equal(g.get("season"), sourceSeason);
			assert.equal(
				g.get("phase"),
				unwrapGameAttribute(basicInfo.gameAttributes, "phase"),
			);
			for (const key of [
				"numGames",
				"quarterLength",
				"numPeriods",
				"minRosterSize",
				"salaryCap",
				"injuryRate",
			] as const) {
				assert.deepEqual(
					g.get(key),
					unwrapGameAttribute(basicInfo.gameAttributes, key),
				);
			}
			const imported = await database.getAll("players");
			const importedByPid = new Map(imported.map((p) => [p.pid, p]));
			for (const p of sourcePlayers) {
				const actual = importedByPid.get(p.pid)!;
				assert.isDefined(
					actual,
					"Every source player ID must survive the import",
				);
				assert.equal(actual.tid, p.tid);
				assert.equal(actual.firstName, p.firstName);
				assert.equal(actual.lastName, p.lastName);
				if (p.injury?.gamesRemaining > 0) {
					assert.deepEqual(actual.injury, p.injury);
				}
			}
			const importedTeams = await database.getAll("teams");
			assert.deepEqual(
				importedTeams.map((t) => [t.tid, t.name, Boolean(t.disabled)]),
				basicInfo.teams!.map((t) => [t.tid, t.name, Boolean(t.disabled)]),
			);
			const scheduled = await season.getSchedule();
			assert.deepEqual(
				scheduled.map(({ homeTid, awayTid, day }) => ({
					homeTid,
					awayTid,
					day,
				})),
				sourceSchedule.map(({ homeTid, awayTid, day }) => ({
					homeTid,
					awayTid,
					day,
				})),
			);
			const matchup = (await season.getSchedule(true)).find(
				(entry) =>
					entry.homeTid === selectedTid || entry.awayTid === selectedTid,
			);
			assert.isDefined(
				matchup,
				"Selected team must have a game on the first imported schedule day",
			);
			const { gid, homeTid, awayTid } = matchup!;
			const controlledTeam = homeTid === selectedTid ? 0 : 1;
			const loaded = await loadTeams([homeTid, awayTid], {});
			const unavailable = new Set<number>();
			for (const tid of [homeTid, awayTid]) {
				for (const p of loaded[tid]!.player) {
					if (p.injured) {
						unavailable.add(p.id);
					}
				}
			}
			const beforeTeamStats = structuredClone(
				await idb.cache.teamStats.getAll(),
			);
			const gamesBefore = await database.count("games");
			const profiles = new Set<string>();
			let offenseDecisions = 0;
			let defenseDecisions = 0;
			let clockDecisions = 0;
			let ownTimeouts = 0;
			await actions.interactiveGame(gid, {});
			const started = performance.now();
			while (footballCoach.isActive()) {
				assert.isBelow(
					performance.now() - started,
					90_000,
					"Coached API must finish",
				);
				const session = actions.getFootballCoach()!;
				assert.equal(session.controlledTid, selectedTid);
				assert.equal(session.controlledTeam, controlledTeam);
				if (session.status !== "waiting") {
					await new Promise((resolve) => setTimeout(resolve, 0));
					continue;
				}
				const snapshot = session.snapshot!;
				assert.equal(snapshot.boxScore?.season, sourceSeason);
				finite([
					snapshot.clock,
					snapshot.down,
					snapshot.toGo,
					snapshot.scrimmage,
					snapshot.timeouts,
					snapshot.boxScore?.teams.map((t) => t.stat),
				]);
				for (const side of [0, 1] as const) {
					const tid = side === 0 ? homeTid : awayTid;
					for (const p of snapshot.playersOnField[side]) {
						assert.equal(importedByPid.get(p.id)?.tid, tid);
						assert.isFalse(
							unavailable.has(p.id),
							"Initially unavailable players cannot take the field",
						);
					}
				}
				for (const p of [
					...(snapshot.eligibleReceivers ?? []),
					...(snapshot.eligibleRushers ?? []),
				]) {
					assert.isFalse(p.injured);
					assert.isFalse(unavailable.has(p.id));
				}
				if (snapshot.lastCall?.referenceProfile) {
					profiles.add(snapshot.lastCall.referenceProfile);
				}
				let decision: FootballCoachDecision;
				if (snapshot.stage === "clock") {
					clockDecisions += 1;
					if (!ownTimeouts && snapshot.canTimeout[controlledTeam]) {
						decision = { timeout: controlledTeam };
						ownTimeouts += 1;
					} else {
						decision =
							snapshot.offense === controlledTeam ? { tempo: "normal" } : {};
					}
				} else if (snapshot.offense === controlledTeam) {
					decision = snapshot.allowedPlays.includes("run")
						? {
								callId:
									FOOTBALL_COACH_CALLS[
										offenseDecisions++ % FOOTBALL_COACH_CALLS.length
									]!.id,
							}
						: { play: "auto" };
				} else {
					assert.throws(
						() =>
							actions.submitFootballCoach({
								sessionId: session.sessionId,
								revision: session.revision,
								decision: { callId: "slant" },
							}),
						/own team/,
					);
					decision = {
						defenseId:
							FOOTBALL_COACH_DEFENSES[
								defenseDecisions++ % FOOTBALL_COACH_DEFENSES.length
							]!.id,
					};
				}
				actions.submitFootballCoach({
					sessionId: session.sessionId,
					revision: session.revision,
					decision,
				});
			}
			await footballCoach.finishBeforeClosingLeague();
			const finished = actions.getFootballCoach()!;
			assert.equal(finished.status, "complete", finished.error);
			assert.equal(finished.reference?.status, "loaded");
			assert.isAbove(profiles.size, 0);
			assert.isAbove(offenseDecisions, 0);
			assert.isAbove(defenseDecisions, 0);
			assert.isAbove(clockDecisions, 0);
			assert.equal(ownTimeouts, 1);
			const finalStats = finished.snapshot!.boxScore!;
			for (const t of finalStats.teams) {
				for (const p of t.players) {
					finite(p.stat);
					if (unavailable.has(p.id)) {
						assert.equal(p.stat.gp, 0);
					}
				}
			}
			await idb.cache.flush();
			const beforeClose = {
				game: await database.get("games", gid),
				players: await database.getAll("players"),
				teams: await database.getAll("teams"),
				teamStats: await database.getAll("teamStats"),
				teamSeasons: await database.getAll("teamSeasons"),
				schedule: await database.getAll("schedule"),
				gameAttributes: await database.getAll("gameAttributes"),
			};
			assert.isDefined(beforeClose.game);
			assert.equal(await database.count("games"), gamesBefore + 1);
			const rawStats = player.stats.raw;
			let participantStatComparisons = 0;
			let didNotPlay = 0;
			for (const t of finalStats.teams) {
				const savedTeam: Game["teams"][number] = beforeClose.game!.teams.find(
					(entry) => entry.tid === t.id,
				)!;
				for (const [stat, value] of Object.entries(t.stat)) {
					assert.deepEqual(value, savedTeam[stat], `Team ${t.id}: ${stat}`);
				}
				assert.equal(
					savedTeam.players.length,
					t.players.filter((p) => p.stat.gp! > 0).length,
				);
				for (const p of t.players) {
					const savedPlayer: GamePlayer | undefined = savedTeam.players.find(
						(entry: GamePlayer) => entry.pid === p.id,
					);
					if (!savedPlayer) {
						// Native box scores omit DNPs; the live panel retains the roster.
						didNotPlay += 1;
						assert.equal(p.stat.gp, 0);
						for (const stat of rawStats) {
							assert.equal(p.stat[stat], 0, `DNP ${p.id}: ${stat}`);
						}
						continue;
					}
					assert.isAbove(p.stat.gp!, 0);
					for (const stat of rawStats) {
						assert.equal(
							p.stat[stat],
							savedPlayer[stat],
							`Player ${p.id}: ${stat}`,
						);
						participantStatComparisons += 1;
					}
					assert.deepEqual(
						p.injury,
						{
							...savedPlayer.injury,
							playingThrough: !!savedPlayer.injury.playingThrough,
						},
						"Final live injury metadata must match the saved native diagnosis",
					);
				}
			}
			assert.deepEqual(
				beforeClose.schedule.map((entry) => entry.gid),
				scheduled
					.filter((entry) => entry.gid !== gid)
					.map((entry) => entry.gid),
			);
			for (const tid of [homeTid, awayTid]) {
				const previous = beforeTeamStats.find(
					(row) =>
						row.tid === tid && row.season === sourceSeason && !row.playoffs,
				);
				const saved = beforeClose.teamStats.find(
					(row) =>
						row.tid === tid && row.season === sourceSeason && !row.playoffs,
				)!;
				assert.isDefined(saved);
				assert.equal(saved.gp, (previous?.gp ?? 0) + 1);
			}
			assert.deepEqual(
				beforeClose.game!.scoringSummary,
				finalStats.scoringSummary,
			);
			await league.close(true);
			assert.isUndefined(g.get("lid"));
			assert.throws(() => database!.transaction("games"));
			helpers.resetG();
			assert.throws(() => g.get("season"), /not already set/);
			database = await connectLeague(lid);
			idb.league = database;
			g.setWithoutSavingToDB("lid", lid);
			idb.cache = new Cache();
			await idb.cache.fill();
			await league.loadGameAttributes();
			assert.equal(g.get("season"), sourceSeason);
			assert.equal(g.get("userTid"), selectedTid);
			assert.deepEqual(
				g.get("userTids"),
				unwrapGameAttribute(basicInfo.gameAttributes, "userTids"),
			);
			for (const store of [
				"players",
				"teams",
				"teamStats",
				"teamSeasons",
				"schedule",
				"gameAttributes",
			] as const) {
				assert.deepEqual(
					await database.getAll(store),
					beforeClose[store],
					`${store} must survive a real database disconnect`,
				);
			}
			assert.deepEqual(await idb.merged.games.get(gid), beforeClose.game);
			await footballCoach.finishBeforeClosingLeague();
			await idb.cache.flush();
			assert.equal(
				await database.count("games"),
				gamesBefore + 1,
				"Finishing again must not duplicate a saved result",
			);
			assert.deepEqual(await idb.cache.schedule.getAll(), beforeClose.schedule);
			const selectedTeam = importedTeams.find((t) => t.tid === selectedTid)!;
			const view = await gameLog.load({
				inputs: {
					gid,
					season: sourceSeason,
					tid: selectedTid,
					abbrev: selectedTeam.abbrev,
				},
				updateEvents: new Set(["firstRun"]),
				prevInputs: undefined,
				prevOutput: {},
				conditions: {},
			});
			expect(view.boxScore).toMatchObject({
				gid,
				season: sourceSeason,
				scoringSummary: finalStats.scoringSummary,
				teams: finalStats.teams.map((t) => ({ tid: t.id, pts: t.stat.pts })),
			});
			assert.equal(await digest(await fs.readFile(sourcePath!)), sourceHash);
			console.info(
				JSON.stringify({
					file: sourcePath!.split("/").at(-1),
					sha256: sourceHash,
					sourceVersion: basicInfo.version,
					databaseVersion: database.version,
					sourcePlayers: sourcePlayers.length,
					importedPlayers: imported.length,
					teams: importedTeams.length,
					activeTeams: importedTeams.filter((t) => !t.disabled).length,
					sourceInjuries: sourcePlayers.filter(
						(p) => p.injury?.gamesRemaining > 0,
					).length,
					scheduledBefore: scheduled.length,
					scheduledAfter: beforeClose.schedule.length,
					gamesAdded: (await database.count("games")) - gamesBefore,
					participantStatComparisons,
					didNotPlay,
					selectedTid,
					gid,
					homeTid,
					awayTid,
					unavailable: unavailable.size,
					offenseDecisions,
					defenseDecisions,
					clockDecisions,
					profiles: [...profiles].sort(),
					score: finalStats.teams.map((t) => t.stat.pts),
					schemaErrors: 0,
					sourceUnchanged: true,
					nativeSaveReopened: true,
				}),
			);
		} finally {
			if (footballCoach.isActive()) {
				footballCoach.fail(lid, new Error("integration test cleanup"));
			}
			await footballCoach.finishBeforeClosingLeague().catch(() => {});
			footballCoach.complete(lid, "/integration-test-cleanup");
			idb.cache.stopAutoFlush();
			(idb.league ?? database)?.close();
			await idb.meta.close();
			idb.league = original.league;
			idb.cache = original.cache;
			idb.meta = original.meta;
			random.mockRestore();
			vi.unstubAllGlobals();
			lock.reset();
			for (const key of Object.keys(g)) {
				if (!Object.hasOwn(original.g, key)) {
					delete (g as Record<string, unknown>)[key];
				}
			}
			Object.assign(g, original.g);
			Object.assign(local, original.local);
		}
	},
	180_000,
);
