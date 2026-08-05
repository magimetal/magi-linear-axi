import { AXI_OUTPUT_MAX_UNICODE_CODE_POINTS, isAxiRepresentable } from "./representability.js";
import type {
	BenchmarkTask,
	IssueSnapshot,
	LinearSnapshot,
	ProjectSnapshot,
	BenchmarkOperationKind,
	RequiredFact,
	RequiredOperation,
	TaskCategory,
	TaskManifest,
} from "./types.js";

export { AXI_OUTPUT_MAX_UNICODE_CODE_POINTS } from "./representability.js";
/** Kept as a descriptive alias for the existing exact-comment contract. */
export const AXI_COMMENT_BODY_MAX_CHARACTERS = AXI_OUTPUT_MAX_UNICODE_CODE_POINTS;

function normalizedExactValue(value: string): string {
	return value.trim();
}

function requiredExactValue(label: string, value: string): string {
	const normalized = normalizedExactValue(value);
	if (!normalized || !isAxiRepresentable(normalized)) {
		throw new Error(
			`cannot generate tasks: required ${label} is not representable in AXI's default output (maximum ${AXI_OUTPUT_MAX_UNICODE_CODE_POINTS} Unicode code points)`,
		);
	}
	return normalized;
}

function optionalExactValue(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = normalizedExactValue(value);
	return normalized && isAxiRepresentable(normalized) ? normalized : undefined;
}

function isRepresentableCommentBody(
	body: string | undefined,
): body is string {
	return body !== undefined && body.trim().length > 0 &&
		isAxiRepresentable(body);
}

function isRepresentableIssue(issue: IssueSnapshot): boolean {
	return Boolean(
		optionalExactValue(issue.identifier) && optionalExactValue(issue.title),
	);
}

function isRepresentableProject(project: ProjectSnapshot): boolean {
	return Boolean(
		optionalExactValue(project.id) && optionalExactValue(project.name),
	);
}

function representableRelation(
	issue: IssueSnapshot,
): IssueSnapshot["relations"][number] | undefined {
	if (!isRepresentableIssue(issue)) return undefined;
	return issue.relations.find((relation) =>
		Boolean(
			optionalExactValue(relation.type) &&
			optionalExactValue(relation.relatedIdentifier),
		),
	);
}

function optionalContains(
	label: string,
	value: string | undefined,
): RequiredFact | undefined {
	const normalized = optionalExactValue(value);
	return normalized ? { label, kind: "contains", value: normalized } : undefined;
}

function contains(label: string, value: string): RequiredFact {
	return {
		label,
		kind: "contains",
		value: requiredExactValue(label, value),
	};
}

function notFound(label: string, attemptedIdentifier?: string): RequiredFact {
	return {
		label,
		kind: "not_found",
		...(attemptedIdentifier
			? { value: normalizedExactValue(attemptedIdentifier) }
			: {}),
	};
}

function issueStateFacts(
	issue: IssueSnapshot,
	includeUrl = false,
	source: BenchmarkOperationKind = "issue_view",
): RequiredFact[] {
	const facts: RequiredFact[] = [
		{ ...contains("issue identifier", issue.identifier), source },
		{ ...contains("issue title", issue.title), source },
	];
	const stateFact = optionalContains("workflow state", issue.stateName);
	if (stateFact) {
		facts.push({ ...stateFact, source });
	}
	const urlFact = includeUrl ? optionalContains("issue URL", issue.url) : undefined;
	if (urlFact) {
		facts.push({ ...urlFact, source });
	}
	return facts;
}

function issueResultValues(issue: IssueSnapshot, includeUrl = false): string[] {
	const values = [
		requiredExactValue("issue identifier", issue.identifier),
		requiredExactValue("issue title", issue.title),
	];
	const state = optionalExactValue(issue.stateName);
	if (state) values.push(state);
	if (includeUrl) {
		const url = optionalExactValue(issue.url);
		if (url) values.push(url);
	}
	return values;
}

function issueSearchOperation(issue: IssueSnapshot): RequiredOperation {
	const identifier = requiredExactValue("issue identifier", issue.identifier);
	const title = requiredExactValue("issue title", issue.title);
	return {
		kind: "issue_search",
		operand: title,
		requiredResultValues: [identifier, title],
	};
}

function issueViewOperation(
	issue: IssueSnapshot,
	resultValues = issueResultValues(issue),
): RequiredOperation {
	return {
		kind: "issue_view",
		operand: requiredExactValue("issue identifier", issue.identifier),
		requiredResultValues: resultValues.map((value) =>
			requiredExactValue("issue result value", value),
		),
	};
}

function defaultMinimumToolCalls(category: TaskCategory): number {
	return category === "multi_step" ? 2 : 1;
}

function task(
	id: string,
	category: TaskCategory,
	title: string,
	prompt: string,
	requiredFacts: RequiredFact[],
	gradingHints: string[],
	minimumToolCalls = defaultMinimumToolCalls(category),
	requiredOperations: RequiredOperation[] = [],
): BenchmarkTask {
	for (const fact of requiredFacts) {
		if (fact.value !== undefined && !isAxiRepresentable(fact.value)) {
			throw new Error(
				`cannot generate task ${id}: required fact ${fact.label} exceeds AXI's default output limit of ${AXI_OUTPUT_MAX_UNICODE_CODE_POINTS} Unicode code points`,
			);
		}
	}
	for (const operation of requiredOperations) {
		if (operation.operand !== undefined && !isAxiRepresentable(operation.operand)) {
			throw new Error(
				`cannot generate task ${id}: required operation operand exceeds AXI's default output limit of ${AXI_OUTPUT_MAX_UNICODE_CODE_POINTS} Unicode code points`,
			);
		}
		if (operation.requiredResultValues?.some((value) => !isAxiRepresentable(value))) {
			throw new Error(
				`cannot generate task ${id}: required operation evidence exceeds AXI's default output limit of ${AXI_OUTPUT_MAX_UNICODE_CODE_POINTS} Unicode code points`,
			);
		}
	}
	return {
		id,
		category,
		title,
		prompt,
		minimumToolCalls,
		requiredOperations,
		requiredFacts,
		gradingHints,
	};
}

function confirmedAbsentIdentifier(snapshot: LinearSnapshot): string {
	const rawIdentifier = snapshot.confirmedAbsentIssueIdentifier;
	if (typeof rawIdentifier !== "string") {
		throw new Error(
			"cannot generate tasks: snapshot is missing confirmedAbsentIssueIdentifier",
		);
	}
	const identifier = normalizedExactValue(rawIdentifier);
	if (!identifier) {
		throw new Error(
			"cannot generate tasks: snapshot is missing confirmedAbsentIssueIdentifier",
		);
	}
	if (!isAxiRepresentable(identifier)) {
		throw new Error(
			`cannot generate tasks: confirmedAbsentIssueIdentifier exceeds AXI's default output limit of ${AXI_OUTPUT_MAX_UNICODE_CODE_POINTS} Unicode code points`,
		);
	}
	const normalized = identifier.toUpperCase();
	if (
		snapshot.issues.some(
			(issue) => normalizedExactValue(issue.identifier).toUpperCase() === normalized,
		)
	) {
		throw new Error(
			`cannot generate tasks: confirmedAbsentIssueIdentifier ${identifier} collides with a locally captured issue`,
		);
	}
	return identifier;
}

function commentTask(issue: IssueSnapshot): BenchmarkTask | undefined {
	const comment = issue.comments.find((candidate) =>
		isRepresentableCommentBody(candidate.body) &&
		Boolean(optionalExactValue(candidate.id)),
	);
	if (!comment?.body) {
		return undefined;
	}
	const facts = [
		contains("selected comment ID", comment.id),
		contains("selected comment body", comment.body),
	];
	return task(
		"issue-comments",
		"investigation",
		"Read one issue comment",
		`Read the comments for the existing issue identifier <${issue.identifier}>. Find comment <${comment.id}> and report only that exact comment ID and body. Do not infer comments that the tool did not return.`,
		facts,
		[
			"Use a comment-list/read operation.",
			"The issue identifier is call input only; grade the selected comment ID and body, not an unbounded claim about every comment.",
		],
	);
}

function projectTask(project: ProjectSnapshot): BenchmarkTask | undefined {
	if (!isRepresentableProject(project)) return undefined;
	const facts: RequiredFact[] = [contains("project name", project.name)];
	const urlFact = optionalContains("project URL", project.url);
	const statusFact = optionalContains("project status", project.statusName);
	if (urlFact) facts.push(urlFact);
	if (statusFact) facts.push(statusFact);
	const reportFields = [
		"exact name",
		...(statusFact ? ["status"] : []),
		...(urlFact ? ["URL"] : []),
	].join(", ");
	return task(
		"project-lookup",
		"investigation",
		"Look up an existing project",
		`Look up the existing project <${project.id}> and report its ${reportFields} when returned. Do not create, update, archive, or delete anything.`,
		facts,
		[
			"Use a project read/view operation.",
			"Do not substitute an issue or a guessed project.",
		],
	);
}

function searchViewReplacement(
	id: string,
	title: string,
	issue: IssueSnapshot,
): BenchmarkTask {
	return task(
		id,
		"multi_step",
		title,
		`First search existing issues using the exact full title <${issue.title}>. Then, as a separate later read, directly retrieve the human issue identifier returned by that search. Report the returned issue identifier, exact title, workflow state, and URL when available. Do not make changes or claim fields that were not returned.`,
		issueStateFacts(issue, true, "issue_view"),
		[
			"Use exactly two separate read operations: an exact-title issue search followed later by a direct issue retrieval.",
			"Pass the exact full issue title as one search value, including when it begins with a dash.",
			"Grade the identifier, title, state, and URL only when returned by the direct retrieval result.",
		],
		2,
		[issueSearchOperation(issue), issueViewOperation(issue, issueResultValues(issue, true))],
	);
}

function compareTask(
	first: IssueSnapshot,
	second: IssueSnapshot,
): BenchmarkTask {
	const facts: RequiredFact[] = [
		{ ...contains("first issue identifier", first.identifier), source: "issue_view" },
		{ ...contains("first issue title", first.title), source: "issue_view" },
		{ ...contains("second issue identifier", second.identifier), source: "issue_view" },
		{ ...contains("second issue title", second.title), source: "issue_view" },
	];
	const firstState = optionalContains("first workflow state", first.stateName);
	if (firstState) facts.push({ ...firstState, source: "issue_view" });
	const secondState = optionalContains("second workflow state", second.stateName);
	if (secondState) facts.push({ ...secondState, source: "issue_view" });
	return task(
		"compare-issues",
		"multi_step",
		"Compare two existing issues",
		`Inspect the two existing issue identifiers <${first.identifier}> and <${second.identifier}>. Report each returned identifier, exact title, and workflow state, and clearly distinguish the two records. Use separate read-only lookups if needed; do not modify either issue.`,
		facts,
		[
			"Report facts for both identifiers, not only one.",
			"Keep the comparison tied to tool output.",
		],
		2,
		[issueViewOperation(first), issueViewOperation(second)],
	);
}

function relationTask(issue: IssueSnapshot): BenchmarkTask | undefined {
	const relation = representableRelation(issue);
	if (!relation) return undefined;
	const relatedTitle = optionalExactValue(relation.relatedTitle);
	return task(
		"relation-traversal",
		"investigation",
		"Read an issue relation",
		`Read the relations returned for the existing issue identifier <${issue.identifier}>. Report the base issue identifier, relation type, related issue identifier${relatedTitle ? ", and related issue title when returned" : ""}. Do not assume a second related-issue lookup is available; use only facts returned by the relation read. Read-only access only.`,
		[
			contains("base issue identifier", issue.identifier),
			contains("relation type", relation.type),
			contains("related issue identifier", relation.relatedIdentifier),
			...(relatedTitle
				? [contains("related issue title", relatedTitle)]
				: []),
		],
		[
			"Use the issue relation list/read operation and report its returned base, type, and related issue facts.",
			"Do not invent a relation or related title when none is returned.",
		],
		1,
	);
}

function singleIssueReplacement(issue: IssueSnapshot): BenchmarkTask {
	return task(
		"issue-fields",
		"single_step",
		"Read exact issue fields",
		`Read the existing issue identifier <${issue.identifier}> and report its exact identifier, title, and workflow state. Do not make changes or claim fields that were not returned.`,
		issueStateFacts(issue),
		[
			"Use one direct issue retrieval.",
			"Do not guess from the identifier.",
		],
		1,
		[issueViewOperation(issue)],
	);
}

function primaryIssueIndex(
	issues: IssueSnapshot[],
	searchIssueIdentifier: string | undefined,
): number {
	if (!searchIssueIdentifier) {
		throw new Error(
			"cannot generate tasks: snapshot is missing the bounded searchIssueIdentifier ground truth",
		);
	}
	const index = issues.findIndex(
		(issue) => issue.identifier === searchIssueIdentifier,
	);
	if (index < 0) {
		throw new Error(
			`cannot generate tasks: snapshot searchIssueIdentifier ${searchIssueIdentifier} is stale or missing from the issue list`,
		);
	}
	const primary = issues[index];
	if (!primary || !isRepresentableIssue(primary)) {
		throw new Error(
			`cannot generate tasks: snapshot searchIssueIdentifier ${searchIssueIdentifier} has an identifier or title that is not representable in AXI's default output`,
		);
	}
	if (issues.filter((issue) => issue.title === primary.title).length !== 1) {
		throw new Error(
			`cannot generate tasks: snapshot searchIssueIdentifier ${searchIssueIdentifier} does not identify a locally unique search title`,
		);
	}
	return index;
}

export function generateTasks(snapshot: LinearSnapshot): TaskManifest {
	// Preserve snapshot order so primary tasks use records from the bounded detail window.
	const issues = [...snapshot.issues];
	const primaryIndex = primaryIssueIndex(issues, snapshot.searchIssueIdentifier);
	const primary = issues[primaryIndex];
	const invalidIdentifier = confirmedAbsentIdentifier(snapshot);
	if (!primary) {
		throw new Error("cannot generate tasks without at least one representable issue");
	}
	// Keep the first other representable record in snapshot order for deterministic comparison.
	const secondary = issues.find(
		(_issue, index) => index !== primaryIndex && isRepresentableIssue(_issue),
	);

	const warnings = [...snapshot.warnings];
	const tasks: BenchmarkTask[] = [];
	tasks.push(
		task(
			"issue-lookup",
			"single_step",
			"Exact issue lookup",
			`Read the existing issue identifier <${primary.identifier}> and report its exact identifier, title, workflow state, and URL when returned. Use read-only access only.`,
			issueStateFacts(primary, true),
			[
				"Use a direct issue retrieval.",
				"The URL is graded when the snapshot made it available.",
				"The answer must be grounded in a tool response.",
			],
			1,
			[issueViewOperation(primary, issueResultValues(primary, true))],
		),
	);
	tasks.push(
		task(
			"issue-search",
			"single_step",
			"Search and retrieve an issue",
			`Search existing issues using the exact full title phrase <${primary.title}>. Do not use the issue identifier as the search term. Report the matching issue identifier and exact title from the search result. Read-only access only.`,
			[
				{ ...contains("searched issue identifier", primary.identifier), source: "issue_search" as const },
				{ ...contains("searched issue title", primary.title), source: "issue_search" as const },
			],
			[
				"Use an exact-title issue-search operation.",
				"Search with the exact full title phrase as one value, not an inferred one-word term.",
				"Do not claim a match without using a tool.",
			],
			1,
			[issueSearchOperation(primary)],
		),
	);
	tasks.push(singleIssueReplacement(primary));

	const commentSource = issues.find((issue) =>
		isRepresentableIssue(issue) && Boolean(commentTask(issue)),
	);
	const comments = commentSource ? commentTask(commentSource) : undefined;
	if (comments) {
		tasks.push(comments);
	} else {
		warnings.push(
			`Generated issue-URL replacement because no comment body was representable: a selected body must be nonempty and at most ${AXI_COMMENT_BODY_MAX_CHARACTERS} Unicode characters.`,
		);
		tasks.push(
			task(
				"issue-url",
				"single_step",
				"Retrieve an issue URL",
				`Read the existing issue identifier <${primary.identifier}> and report its exact identifier${optionalExactValue(primary.url) ? " and URL" : ""}. Do not make changes.`,
				[
					{ ...contains("issue identifier", primary.identifier), source: "issue_view" as const },
					...(optionalContains("issue URL", primary.url)
						? [{ ...optionalContains("issue URL", primary.url)!, source: "issue_view" as const }]
						: []),
				],
				[
					"Use a direct issue retrieval.",
					"If the API omits a URL, say so rather than guessing.",
				],
				1,
				[issueViewOperation(
					primary,
					optionalExactValue(primary.url)
						? [primary.identifier, optionalExactValue(primary.url)!]
						: [primary.identifier],
				)],
			),
		);
	}

	const project = [...snapshot.projects]
		.filter(isRepresentableProject)
		.sort((left, right) => left.id.localeCompare(right.id))[0];
	const projectBenchmarkTask = project ? projectTask(project) : undefined;
	if (projectBenchmarkTask) {
		tasks.push(projectBenchmarkTask);
	} else {
		warnings.push(
			"Generated project-missing search/view replacement because no representable project was available.",
		);
		tasks.push(
			searchViewReplacement(
				"project-missing-search-view",
				"Search and view an issue when no project is available",
				primary,
			),
		);
	}

	if (secondary) {
		tasks.push(compareTask(primary, secondary));
	} else {
		warnings.push(
			"Generated second-issue-missing search/view replacement because only one issue was available.",
		);
		tasks.push(
			searchViewReplacement(
				"second-issue-missing-search-view",
				"Search and view a second-issue replacement",
				primary,
			),
		);
	}

	const relation = issues.find((issue) => Boolean(representableRelation(issue)));
	const relationBenchmarkTask = relation ? relationTask(relation) : undefined;
	if (relationBenchmarkTask) {
		tasks.push(relationBenchmarkTask);
	} else {
		warnings.push(
			"Generated relation-missing search/view replacement because no issue relation was available.",
		);
		tasks.push(
			searchViewReplacement(
				"relation-missing-search-view",
				"Search and view an issue when no relation is available",
				primary,
			),
		);
	}

	tasks.push(
		task(
			"invalid-issue",
			"error_recovery",
			"Handle an invalid issue identifier",
			`Attempt a read-only lookup for the intentionally invalid issue identifier <${invalidIdentifier}>. In the final answer explicitly state that the issue was not found or does not exist, using issue-scoped language, without retrying with a guessed identifier or making changes.`,
			[
				{
					...notFound("invalid issue is explicitly absent", invalidIdentifier),
					source: "issue_view",
				},
			],
			[
				"A clean issue-scoped not-found/error response is expected.",
				"The tool result must contain explicit issue-scoped not-found evidence, even if the error omits the attempted identifier.",
				"Do not treat an empty answer as proof of absence.",
			],
			1,
			[{
				kind: "issue_view",
				operand: invalidIdentifier,
				expectedError: "issue_not_found",
			}],
		),
	);

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		snapshotGeneratedAt: snapshot.generatedAt,
		snapshotHash: "",
		warnings: [...new Set(warnings)],
		tasks,
	};
}

export function attachSnapshotHash(
	manifest: TaskManifest,
	hash: string,
): TaskManifest {
	return { ...manifest, snapshotHash: hash };
}

function isOperationKind(value: unknown): value is BenchmarkOperationKind {
	return value === "issue_search" || value === "issue_view";
}

interface RawRequiredOperation {
	kind?: unknown;
	operand?: unknown;
	requiredResultValues?: unknown;
	expectedError?: unknown;
}

function validOperand(value: unknown): boolean {
	return value === undefined ||
		(typeof value === "string" && value.trim().length > 0 && isAxiRepresentable(value));
}

function validResultValues(value: unknown): boolean {
	return value === undefined ||
		(Array.isArray(value) &&
			value.every(
				(item) =>
					typeof item === "string" &&
					item.trim().length > 0 &&
					isAxiRepresentable(item),
			));
}

function validExpectedError(record: RawRequiredOperation): boolean {
	if (record.expectedError === undefined) return true;
	return record.expectedError === "issue_not_found" &&
		record.kind === "issue_view" &&
		typeof record.operand === "string" &&
		record.requiredResultValues === undefined;
}

function validRequiredOperation(operation: unknown): boolean {
	if (!operation || typeof operation !== "object") return false;
	const record = operation as RawRequiredOperation;
	return isOperationKind(record.kind) &&
		validOperand(record.operand) &&
		validResultValues(record.requiredResultValues) &&
		validExpectedError(record);
}

function validRequiredFact(fact: unknown): boolean {
	if (!fact || typeof fact !== "object") return false;
	const record = fact as { source?: unknown; value?: unknown };
	const valueValid =
		record.value === undefined ||
		(typeof record.value === "string" &&
			record.value.trim().length > 0 &&
			isAxiRepresentable(record.value));
	return valueValid && (record.source === undefined || isOperationKind(record.source));
}

interface RawTaskRecord {
	minimumToolCalls?: unknown;
	requiredOperations?: unknown;
	requiredFacts?: unknown;
}

function invalidTaskRecord(taskValue: unknown): boolean {
	if (!taskValue || typeof taskValue !== "object") return true;
	const taskRecord = taskValue as RawTaskRecord;
	return !Number.isInteger(taskRecord.minimumToolCalls) ||
		(taskRecord.minimumToolCalls as number) < 1 ||
		!Array.isArray(taskRecord.requiredOperations) ||
		taskRecord.requiredOperations.some(
			(operation) => !validRequiredOperation(operation),
		) ||
		!Array.isArray(taskRecord.requiredFacts) ||
		taskRecord.requiredFacts.some((fact) => !validRequiredFact(fact));
}

function validTaskManifest(manifest: Partial<TaskManifest>): boolean {
	return Boolean(manifest) &&
		manifest.version === 1 &&
		typeof manifest.generatedAt === "string" &&
		typeof manifest.snapshotGeneratedAt === "string" &&
		typeof manifest.snapshotHash === "string" &&
		Array.isArray(manifest.warnings) &&
		Array.isArray(manifest.tasks) &&
		!manifest.tasks.some(invalidTaskRecord);
}

export function parseTaskManifest(value: unknown): TaskManifest {
	const manifest = value as Partial<TaskManifest>;
	if (!validTaskManifest(manifest)) {
		throw new Error(
			"task manifest is invalid or incomplete; every task needs a positive minimumToolCalls, typed requiredOperations, and valid fact sources",
		);
	}
	return manifest as TaskManifest;
}
