/** Public NFL reference data, separate from a league's native player IDs/ratings. */
export type FootballCoachReferencePlayer = {
	gsisId: string;
	pfrId?: string;
	name: string;
	position?: string;
	/** Latest published team, not necessarily the team in a historical season. */
	team?: string;
	birthYear?: number;
};

export type FootballCoachReferenceSource = {
	name: string;
	url: string;
	license: string;
	/** SHA-256 of the downloaded bytes, before decompressing CSV.gz. */
	sha256: string;
};

export type FootballCoachReferenceProfile = {
	id: string;
	label: string;
	sampleSize: number;
	/** Completions / actual pass attempts; sacks are excluded from this denominator. */
	completionRate: number | null;
	/** Plays with an interception or lost fumble / sampleSize. */
	turnoverRate: number;
	meanYards: number;
	meanAirYards: number | null;
	/** Recorded dropbacks (including sacks/scrambles) / sampleSize. */
	passRate: number;
	passAttempts: number;
	airYardsSampleSize: number;
	rushSampleSize: number;
	/** Observed air yards on actual throws, not a distribution of complete dropbacks. */
	airYardsDistribution?: { yards: number; count: number }[];
	/** Observed yards on rushes, including scrambles where present in a profile. */
	rushYardsDistribution?: { yards: number; count: number }[];
};

export type FootballCoachReference = {
	schemaVersion: 1;
	generatedAt: string;
	seasons: number[];
	sources: FootballCoachReferenceSource[];
	players: FootballCoachReferencePlayer[];
	profiles: FootballCoachReferenceProfile[];
};
