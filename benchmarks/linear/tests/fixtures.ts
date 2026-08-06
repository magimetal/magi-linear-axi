import type { BenchmarkResult, LinearSnapshot } from "../src/types.js";

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
		taskId: "issue-lookup",
		category: "single_step",
		repeatIndex: 1,
		model: "claude-sonnet-4-6",
		judgeModel: "claude-sonnet-4-6",
		expectedConditions: ["axi"],
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
		inputTokens: 10,
		cacheReadInputTokens: 2,
		cacheCreationInputTokens: 1,
		outputTokens: 20,
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
