import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assertQueryOnly,
	createLinearRequester,
	GraphqlSafetyError,
	type GraphqlRequester,
	LINEAR_GRAPHQL_ENDPOINT,
} from "./graphql.js";
import { isAxiRepresentable } from "./representability.js";
import type {
	CommentSnapshot,
	IssueSnapshot,
	LinearSnapshot,
	ProjectSnapshot,
	RelationSnapshot,
	TeamSnapshot,
} from "./types.js";

/** Maximum number of records captured by each primary workspace connection. */
export const MAX_SNAPSHOT_LIMIT = 25;
export const DEFAULT_SNAPSHOT_LIMIT = 25;
/** Detail is intentionally limited to the first ten issues in the base result. */
export const ISSUE_DETAIL_LIMIT = 10;
export const COMMENT_DETAIL_LIMIT = 10;
export const RELATION_DETAIL_LIMIT = 10;

export const VIEWER_QUERY = "query BenchmarkViewer { viewer { id } }";
export const TEAMS_QUERY =
	"query BenchmarkTeams($first:Int!){teams(first:$first){nodes{id name key} pageInfo{hasNextPage endCursor}}}";
export const ISSUES_QUERY =
	"query BenchmarkIssues($first:Int!){issues(first:$first){nodes{id identifier title url state{name} team{id key name}} pageInfo{hasNextPage endCursor}}}";
/** Uses Linear's title.containsIgnoreCase substring semantics, but asks for only two records. */
export const ISSUE_TITLE_SEARCH_QUERY =
	"query BenchmarkIssueTitleSearch($title:String!,$first:Int!){issues(filter:{title:{containsIgnoreCase:$title}},first:$first){nodes{id identifier title} pageInfo{hasNextPage endCursor}}}";
export const SEARCH_VALIDATION_LIMIT = 2;
/** Direct identifier probes are intentionally capped independently of snapshots. */
export const INVALID_IDENTIFIER_PROBE_LIMIT = 10;
export const INVALID_ISSUE_QUERY =
	"query BenchmarkConfirmedAbsentIssue($identifier:String!){issue(id:$identifier){id identifier}}";
export const ISSUE_DETAIL_QUERY =
	"query BenchmarkIssueDetail($id:String!,$commentFirst:Int!,$relationFirst:Int!){issue(id:$id){comments(first:$commentFirst){nodes{id body} pageInfo{hasNextPage endCursor}} relations(first:$relationFirst){nodes{type relatedIssue{identifier title}} pageInfo{hasNextPage endCursor}} inverseRelations(first:$relationFirst){nodes{type issue{identifier title}} pageInfo{hasNextPage endCursor}}}}";
export const PROJECTS_QUERY =
	"query BenchmarkProjects($first:Int!){projects(first:$first){nodes{id name url status{name}} pageInfo{hasNextPage endCursor}}}";

export interface CaptureSnapshotOptions {
	apiKey?: string;
	endpoint?: string;
	requester?: GraphqlRequester;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	first?: number;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function nodes(value: unknown): Record<string, unknown>[] {
	const connection = record(value);
	return Array.isArray(connection.nodes) ? connection.nodes.map(record) : [];
}

function hasNextPage(value: unknown): boolean {
	return record(record(value).pageInfo).hasNextPage === true;
}

function teamFromValue(value: unknown): TeamSnapshot | undefined {
	const team = record(value);
	const id = stringValue(team.id);
	const key = stringValue(team.key);
	const name = stringValue(team.name);
	if (!id || !key || !name) {
		return undefined;
	}
	return { id, key, name };
}

function commentsFromIssue(issue: Record<string, unknown>): CommentSnapshot[] {
	return nodes(issue.comments).flatMap((comment) => {
		const id = stringValue(comment.id);
		if (!id) {
			return [];
		}
		const body = stringValue(comment.body);
		return [
			{
				id,
				...(body ? { body } : {}),
			},
		];
	});
}

function relationsFromIssue(
	issue: Record<string, unknown>,
): RelationSnapshot[] {
	const outgoing = nodes(issue.relations).flatMap((relation) => {
		const type = stringValue(relation.type);
		const relatedIssue = record(relation.relatedIssue);
		const relatedIdentifier = stringValue(relatedIssue.identifier);
		if (!type || !relatedIdentifier) {
			return [];
		}
		const relatedTitle = stringValue(relatedIssue.title);
		return [
			{ type, relatedIdentifier, ...(relatedTitle ? { relatedTitle } : {}) },
		];
	});
	const incoming = nodes(issue.inverseRelations).flatMap((relation) => {
		const type = stringValue(relation.type);
		const relatedIssue = record(relation.issue);
		const relatedIdentifier = stringValue(relatedIssue.identifier);
		if (!type || !relatedIdentifier) {
			return [];
		}
		const relatedTitle = stringValue(relatedIssue.title);
		return [
			{ type, relatedIdentifier, ...(relatedTitle ? { relatedTitle } : {}) },
		];
	});
	return [...outgoing, ...incoming];
}

function issuesFromData(data: Record<string, unknown>): IssueSnapshot[] {
	return nodes(data.issues).flatMap((issue) => {
		const id = stringValue(issue.id);
		const identifier = stringValue(issue.identifier);
		const title = stringValue(issue.title);
		if (!id || !identifier || !title) {
			return [];
		}
		const stateName = stringValue(record(issue.state).name);
		const url = stringValue(issue.url);
		const team = teamFromValue(issue.team);
		return [
			{
				id,
				identifier,
				title,
				comments: [],
				relations: [],
				...(url ? { url } : {}),
				...(stateName ? { stateName } : {}),
				...(team ? { team } : {}),
			},
		];
	});
}

function projectsFromData(data: Record<string, unknown>): ProjectSnapshot[] {
	return nodes(data.projects).flatMap((project) => {
		const id = stringValue(project.id);
		const name = stringValue(project.name);
		if (!id || !name) {
			return [];
		}
		const url = stringValue(project.url);
		const statusName = stringValue(record(project.status).name);
		return [
			{
				id,
				name,
				...(url ? { url } : {}),
				...(statusName ? { statusName } : {}),
			},
		];
	});
}

function deduplicate<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const value = key(item);
		if (seen.has(value)) {
			return false;
		}
		seen.add(value);
		return true;
	});
}

function mergeIssueDetails(
	issues: readonly IssueSnapshot[],
	identifier: string,
	detail: Record<string, unknown>,
): IssueSnapshot[] {
	return issues.map((issue) =>
		issue.identifier === identifier
			? {
					...issue,
					comments: commentsFromIssue(detail).slice(0, COMMENT_DETAIL_LIMIT),
					relations: relationsFromIssue(detail).slice(
						0,
						RELATION_DETAIL_LIMIT * 2,
					),
				}
			: issue,
	);
}

function boundedFirst(value: number | undefined): number {
	const requested = value ?? DEFAULT_SNAPSHOT_LIMIT;
	if (!Number.isInteger(requested) || requested < 1) {
		throw new Error("snapshot first limit must be a positive integer");
	}
	return Math.min(requested, MAX_SNAPSHOT_LIMIT);
}

function deterministicAbsentIdentifier(teamKey: string, offset: number): string {
	const candidate = `${teamKey}-${999_999_999 - offset}`;
	if (!isAxiRepresentable(candidate)) {
		throw new Error(
			`cannot probe a representable invalid issue identifier for team ${teamKey}`,
		);
	}
	return candidate;
}

async function confirmAbsentIssueIdentifier(
	requester: GraphqlRequester,
	teamKey: string,
): Promise<string> {
	for (let offset = 0; offset < INVALID_IDENTIFIER_PROBE_LIMIT; offset += 1) {
		const identifier = deterministicAbsentIdentifier(teamKey, offset);
		const data = await requester(INVALID_ISSUE_QUERY, { identifier });
		const issueValue = data.issue;
		if (issueValue === null) {
			return identifier;
		}
		if (issueValue === undefined) {
			throw new Error(
				`invalid-issue probe for ${identifier} did not explicitly return issue: null`,
			);
		}
		if (typeof issueValue !== "object" || Array.isArray(issueValue)) {
			throw new Error(
				`invalid-issue probe for ${identifier} returned malformed issue data`,
			);
		}
	}
	throw new Error(
		`could not confirm an absent issue identifier after ${INVALID_IDENTIFIER_PROBE_LIMIT} query-only probes for team ${teamKey}`,
	);
}

export async function captureSnapshot(
	options: CaptureSnapshotOptions = {},
): Promise<LinearSnapshot> {
	let requester = options.requester;
	if (!requester) {
		const requestOptions = {
			apiKey: options.apiKey ?? process.env.LINEAR_API_KEY ?? "",
			endpoint: options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT,
		} as Parameters<typeof createLinearRequester>[0];
		if (options.fetchImpl) {
			requestOptions.fetchImpl = options.fetchImpl;
		}
		requester = createLinearRequester(requestOptions);
	}
	const guardedRequester: GraphqlRequester = async (query, variables = {}) => {
		assertQueryOnly(query);
		return requester(query, variables);
	};
	const first = boundedFirst(options.first);
	const [viewerData, teamsData, issuesData] = await Promise.all([
		guardedRequester(VIEWER_QUERY),
		guardedRequester(TEAMS_QUERY, { first }),
		guardedRequester(ISSUES_QUERY, { first }),
	]);

	const viewerId = stringValue(record(viewerData.viewer).id);
	const viewer: { id: string } | undefined = viewerId
		? { id: viewerId }
		: undefined;
	const teams = deduplicate(
		nodes(teamsData.teams).flatMap((team) => {
			const normalized = teamFromValue(team);
			return normalized ? [normalized] : [];
		}),
		(team) => team.id,
	).slice(0, first);
	let issues = deduplicate(
		issuesFromData(issuesData),
		(issue) => issue.identifier,
	).slice(0, first);
	if (!viewer) {
		throw new Error("snapshot cannot continue: Linear viewer data was missing");
	}
	if (teams.length === 0) {
		throw new Error(
			"snapshot cannot continue: the Linear workspace has no readable teams",
		);
	}
	if (issues.length === 0) {
		throw new Error(
			"snapshot cannot continue: the Linear workspace has no readable issues",
		);
	}
	const probeTeam = [...teams].sort((left, right) =>
		left.key.localeCompare(right.key),
	)[0];
	if (!probeTeam) {
		throw new Error(
			"snapshot cannot continue: no existing team was available for the invalid-issue probe",
		);
	}
	const confirmedAbsentIssueIdentifier = await confirmAbsentIssueIdentifier(
		guardedRequester,
		probeTeam.key,
	);

	const warnings: string[] = [];
	let searchIssueIdentifier: string | undefined;
	for (const candidate of issues.slice(0, first)) {
		// AXI's default output would truncate either required search value. Do
		// not probe or select such a record as a source for generated tasks.
		if (
			!isAxiRepresentable(candidate.identifier) ||
			!isAxiRepresentable(candidate.title)
		) {
			continue;
		}
		const searchData = await guardedRequester(ISSUE_TITLE_SEARCH_QUERY, {
			title: candidate.title,
			first: SEARCH_VALIDATION_LIMIT,
		});
		const connection = record(searchData.issues);
		const matches = nodes(searchData.issues);
		const pageInfo = record(connection.pageInfo);
		const match = matches[0];
		const candidateMatches =
			matches.length === 1 &&
			pageInfo.hasNextPage === false &&
			stringValue(match?.id) === candidate.id &&
			stringValue(match?.identifier) === candidate.identifier &&
			stringValue(match?.title) === candidate.title;
		if (candidateMatches) {
			searchIssueIdentifier = candidate.identifier;
			break;
		}
	}
	if (!searchIssueIdentifier) {
		warnings.push(
			`No representable snapshot issue passed the bounded workspace-wide exact-title uniqueness probe; task generation requires searchIssueIdentifier after a successful probe (at most ${first} probes, ${SEARCH_VALIDATION_LIMIT} results each).`,
		);
	}
	if (options.first !== undefined && options.first > MAX_SNAPSHOT_LIMIT) {
		warnings.push(
			`Snapshot limit was capped at ${MAX_SNAPSHOT_LIMIT} records per primary connection.`,
		);
	}
	if (
		hasNextPage(teamsData.teams) ||
		hasNextPage(issuesData.issues) ||
		nodes(teamsData.teams).length > first ||
		nodes(issuesData.issues).length > first
	) {
		warnings.push(
			`Snapshot is bounded to the first ${MAX_SNAPSHOT_LIMIT} teams and issues.`,
		);
	}
	if (issues.length > ISSUE_DETAIL_LIMIT) {
		warnings.push(
			`Issue comments and relations are staged only for the first ${ISSUE_DETAIL_LIMIT} issues; ` +
				`each detail connection is bounded to ${COMMENT_DETAIL_LIMIT} comments and ${RELATION_DETAIL_LIMIT} relations.`,
		);
	}

	for (const issue of issues.slice(0, ISSUE_DETAIL_LIMIT)) {
		try {
			const detailData = await guardedRequester(ISSUE_DETAIL_QUERY, {
				id: issue.id,
				commentFirst: COMMENT_DETAIL_LIMIT,
				relationFirst: RELATION_DETAIL_LIMIT,
			});
			const detail = record(detailData.issue);
			if (!detailData.issue || Object.keys(detail).length === 0) {
				warnings.push(
					`Issue detail was unavailable for ${issue.identifier}; comments and relations may be incomplete.`,
				);
				continue;
			}
			issues = mergeIssueDetails(issues, issue.identifier, detail);
			if (
				hasNextPage(detail.comments) ||
				hasNextPage(detail.relations) ||
				hasNextPage(detail.inverseRelations) ||
				nodes(detail.comments).length > COMMENT_DETAIL_LIMIT ||
				nodes(detail.relations).length > RELATION_DETAIL_LIMIT ||
				nodes(detail.inverseRelations).length > RELATION_DETAIL_LIMIT
			) {
				warnings.push(
					`Issue detail for ${issue.identifier} was truncated to ${COMMENT_DETAIL_LIMIT} comments and ` +
						`${RELATION_DETAIL_LIMIT} relations per direction.`,
				);
			}
		} catch (error: unknown) {
			if (error instanceof GraphqlSafetyError) {
				throw error;
			}
			warnings.push(
				`Issue detail was unavailable for ${issue.identifier}; comments and relations may be incomplete.`,
			);
		}
	}

	if (issues.length < 2) {
		warnings.push(
			"Fewer than two issues were available; comparison tasks use an interface-common search/view replacement on the available issue.",
		);
	}
	if (!issues.some((issue) => issue.comments.some((comment) => comment.body))) {
		warnings.push(
			"No readable issue comment body was available; the comment task was replaced.",
		);
	}
	if (!issues.some((issue) => issue.relations.length > 0)) {
		warnings.push(
			"No issue relation was available; the relation task was replaced.",
		);
	}

	let projects: ProjectSnapshot[] = [];
	try {
		const projectsData = await guardedRequester(PROJECTS_QUERY, { first });
		projects = deduplicate(
			projectsFromData(projectsData),
			(project) => project.id,
		).slice(0, first);
		if (
			hasNextPage(projectsData.projects) ||
			nodes(projectsData.projects).length > first
		) {
			warnings.push(
				`Snapshot is bounded to the first ${MAX_SNAPSHOT_LIMIT} projects.`,
			);
		}
	} catch (error: unknown) {
		if (error instanceof GraphqlSafetyError) {
			throw error;
		}
		warnings.push(
			"Project query was unavailable; the project task was replaced.",
		);
	}
	if (
		projects.length === 0 &&
		!warnings.some((warning) => warning.includes("project task"))
	) {
		warnings.push(
			"No readable project was available; the project task was replaced.",
		);
	}

	return {
		version: 1,
		generatedAt: (options.now ?? (() => new Date()))().toISOString(),
		viewer,
		teams,
		issues,
		projects,
		...(searchIssueIdentifier ? { searchIssueIdentifier } : {}),
		confirmedAbsentIssueIdentifier,
		warnings: [...new Set(warnings)],
	};
}

export function stableJson(value: unknown): string {
	return JSON.stringify(value, null, 2) + "\n";
}

export function snapshotHash(snapshot: LinearSnapshot): string {
	return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

export async function writeSnapshot(
	snapshot: LinearSnapshot,
	filePath: string,
): Promise<string> {
	const serialized = stableJson(snapshot);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, serialized, { mode: 0o600 });
	return createHash("sha256").update(serialized).digest("hex");
}

export function parseSnapshot(value: unknown): LinearSnapshot {
	const snapshot = value as Partial<LinearSnapshot>;
	if (
		!snapshot ||
		snapshot.version !== 1 ||
		typeof snapshot.generatedAt !== "string" ||
		!snapshot.viewer ||
		!Array.isArray(snapshot.teams) ||
		!Array.isArray(snapshot.issues) ||
		!Array.isArray(snapshot.projects) ||
		(snapshot.searchIssueIdentifier !== undefined &&
			typeof snapshot.searchIssueIdentifier !== "string") ||
		typeof snapshot.confirmedAbsentIssueIdentifier !== "string" ||
		snapshot.confirmedAbsentIssueIdentifier.trim().length === 0 ||
		!Array.isArray(snapshot.warnings)
	) {
		throw new Error("snapshot file is invalid or incomplete");
	}
	return snapshot as LinearSnapshot;
}

export function assertSnapshotFresh(
	generatedAt: string,
	maxAgeMinutes: number,
	now = new Date(),
): void {
	if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
		throw new Error("max snapshot age must be a positive number of minutes");
	}
	const generatedTime = Date.parse(generatedAt);
	const nowTime = now.getTime();
	if (!Number.isFinite(generatedTime) || !Number.isFinite(nowTime)) {
		throw new Error("snapshot timestamp is invalid");
	}
	const ageMinutes = Math.max(0, nowTime - generatedTime) / 60_000;
	if (ageMinutes > maxAgeMinutes) {
		throw new Error(
			`snapshot is ${ageMinutes.toFixed(1)} minutes old; maximum allowed age is ${maxAgeMinutes} minutes`,
		);
	}
}
