import type { BenchmarkResult, LinearSnapshot } from "../src/types.js";

export function structuredOutputStream(condition: "axi" | "mcp"): string {
	const readCall = condition === "axi"
		? {
				id: "read-axi",
				name: "Bash",
				input: {
					command: "/tmp/bin/magi-linear-axi issue view ENG-10 --fields compact",
				},
			}
		: {
				id: "read-mcp",
				name: "mcp__linear__get_issue",
				input: { id: "ENG-10" },
			};
	const readResult = condition === "axi"
		? 'issue:\n  identifier: "ENG-10"\n  title: "Improve query latency"'
		: JSON.stringify({ id: "ENG-10", title: "Improve query latency" });
	const structuredId = `structured-${condition}`;
	const structuredResult = "structured-output-ack";
	const terminalAnswer = JSON.stringify({
		identifier: "ENG-10",
		title: "Improve query latency",
	});
	return [
		{
			type: "assistant",
			message: { content: [{ type: "tool_use", ...readCall }] },
		},
		{
			type: "user",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: readCall.id,
					content: [{ type: "text", text: readResult }],
					is_error: false,
				}],
			},
		},
		{
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: structuredId,
					name: "StructuredOutput",
					input: {
						value: terminalAnswer,
						schema: { type: "object" },
					},
				}],
			},
		},
		{
			type: "user",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: structuredId,
					content: [{ type: "text", text: structuredResult }],
					is_error: false,
				}],
			},
		},
		{ type: "result", subtype: "success", result: terminalAnswer },
	].map((event) => JSON.stringify(event)).join("\n");
}

export function invalidCanonicalStructuredOutputStream(
	condition: "axi" | "mcp" = "axi",
): string {
	const readCall = condition === "axi"
		? {
				id: "invalid-read-axi",
				name: "Bash",
				input: { command: "magi-linear-axi issue view ENG-999 --fields compact" },
			}
		: {
				id: "invalid-read-mcp",
				name: "mcp__linear__get_issue",
				input: { id: "ENG-999" },
			};
	const readError = condition === "axi" ? "issue not found" : "entity not found: issue";
	const structuredId = `invalid-schema-${condition}`;
	const structuredResult = "schema accepted";
	const answer = '{"error":"issue ENG-999 not found"}';
	return [
		{
			type: "assistant",
			message: { content: [{ type: "tool_use", ...readCall }] },
		},
		{
			type: "user",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: readCall.id,
					content: [{ type: "text", text: readError }],
					is_error: true,
				}],
			},
		},
		{
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: structuredId,
					name: "StructuredOutput",
					input: {
						schema: {
							type: "object",
							properties: { error: { type: "string" } },
						},
						value: { error: answer },
					},
				}],
			},
		},
		{
			type: "user",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: structuredId,
					content: [{ type: "text", text: structuredResult }],
					is_error: false,
				}],
			},
		},
		{ type: "result", subtype: "success", result: answer },
	].map((event) => JSON.stringify(event)).join("\n");
}

export function richSnapshot(): LinearSnapshot {
	return {
		version: 1,
		generatedAt: "2026-08-05T12:00:00.000Z",
		viewer: { id: "user-1" },
		teams: [
			{ id: "team-1", key: "ENG", name: "Engineering" },
			{ id: "team-2", key: "OPS", name: "Operations" },
		],
		issues: [
			{
				id: "issue-1",
				identifier: "ENG-10",
				title: "Improve query latency",
				url: "https://linear.app/acme/issue/ENG-10",
				stateName: "In Progress",
				team: { id: "team-1", key: "ENG", name: "Engineering" },
				comments: [{ id: "comment-1", body: "Profiling is complete." }],
				relations: [
					{
						type: "blocks",
						relatedIdentifier: "ENG-11",
						relatedTitle: "Tune cache behavior",
					},
				],
			},
			{
				id: "issue-2",
				identifier: "ENG-11",
				title: "Tune cache behavior",
				url: "https://linear.app/acme/issue/ENG-11",
				stateName: "Todo",
				team: { id: "team-1", key: "ENG", name: "Engineering" },
				comments: [],
				relations: [],
			},
		],
		projects: [
			{
				id: "project-1",
				name: "Performance",
				url: "https://linear.app/acme/project/performance",
				statusName: "Planned",
			},
		],
		searchIssueIdentifier: "ENG-10",
		confirmedAbsentIssueIdentifier: "ENG-999999999",
		warnings: [],
	};
}

export function sparseSnapshot(): LinearSnapshot {
	return {
		version: 1,
		generatedAt: "2026-08-05T12:00:00.000Z",
		viewer: { id: "user-1" },
		teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
		issues: [
			{
				id: "issue-1",
				identifier: "ENG-10",
				title: "Small fix",
				url: "https://linear.app/acme/issue/ENG-10",
				team: { id: "team-1", key: "ENG", name: "Engineering" },
				stateName: "Todo",
				comments: [],
				relations: [],
			},
		],
		projects: [],
		searchIssueIdentifier: "ENG-10",
		confirmedAbsentIssueIdentifier: "ENG-999999999",
		warnings: [],
	};
}

function commentSnapshot(body: string, commentId: string): LinearSnapshot {
	const snapshot = richSnapshot();
	return {
		...snapshot,
		issues: snapshot.issues.map((issue, index) =>
			index === 0
				? { ...issue, comments: [{ id: commentId, body }] }
				: { ...issue, comments: [] },
		),
	};
}

export function oversizedCommentSnapshot(): LinearSnapshot {
	return commentSnapshot("🙂".repeat(241), "long-comment");
}

export function exactLimitCommentSnapshot(): LinearSnapshot {
	return commentSnapshot("🙂".repeat(240), "limit-comment");
}

export function duplicateTitleSnapshot(): LinearSnapshot {
	const snapshot = richSnapshot();
	return {
		...snapshot,
		searchIssueIdentifier: "ENG-12",
		issues: [
			{ ...snapshot.issues[0], title: "Repeated title" },
			{ ...snapshot.issues[1], title: "Repeated title" },
			{
				...snapshot.issues[0],
				id: "issue-3",
				identifier: "ENG-12",
				title: "Unique search candidate",
				url: "https://linear.app/acme/issue/ENG-12",
				comments: [],
				relations: [],
			},
		],
	};
}

export function allDuplicateTitleSnapshot(): LinearSnapshot {
	const snapshot = richSnapshot();
	return {
		...snapshot,
		issues: snapshot.issues.map((issue) => ({
			...issue,
			title: "Repeated title",
		})),
	};
}

export function result(
	overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
	return {
		resultId: "result-1",
		matrixRunId: "run-1",
		condition: "axi",
		answerContract: "compact",
		taskId: "issue-lookup",
		category: "single_step",
		repeatIndex: 1,
		model: "claude-sonnet-4-6",
		judgeModel: "claude-sonnet-4-6",
		expectedConditions: ["axi"],
		expectedAnswerContracts: ["compact"],
		expectedTaskIds: ["issue-lookup"],
		expectedRepeatCount: 1,
		judgeEnabled: false,
		timestamp: "2026-08-05T12:00:00.000Z",
		startedAt: "2026-08-05T12:00:00.000Z",
		completedAt: "2026-08-05T12:00:01.000Z",
		wallTimeMs: 1000,
		benchmarkSeed: "seed",
		snapshotTimestamp: "2026-08-05T12:00:00.000Z",
		snapshotHash: "hash",
		taskManifestHash: "task-manifest-hash",
		harnessSourceHash: "source-hash",
		axiBinaryHash: "axi-binary-hash",
		claudeVersion: "claude 1.0.0",
		phaseMetrics: { coverage: [] },
		inputTokens: 10,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 20,
		outputTokensCovered: true,
		terminalAnswerCharacters: 80,
		terminalAnswerBytes: 80,
		reportedCostUsd: 0.01,
		turns: 2,
		toolCalls: 1,
		bashToolCalls: 1,
		mcpToolCalls: 0,
		errorCount: 0,
		expectedErrorCount: 0,
		commandErrorCount: 0,
		apiErrorCount: 0,
		toolErrorCount: 0,
		infrastructureErrorCount: 0,
		linkedToolEvidenceCount: 1,
		safetyViolationCount: 0,
		safetyViolations: [],
		policyIncidentCount: 0,
		policyIncidents: [],
		finalAnswer: "secret dynamic answer",
		deterministicGrade: {
			passed: true,
			score: 1,
			reason: "ok",
			formatPassed: true,
			factChecks: [{ label: "issue title", passed: true, grounded: true }],
			toolUseRequired: true,
			toolUseObserved: true,
			minimumToolCalls: 1,
			observedToolCalls: 1,
			infrastructureFailure: false,
		},
		llmGrade: { status: "skipped", model: "claude-sonnet-4-6" },
		overallPassed: true,
		gradingMode: "deterministic",
		rawPath: "results/raw/result-1.jsonl",
		...overrides,
	};
}
