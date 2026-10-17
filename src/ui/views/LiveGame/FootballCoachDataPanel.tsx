import { useEffect, useMemo, useRef, useState } from "react";
import { csvFormat } from "d3-dsv";
import type { FootballCoachSession } from "../../../common/footballCoachSession.ts";
import type { FootballCoachReference } from "../../../common/footballCoachReference.ts";
import {
	autoLinkFootballRoster,
	previewFootballCoachCsv,
	validateFootballCoachLinks,
	type FootballCoachCsvRow,
	type FootballCoachLinkFile,
} from "../../../common/footballCoachData.ts";
import { toWorker } from "../../util/toWorker.ts";
import { downloadFile } from "../../util/downloadFile.ts";

// Player identity processing boundary: spreadsheet contents are parsed locally.
// Only validated identity links are stored in this league's local database.
export const FootballCoachDataPanel = ({
	session,
}: {
	session: FootballCoachSession;
}) => {
	const [reference, setReference] = useState<FootballCoachReference>();
	const [saved, setSaved] = useState<FootballCoachLinkFile | null>(null);
	const [preview, setPreview] = useState<FootballCoachCsvRow[]>();
	const [filename, setFilename] = useState("");
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [busy, setBusy] = useState(false);
	const readVersion = useRef(0);
	useEffect(() => {
		let cancelled = false;
		Promise.all([
			toWorker("actions", "getFootballCoachReference", undefined),
			toWorker("actions", "getFootballCoachLinks", undefined),
		])
			.then(([data, links]) => {
				if (!cancelled) {
					setReference(data);
					setSaved(links);
				}
			})
			.catch((error_: unknown) => {
				if (!cancelled) {
					setError(
						error_ instanceof Error
							? error_.message
							: "Unable to load NFL reference data.",
					);
				}
			});
		return () => {
			cancelled = true;
			readVersion.current += 1;
		};
	}, [session.sessionId]);
	const roster = useMemo(
		() => session.rosters?.flat() ?? [],
		[session.rosters],
	);
	const links = useMemo(() => {
		if (!reference) {
			return [];
		}
		const automatic = autoLinkFootballRoster(roster, reference.players);
		const validSaved = (saved?.links ?? []).flatMap((link) => {
			try {
				return validateFootballCoachLinks([link], roster, reference.players);
			} catch {
				return [];
			}
		});
		const explicit = new Map(validSaved.map((link) => [link.pid, link]));
		return [
			...automatic.filter((link) => !explicit.has(link.pid)),
			...explicit.values(),
		];
	}, [reference, roster, saved]);
	const matched =
		preview
			?.filter((row) => row.status === "matched" && row.link)
			.map((row) => row.link!) ?? [];
	const importFile = async (file: File) => {
		const version = ++readVersion.current;
		setError(undefined);
		setNotice(undefined);
		setPreview(undefined);
		if (!reference) {
			return;
		}
		try {
			if (file.size > 2_000_000) {
				throw new Error("Use a CSV or TSV under 2 MB.");
			}
			const text = await file.text();
			if (version !== readVersion.current) {
				return;
			}
			setFilename(file.name);
			setPreview(previewFootballCoachCsv(text, roster, reference.players));
		} catch (error_) {
			if (version === readVersion.current) {
				setError(
					error_ instanceof Error
						? error_.message
						: "Unable to read that spreadsheet.",
				);
			}
		}
	};
	const save = async () => {
		setBusy(true);
		setError(undefined);
		try {
			const result = await toWorker("actions", "saveFootballCoachLinks", {
				sessionId: session.sessionId,
				filename,
				links: matched,
			});
			setSaved(result);
			setNotice(
				`${matched.length} verified player links saved for this league.`,
			);
			setPreview(undefined);
		} catch (error_) {
			setError(
				error_ instanceof Error
					? error_.message
					: "Unable to save player links.",
			);
		} finally {
			setBusy(false);
		}
	};
	const exportTemplate = () => {
		const byPid = new Map(links.map((link) => [link.pid, link.gsisId]));
		const safe = (value: string) =>
			/^[\t\r+=@-]/.test(value) ? `'${value}` : value;
		downloadFile(
			"football-gm-nflverse-player-links.csv",
			csvFormat(
				roster.map((p) => ({
					pid: p.pid,
					name: safe(p.name),
					position: safe(p.pos),
					team: safe(p.team),
					gsis_id: byPid.get(p.pid) ?? "",
				})),
			),
			"text/csv",
		);
	};
	return (
		<section
			className="football-coach-panel p-3"
			aria-label="NFL data and spreadsheet links"
		>
			<h3 className="h5">NFL data &amp; spreadsheet links</h3>
			<p>
				Native Football GM players, ratings, injuries, and results stay
				connected to your league. Historical NFL play distributions inform
				tactical calls; they do not replace your players' ratings.
			</p>
			{session.reference?.status === "fallback" ? (
				<p role="status" className="alert alert-warning">
					{session.reference.message}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="alert alert-danger">
					{error}
				</p>
			) : null}
			{notice ? (
				<p role="status" className="alert alert-success">
					{notice}
				</p>
			) : null}
			{!reference && !error ? (
				<p role="status">Loading historical NFL reference…</p>
			) : null}
			{reference ? (
				<>
					{session.snapshot?.lastCall?.referenceProfile ? (
						<p className="small">
							Last tactical play used the{" "}
							{reference.profiles.find(
								(profile) =>
									profile.id === session.snapshot?.lastCall?.referenceProfile,
							)?.label ?? session.snapshot.lastCall.referenceProfile}{" "}
							reference profile (
							{session.snapshot.lastCall.referenceSampleSize?.toLocaleString()}{" "}
							source plays), with native player ratings and tactical
							adjustments.
						</p>
					) : null}
					<p>
						<strong>
							{links.length} of {roster.length}
						</strong>{" "}
						players in this matchup have a unique NFL identity match. Reference
						seasons: {reference.seasons.join(", ")}. Unmatched players keep
						their native Football GM simulation.
					</p>
					<div className="d-flex flex-wrap align-items-center gap-2 mb-3">
						<button
							type="button"
							className="btn btn-outline-light btn-sm"
							onClick={exportTemplate}
						>
							Export player-link template
						</button>
						<label className="mb-0">
							Import spreadsheet CSV / TSV
							<input
								className="form-control form-control-sm mt-1"
								type="file"
								accept=".csv,.tsv,text/csv,text/tab-separated-values"
								disabled={busy}
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) {
										void importFile(file);
									}
									event.target.value = "";
								}}
							/>
						</label>
					</div>
					<p className="small">
						Use pid, name, position, and gsis_id or pfr_id columns. Export a
						workbook or Google Sheet as CSV first. Preview checks both
						identifiers and player identity; ambiguous rows are never guessed.
						This connects player identities locally, not live spreadsheet
						formulas or ratings.
					</p>
					{saved ? (
						<p className="small">
							Last saved: {saved.filename} ·{" "}
							{new Date(saved.updatedAt).toLocaleString()}
						</p>
					) : null}
					{preview ? (
						<div className="mb-3">
							<p>
								{matched.length} verified / {preview.length} rows in {filename}.
								Only verified rows can be saved.
							</p>
							<div className="table-responsive" style={{ maxHeight: 280 }}>
								<table className="table table-dark table-sm">
									<thead>
										<tr>
											<th>Row</th>
											<th>Player</th>
											<th>Status</th>
											<th>Details</th>
										</tr>
									</thead>
									<tbody>
										{preview.map((row) => (
											<tr key={row.row}>
												<td>{row.row}</td>
												<td>{row.name}</td>
												<td>{row.status}</td>
												<td>{row.reason}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<button
								type="button"
								className="btn btn-success btn-sm"
								disabled={busy || matched.length === 0}
								onClick={() => {
									void save();
								}}
							>
								{busy ? "Saving…" : `Save ${matched.length} verified links`}
							</button>
						</div>
					) : null}
					<details>
						<summary>Historical play samples and attribution</summary>
						<p className="small mt-2">
							Observed NFL outcomes, not predicted success for the current play.
							Profiles can overlap. Completion rate uses pass attempts.
							Inside/outside run profiles exclude quarterback scrambles; RPO and
							trick profiles can include them. Tactical personnel and route
							adjustments are game rules.
						</p>
						<div className="table-responsive">
							<table className="table table-dark table-sm">
								<thead>
									<tr>
										<th>Profile</th>
										<th>Plays</th>
										<th>Mean yards</th>
										<th>Pass attempts</th>
										<th>Completion</th>
									</tr>
								</thead>
								<tbody>
									{reference.profiles.map((profile) => (
										<tr key={profile.id}>
											<td>{profile.label}</td>
											<td>{profile.sampleSize.toLocaleString()}</td>
											<td>{profile.meanYards.toFixed(1)}</td>
											<td>{profile.passAttempts.toLocaleString()}</td>
											<td>
												{profile.completionRate === null
													? "—"
													: `${(profile.completionRate * 100).toFixed(1)}%`}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="small">
							nflverse and FTN Data via nflverse. Derived profiles: CC BY-SA
							4.0. Built {new Date(reference.generatedAt).toLocaleDateString()}.
						</p>
						<ul className="small">
							{reference.sources.map((source) => (
								<li key={source.url}>
									<a href={source.url} target="_blank" rel="noreferrer">
										{source.name}
									</a>{" "}
									· {source.license}
								</li>
							))}
						</ul>
					</details>
				</>
			) : null}
		</section>
	);
};
