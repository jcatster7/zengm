import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";

let cached: Promise<FootballCoachReference> | undefined;

// Bundled public data only: league files, names and game decisions are never
// uploaded. Fetching this same-origin file also works in a private local copy.
export const loadFootballCoachReference = () => {
	if (!cached) {
		cached = (async () => {
			const response = await fetch("/files/football-coach-reference.json", {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) {
				throw new Error("The bundled NFL reference data could not be loaded.");
			}
			const data = (await response.json()) as FootballCoachReference;
			if (
				data.schemaVersion !== 1 ||
				!Array.isArray(data.players) ||
				!Array.isArray(data.profiles) ||
				!Array.isArray(data.sources) ||
				!Array.isArray(data.seasons)
			) {
				throw new Error("Unsupported NFL reference data.");
			}
			return data;
		})().catch((error: unknown) => {
			cached = undefined;
			throw error;
		});
	}
	return cached;
};
