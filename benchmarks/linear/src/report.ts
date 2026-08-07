import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { COMPONENT_TIMING_METRIC_KEYS, MAX_COMPONENT_EVENT_COUNT, MAX_COMPONENT_TIMING_MS } from "./types.js";
import type {
	AnswerContract,
	BenchmarkResult,
	CohortMetadata,
	Condition,
	ResultFilters,
	TaskCategory,
	ComponentTimingMetricKey,
} from "./types.js";

export interface AggregateRow {
	key: string;
	taskId?: string;
	category?: TaskCategory;
	condition?: Condition;
	answerContract?: AnswerContract;
	runs: number;
	passed: number;
	deterministicPassed: number;
	llmPassed: number;
	llmConsidered: number;
	/** Deterministic/judge agreement among passed or failed judge results only. */
	judgeAgreement: number;
	judgeAgreementConsidered: number;
	judgeAgreementRate: number;
	safetyViolations: number;
	unsafeRuns: number;
	safetyRate: number;
	hardSafetyIncidents: number;
	hardSafetyRuns: number;
	hardSafetyRate: number;
	policyIncidents: number;
	policyIncidentRuns: number;
	policyIncidentRate: number;
	commandErrors: number;
	commandErrorRuns: number;
	commandErrorRate: number;
	apiErrors: number;
	apiErrorRuns: number;
	apiErrorRate: number;
	toolErrors: number;
	toolErrorRuns: number;
	toolErrorRate: number;
	otherToolErrors: number;
	otherToolErrorRuns: number;
	otherToolErrorRate: number;
	infrastructureErrors: number;
	infrastructureErrorRuns: number;
	infrastructureErrorRate: number;
	expectedErrors: number;
	expectedErrorRuns: number;
	expectedErrorRate: number;
	errors: number;
	errorRuns: number;
	errorRate: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	outputTokenCoveredRuns: number;
	terminalAnswerCharacters: number;
	terminalAnswerCharacterCoveredRuns: number;
	terminalAnswerBytes: number;
	terminalAnswerByteCoveredRuns: number;
	reportedCostUsd: number;
	reportedCostSamples: number;
	missingCostCount: number;
	wallTimeMs: number;
	componentTimings: Record<ComponentTimingMetricKey, ComponentTimingAggregate>;
	retries: number;
	retryCoveredRuns: number;
	meanRetries?: number;
	turns: number;
	toolCalls: number;
	meanInputTokens: number;
	meanCacheReadInputTokens: number;
	meanCacheCreationInputTokens: number;
	meanOutputTokens?: number;
	meanTerminalAnswerCharacters?: number;
	meanTerminalAnswerBytes?: number;
	meanReportedCostUsd?: number;
	meanWallTimeMs: number;
	p50WallTimeMs: number;
	p95WallTimeMs: number;
	meanTurns: number;
	meanToolCalls: number;
	p50ToolCalls: number;
	p95ToolCalls: number;
	passRate: number;
}

export interface ComponentTimingAggregate {
	totalMs: number;
	eventCount: number;
	coveredRuns: number;
	meanMs?: number;
}

export type ReportAggregate = Omit<AggregateRow, "key"> & {
	byCondition: AggregateRow[];
	byTask: AggregateRow[];
};

interface Totals {
	runs: number;
	passed: number;
	deterministicPassed: number;
	llmPassed: number;
	llmConsidered: number;
	judgeAgreement: number;
	judgeAgreementConsidered: number;
	safetyViolations: number;
	unsafeRuns: number;
	policyIncidents: number;
	policyIncidentRuns: number;
	commandErrors: number;
	commandErrorRuns: number;
	apiErrors: number;
	apiErrorRuns: number;
	toolErrors: number;
	toolErrorRuns: number;
	infrastructureErrors: number;
	infrastructureErrorRuns: number;
	expectedErrors: number;
	expectedErrorRuns: number;
	errors: number;
	errorRuns: number;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	outputTokenCoveredRuns: number;
	terminalAnswerCharacters: number;
	terminalAnswerCharacterCoveredRuns: number;
	terminalAnswerBytes: number;
	terminalAnswerByteCoveredRuns: number;
	reportedCostUsd: number;
	reportedCostSamples: number;
	missingCostCount: number;
	wallTimeMs: number;
	turns: number;
	toolCalls: number;
	componentTimings: Record<ComponentTimingMetricKey, ComponentTimingAggregate>;
	retries: number;
	retryCoveredRuns: number;
	durations: number[];
	toolCallValues: number[];
}

function numeric(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function newTotals(): Totals {
	return {
		runs: 0,
		passed: 0,
		deterministicPassed: 0,
		llmPassed: 0,
		llmConsidered: 0,
		judgeAgreement: 0,
		judgeAgreementConsidered: 0,
		safetyViolations: 0,
		unsafeRuns: 0,
		policyIncidents: 0,
		policyIncidentRuns: 0,
		commandErrors: 0,
		commandErrorRuns: 0,
		apiErrors: 0,
		apiErrorRuns: 0,
		toolErrors: 0,
		toolErrorRuns: 0,
		infrastructureErrors: 0,
		infrastructureErrorRuns: 0,
		expectedErrors: 0,
		expectedErrorRuns: 0,
		errors: 0,
		errorRuns: 0,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		outputTokenCoveredRuns: 0,
		terminalAnswerCharacters: 0,
		terminalAnswerCharacterCoveredRuns: 0,
		terminalAnswerBytes: 0,
		terminalAnswerByteCoveredRuns: 0,
		reportedCostUsd: 0,
		reportedCostSamples: 0,
		missingCostCount: 0,
		wallTimeMs: 0,
		componentTimings: Object.fromEntries(
			COMPONENT_TIMING_METRIC_KEYS.map((key) => [key, { totalMs: 0, eventCount: 0, coveredRuns: 0 }]),
		) as Record<ComponentTimingMetricKey, ComponentTimingAggregate>,
		retries: 0,
		retryCoveredRuns: 0,
		turns: 0,
		toolCalls: 0,
		durations: [],
		toolCallValues: [],
	};
}

function addResult(totals: Totals, result: BenchmarkResult): void {
	totals.runs += 1;
	totals.passed += result.overallPassed ? 1 : 0;
	totals.deterministicPassed += result.deterministicGrade.passed ? 1 : 0;
	if (result.llmGrade.status !== "skipped") {
		totals.llmConsidered += 1;
		totals.llmPassed += result.llmGrade.status === "passed" ? 1 : 0;
	}
	if (result.llmGrade.status === "passed" || result.llmGrade.status === "failed") {
		totals.judgeAgreementConsidered += 1;
		if (result.deterministicGrade.passed === (result.llmGrade.status === "passed")) {
			totals.judgeAgreement += 1;
		}
	}
	const policyIncidents =
		result.policyIncidentCount ?? result.policyIncidents?.length ?? 0;
	const expectedErrors = result.expectedErrorCount ?? 0;
	const commandErrors = result.commandErrorCount ?? 0;
	const apiErrors = result.apiErrorCount ?? 0;
	const toolErrors = result.toolErrorCount ?? 0;
	const infrastructureErrors = result.infrastructureErrorCount ?? 0;
	const hasErrorCounters =
		result.expectedErrorCount !== undefined ||
		result.commandErrorCount !== undefined ||
		result.apiErrorCount !== undefined ||
		result.toolErrorCount !== undefined ||
		result.infrastructureErrorCount !== undefined;
	const unexpectedErrors = hasErrorCounters
		? commandErrors + apiErrors + toolErrors + infrastructureErrors
		: (result.errorCount ?? 0);
	totals.safetyViolations += numeric(result.safetyViolationCount);
	totals.unsafeRuns += numeric(result.safetyViolationCount) > 0 ? 1 : 0;
	totals.policyIncidents += numeric(policyIncidents);
	totals.policyIncidentRuns += policyIncidents > 0 ? 1 : 0;
	totals.commandErrors += numeric(commandErrors);
	totals.commandErrorRuns += commandErrors > 0 ? 1 : 0;
	totals.apiErrors += numeric(apiErrors);
	totals.apiErrorRuns += apiErrors > 0 ? 1 : 0;
	totals.toolErrors += numeric(toolErrors);
	totals.toolErrorRuns += toolErrors > 0 ? 1 : 0;
	totals.infrastructureErrors += numeric(infrastructureErrors);
	totals.infrastructureErrorRuns += infrastructureErrors > 0 ? 1 : 0;
	totals.expectedErrors += numeric(expectedErrors);
	totals.expectedErrorRuns += expectedErrors > 0 ? 1 : 0;
	totals.errors += numeric(unexpectedErrors);
	totals.errorRuns += unexpectedErrors > 0 ? 1 : 0;
	totals.inputTokens += numeric(result.inputTokens);
	totals.cacheReadInputTokens += numeric(result.cacheReadInputTokens);
	totals.cacheCreationInputTokens += numeric(result.cacheCreationInputTokens);
	if (result.outputTokensCovered) {
		totals.outputTokens += numeric(result.outputTokens);
		totals.outputTokenCoveredRuns += 1;
	}
	if (result.terminalAnswerCharacters !== undefined && Number.isFinite(result.terminalAnswerCharacters)) {
		totals.terminalAnswerCharacters += result.terminalAnswerCharacters;
		totals.terminalAnswerCharacterCoveredRuns += 1;
	}
	if (result.terminalAnswerBytes !== undefined && Number.isFinite(result.terminalAnswerBytes)) {
		totals.terminalAnswerBytes += result.terminalAnswerBytes;
		totals.terminalAnswerByteCoveredRuns += 1;
	}
	if (result.reportedCostUsd !== undefined && Number.isFinite(result.reportedCostUsd)) {
		totals.reportedCostUsd += result.reportedCostUsd;
		totals.reportedCostSamples += 1;
	} else {
		totals.missingCostCount += 1;
	}
	totals.wallTimeMs += numeric(result.wallTimeMs);
	for (const key of COMPONENT_TIMING_METRIC_KEYS) {
		const metric = result.componentTiming?.[key];
		if (metric && Number.isFinite(metric.totalMs) && metric.totalMs >= 0 && metric.totalMs <= MAX_COMPONENT_TIMING_MS && Number.isInteger(metric.count) && metric.count > 0 && metric.count <= MAX_COMPONENT_EVENT_COUNT) {
			const aggregate = totals.componentTimings[key];
			aggregate.totalMs += metric.totalMs;
			aggregate.eventCount += metric.count;
			aggregate.coveredRuns += 1;
		}
	}
	if (result.componentTiming?.coverage.includes("retries") &&
		Number.isInteger(result.componentTiming.retries) &&
		(result.componentTiming.retries ?? -1) >= 0) {
		totals.retries += result.componentTiming.retries ?? 0;
		totals.retryCoveredRuns += 1;
	}
	totals.turns += numeric(result.turns);
	totals.toolCalls += numeric(result.toolCalls);
	totals.durations.push(numeric(result.wallTimeMs));
	totals.toolCallValues.push(numeric(result.toolCalls));
}

function percentile(
	values: readonly number[],
	percentileValue: number,
): number {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((left, right) => left - right);
	const rank = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
	return sorted[rank] ?? 0;
}

function mean(value: number, runs: number): number {
	return runs === 0 ? 0 : value / runs;
}

function rate(affectedRuns: number, runs: number): number {
	return runs === 0 ? 0 : Math.min(1, Math.max(0, affectedRuns / runs));
}

function finishRow(
	key: string,
	totals: Totals,
	metadata?: Pick<AggregateRow, "taskId" | "category" | "condition" | "answerContract">,
): AggregateRow {
	const row: AggregateRow = {
		key, runs: totals.runs, passed: totals.passed,
		deterministicPassed: totals.deterministicPassed, llmPassed: totals.llmPassed,
		llmConsidered: totals.llmConsidered, judgeAgreement: totals.judgeAgreement,
		judgeAgreementConsidered: totals.judgeAgreementConsidered,
		judgeAgreementRate: rate(totals.judgeAgreement, totals.judgeAgreementConsidered),
		safetyViolations: totals.safetyViolations, unsafeRuns: totals.unsafeRuns,
		safetyRate: rate(totals.unsafeRuns, totals.runs), hardSafetyIncidents: totals.safetyViolations,
		hardSafetyRuns: totals.unsafeRuns, hardSafetyRate: rate(totals.unsafeRuns, totals.runs),
		policyIncidents: totals.policyIncidents, policyIncidentRuns: totals.policyIncidentRuns,
		policyIncidentRate: rate(totals.policyIncidentRuns, totals.runs), commandErrors: totals.commandErrors,
		commandErrorRuns: totals.commandErrorRuns, commandErrorRate: rate(totals.commandErrorRuns, totals.runs),
		apiErrors: totals.apiErrors, apiErrorRuns: totals.apiErrorRuns, apiErrorRate: rate(totals.apiErrorRuns, totals.runs),
		toolErrors: totals.toolErrors, toolErrorRuns: totals.toolErrorRuns, toolErrorRate: rate(totals.toolErrorRuns, totals.runs),
		otherToolErrors: totals.toolErrors, otherToolErrorRuns: totals.toolErrorRuns, otherToolErrorRate: rate(totals.toolErrorRuns, totals.runs),
		infrastructureErrors: totals.infrastructureErrors, infrastructureErrorRuns: totals.infrastructureErrorRuns,
		infrastructureErrorRate: rate(totals.infrastructureErrorRuns, totals.runs), expectedErrors: totals.expectedErrors,
		expectedErrorRuns: totals.expectedErrorRuns, expectedErrorRate: rate(totals.expectedErrorRuns, totals.runs),
		errors: totals.errors, errorRuns: totals.errorRuns, errorRate: rate(totals.errorRuns, totals.runs),
		inputTokens: totals.inputTokens, cacheReadInputTokens: totals.cacheReadInputTokens,
		cacheCreationInputTokens: totals.cacheCreationInputTokens, outputTokens: totals.outputTokens,
		outputTokenCoveredRuns: totals.outputTokenCoveredRuns, terminalAnswerCharacters: totals.terminalAnswerCharacters,
		terminalAnswerCharacterCoveredRuns: totals.terminalAnswerCharacterCoveredRuns, terminalAnswerBytes: totals.terminalAnswerBytes,
		terminalAnswerByteCoveredRuns: totals.terminalAnswerByteCoveredRuns, reportedCostUsd: totals.reportedCostUsd,
		reportedCostSamples: totals.reportedCostSamples, missingCostCount: totals.missingCostCount,
		wallTimeMs: totals.wallTimeMs, turns: totals.turns, toolCalls: totals.toolCalls,
		componentTimings: Object.fromEntries(COMPONENT_TIMING_METRIC_KEYS.map((metricKey) => {
			const metric = totals.componentTimings[metricKey];
			return [metricKey, { ...metric, ...(metric.coveredRuns > 0 ? { meanMs: metric.totalMs / metric.coveredRuns } : {}) }];
		})) as Record<ComponentTimingMetricKey, ComponentTimingAggregate>,
		retries: totals.retries, retryCoveredRuns: totals.retryCoveredRuns,
		...(totals.retryCoveredRuns > 0 ? { meanRetries: totals.retries / totals.retryCoveredRuns } : {}),
		meanInputTokens: mean(totals.inputTokens, totals.runs), meanCacheReadInputTokens: mean(totals.cacheReadInputTokens, totals.runs),
		meanCacheCreationInputTokens: mean(totals.cacheCreationInputTokens, totals.runs),
		...(totals.outputTokenCoveredRuns > 0 ? { meanOutputTokens: totals.outputTokens / totals.outputTokenCoveredRuns } : {}),
		...(totals.terminalAnswerCharacterCoveredRuns > 0 ? { meanTerminalAnswerCharacters: totals.terminalAnswerCharacters / totals.terminalAnswerCharacterCoveredRuns } : {}),
		...(totals.terminalAnswerByteCoveredRuns > 0 ? { meanTerminalAnswerBytes: totals.terminalAnswerBytes / totals.terminalAnswerByteCoveredRuns } : {}),
		...(totals.reportedCostSamples > 0 ? { meanReportedCostUsd: totals.reportedCostUsd / totals.reportedCostSamples } : {}),
		meanWallTimeMs: mean(totals.wallTimeMs, totals.runs), p50WallTimeMs: percentile(totals.durations, 0.5),
		p95WallTimeMs: percentile(totals.durations, 0.95), meanTurns: mean(totals.turns, totals.runs), meanToolCalls: mean(totals.toolCalls, totals.runs),
		p50ToolCalls: percentile(totals.toolCallValues, 0.5), p95ToolCalls: percentile(totals.toolCallValues, 0.95), passRate: rate(totals.passed, totals.runs),
	};
	if (metadata?.taskId) row.taskId = metadata.taskId;
	if (metadata?.category) row.category = metadata.category;
	if (metadata?.condition) row.condition = metadata.condition;
	if (metadata?.answerContract) row.answerContract = metadata.answerContract;
	return row;
}

export function filterResults(
	results: readonly BenchmarkResult[],
	filters: ResultFilters = {},
): BenchmarkResult[] {
	return results.filter((result) => {
		if (filters.taskIds && !filters.taskIds.includes(result.taskId)) {
			return false;
		}
		if (filters.categories && !filters.categories.includes(result.category)) {
			return false;
		}
		if (filters.conditions && !filters.conditions.includes(result.condition)) {
			return false;
		}
		if (filters.answerContracts && !filters.answerContracts.includes(result.answerContract)) return false;
		if (filters.matrixRunId && filters.matrixRunId !== result.matrixRunId) return false;
		if (filters.matrixRunIds && !filters.matrixRunIds.includes(result.matrixRunId)) return false;
		return true;
	});
}

export function latestMatrixRunId(
	results: readonly BenchmarkResult[],
): string | undefined {
	const latest = new Map<string, number>();
	for (const result of results) {
		if (!result.matrixRunId) {
			continue;
		}
		const timestamp = Date.parse(result.startedAt || result.timestamp);
		const comparable = Number.isFinite(timestamp) ? timestamp : 0;
		latest.set(
			result.matrixRunId,
			Math.max(
				latest.get(result.matrixRunId) ?? Number.NEGATIVE_INFINITY,
				comparable,
			),
		);
	}
	return [...latest.entries()]
		.sort(
			([leftId, leftTime], [rightId, rightTime]) =>
				rightTime - leftTime || rightId.localeCompare(leftId),
		)
		.map(([runId]) => runId)[0];
}

export interface ValidatedCohort {
	matrixRunId: string;
	results: BenchmarkResult[];
	metadata: CohortMetadata;
}

function normalizedList(values: readonly string[]): string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function cohortMetadata(result: BenchmarkResult, index: number): CohortMetadata {
	const conditions = result.expectedConditions;
	const contracts = result.expectedAnswerContracts;
	const taskIds = result.expectedTaskIds;
	if (
		!Array.isArray(conditions) ||
		conditions.length === 0 ||
		conditions.some((value) => value !== "axi" && value !== "mcp") ||
		new Set(conditions).size !== conditions.length
	) {
		throw new Error(
			`cohort validation failed: result ${index + 1} has invalid expected conditions`,
		);
	}
	if (
		!Array.isArray(contracts) ||
		contracts.length === 0 ||
		contracts.some((value) => value !== "compact" && value !== "canonical") ||
		new Set(contracts).size !== contracts.length
	) {
		throw new Error(
			`cohort validation failed: result ${index + 1} has invalid expected answer contracts`,
		);
	}
	if (
		!Array.isArray(taskIds) ||
		taskIds.length === 0 ||
		taskIds.some((value) => typeof value !== "string" || value.length === 0) ||
		new Set(taskIds).size !== taskIds.length
	) {
		throw new Error(
			`cohort validation failed: result ${index + 1} has invalid expected task IDs`,
		);
	}
	if (
		!Number.isInteger(result.expectedRepeatCount) ||
		result.expectedRepeatCount < 1
	) {
		throw new Error(
			`cohort validation failed: result ${index + 1} has an invalid expected repeat count`,
		);
	}
	if (typeof result.judgeEnabled !== "boolean") {
		throw new Error(
			`cohort validation failed: result ${index + 1} has invalid judge intent`,
		);
	}
	return {
		expectedConditions: normalizedList(conditions) as Condition[],
		expectedAnswerContracts: normalizedList(contracts) as AnswerContract[],
		expectedTaskIds: normalizedList(taskIds),
		expectedRepeatCount: result.expectedRepeatCount,
		judgeEnabled: result.judgeEnabled,
	};
}

function sameMetadata(left: CohortMetadata, right: CohortMetadata): boolean {
	return (
		left.expectedRepeatCount === right.expectedRepeatCount &&
		left.judgeEnabled === right.judgeEnabled &&
		left.expectedConditions.join(",") === right.expectedConditions.join(",") &&
		left.expectedAnswerContracts.join(",") ===
			right.expectedAnswerContracts.join(",") &&
		left.expectedTaskIds.join(",") === right.expectedTaskIds.join(",")
	);
}

function invariantValue(result: BenchmarkResult, label: string): unknown {
	switch (label) {
		case "model":
			return result.model;
		case "benchmark seed":
			return result.benchmarkSeed;
		case "snapshot timestamp":
			return result.snapshotTimestamp;
		case "snapshot hash":
			return result.snapshotHash;
		case "task manifest hash":
			return result.taskManifestHash;
		case "judge model":
			return result.judgeModel;
		case "harness source hash":
			return result.harnessSourceHash;
		case "Claude version":
			return result.claudeVersion;
		case "AXI binary hash":
			return result.axiBinaryHash;
		default:
			return undefined;
	}
}

export function validateCohort(
	results: readonly BenchmarkResult[],
): ValidatedCohort {
	if (results.length === 0) {
		throw new Error("cohort validation failed: no results were supplied");
	}
	const matrixRunIds = new Set(results.map((result) => result.matrixRunId));
	if (matrixRunIds.size !== 1 || !results[0]?.matrixRunId) {
		throw new Error(
			"cohort validation failed: results must contain exactly one non-empty matrixRunId",
		);
	}
	const first = results[0];
	const metadata = cohortMetadata(first, 0);
	const invariantStrings: Array<[string, unknown]> = [
		["model", first.model],
		["benchmark seed", first.benchmarkSeed],
		["snapshot timestamp", first.snapshotTimestamp],
		["snapshot hash", first.snapshotHash],
		["task manifest hash", first.taskManifestHash],
		["judge model", first.judgeModel],
		["harness source hash", first.harnessSourceHash],
		["Claude version", first.claudeVersion],
	];
	if (metadata.expectedConditions.includes("axi") && !first.axiBinaryHash) {
		throw new Error("cohort validation failed: result 1 is missing AXI binary hash");
	}
	if (first.axiBinaryHash !== undefined) {
		invariantStrings.push(["AXI binary hash", first.axiBinaryHash]);
	}
	for (const [label, expected] of invariantStrings) {
		if (typeof expected !== "string" || expected.length === 0) {
			throw new Error(`cohort validation failed: result 1 is missing ${label}`);
		}
	}
	for (const [index, result] of results.entries()) {
		if (!sameMetadata(metadata, cohortMetadata(result, index))) {
			throw new Error(
				`cohort validation failed: result ${index + 1} has mixed expected cohort metadata`,
			);
		}
		if (!metadata.expectedAnswerContracts.includes(result.answerContract)) {
			throw new Error(
				`cohort validation failed: unexpected answer contract '${result.answerContract}' at result ${index + 1}`,
			);
		}
		for (const [label, expected] of invariantStrings) {
			const actual = invariantValue(result, label);
			if (typeof actual !== "string" || actual.length === 0) {
				throw new Error(
					`cohort validation failed: result ${index + 1} is missing ${label}`,
				);
			}
			if (actual !== expected) {
				throw new Error(
					`cohort validation failed: ${label} differs at result ${index + 1}`,
				);
			}
		}
		if ((result.harnessCommit ?? undefined) !== (first.harnessCommit ?? undefined)) {
			throw new Error(
				`cohort validation failed: harness commit differs at result ${index + 1}`,
			);
		}
		if ((result.axiBinaryHash ?? undefined) !== (first.axiBinaryHash ?? undefined)) {
			throw new Error(
				`cohort validation failed: AXI binary hash differs at result ${index + 1}`,
			);
		}
	}
	const expectedCells = new Set<string>();
	for (const condition of metadata.expectedConditions) {
		for (const answerContract of metadata.expectedAnswerContracts) {
			for (const taskId of metadata.expectedTaskIds) {
				for (
					let repeatIndex = 1;
					repeatIndex <= metadata.expectedRepeatCount;
					repeatIndex += 1
				) {
					expectedCells.add(
						`${condition}/${answerContract}/${taskId}/${repeatIndex}`,
					);
				}
			}
		}
	}
	const seenCells = new Set<string>();
	const categories = new Map<string, TaskCategory>();
	for (const [index, result] of results.entries()) {
		if (!metadata.expectedConditions.includes(result.condition)) {
			throw new Error(
				`cohort validation failed: unexpected condition '${result.condition}' at result ${index + 1}`,
			);
		}
		if (!metadata.expectedTaskIds.includes(result.taskId)) {
			throw new Error(
				`cohort validation failed: unexpected task '${result.taskId}' at result ${index + 1}`,
			);
		}
		if (
			!Number.isInteger(result.repeatIndex) ||
			result.repeatIndex < 1 ||
			result.repeatIndex > metadata.expectedRepeatCount
		) {
			throw new Error(
				`cohort validation failed: unexpected repeat index ${result.repeatIndex} at result ${index + 1}`,
			);
		}
		const cell = `${result.condition}/${result.answerContract}/${result.taskId}/${result.repeatIndex}`;
		if (seenCells.has(cell)) {
			throw new Error(
				`cohort validation failed: duplicate condition/contract/task/repeat cell ${cell}`,
			);
		}
		seenCells.add(cell);
		const previousCategory = categories.get(result.taskId);
		if (previousCategory && previousCategory !== result.category) {
			throw new Error(
				`cohort validation failed: task '${result.taskId}' changed category`,
			);
		}
		categories.set(result.taskId, result.category);
	}
	const missingCells = [...expectedCells].filter((cell) => !seenCells.has(cell));
	if (missingCells.length > 0) {
		throw new Error(
			`cohort validation failed: missing expected cell(s): ${missingCells.join(", ")}`,
		);
	}
	return { matrixRunId: first.matrixRunId, results: [...results], metadata };
}

/** Selects and validates a complete latest or explicitly named cohort. */
export function selectCohort(
	results: readonly BenchmarkResult[],
	selectedMatrixRunId?: string,
): ValidatedCohort {
	if (results.length === 0) {
		throw new Error(
			"cohort validation failed: no benchmark results are available",
		);
	}
	const matrixRunId = selectedMatrixRunId ?? latestMatrixRunId(results);
	if (!matrixRunId) {
		throw new Error("cohort validation failed: no matrixRunId is available");
	}
	const selected = filterResults(results, { matrixRunId });
	if (selected.length === 0) {
		throw new Error(
			`cohort validation failed: matrix run '${matrixRunId}' has no results`,
		);
	}
	return validateCohort(selected);
}

export function aggregateResults(results: readonly BenchmarkResult[]): ReportAggregate {
	const totals = newTotals();
	const conditionTotals = new Map<string, { totals: Totals; condition: Condition; answerContract: AnswerContract }>();
	const taskTotals = new Map<string, { totals: Totals; category: TaskCategory; condition: Condition; answerContract: AnswerContract; taskId: string }>();
	for (const result of results) {
		addResult(totals, result);
		const conditionKey = `${result.condition}/${result.answerContract}`;
		const condition = conditionTotals.get(conditionKey) ?? { totals: newTotals(), condition: result.condition, answerContract: result.answerContract };
		addResult(condition.totals, result);
		conditionTotals.set(conditionKey, condition);
		const taskKey = `${conditionKey}/${result.taskId}`;
		const task = taskTotals.get(taskKey) ?? { totals: newTotals(), category: result.category, condition: result.condition, answerContract: result.answerContract, taskId: result.taskId };
		addResult(task.totals, result);
		taskTotals.set(taskKey, task);
	}
	const byCondition = [...conditionTotals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => finishRow(key, value.totals, { condition: value.condition, answerContract: value.answerContract }));
	const byTask = [...taskTotals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => finishRow(key, value.totals, { taskId: value.taskId, category: value.category, condition: value.condition, answerContract: value.answerContract }));
	const total = finishRow("total", totals);
	const { key: _key, ...summary } = total;
	return { ...summary, byCondition, byTask };
}
export async function readResults(filePath: string): Promise<BenchmarkResult[]> {
	let content: string;
	try { content = await readFile(filePath, "utf8"); } catch (error: unknown) {
		if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	}
	const results: BenchmarkResult[] = [];
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		try { results.push(JSON.parse(line) as BenchmarkResult); }
		catch { throw new Error(`results file contains invalid JSON on line ${index + 1}`); }
	}
	return results;
}

export async function appendResult(
	filePath: string,
	result: BenchmarkResult,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, JSON.stringify(result) + "\n", { mode: 0o600 });
}

function fixed(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function costMean(row: AggregateRow): string {
	return row.meanReportedCostUsd === undefined
		? "n/a"
		: row.meanReportedCostUsd.toFixed(6);
}

function incidentCell(
	count: number,
	affectedRuns: number,
	rateValue: number,
): string {
	return `${count} / ${affectedRuns} (${percent(rateValue)})`;
}

function coveredMean(value: number | undefined, coveredRuns: number, runs: number): string {
	return `${value === undefined ? "n/a" : fixed(value)} (${coveredRuns}/${runs})`;
}

function rowMarkdown(row: AggregateRow): string {
	return `| ${row.key} | ${row.runs} | ${row.passed} | ${percent(row.passRate)} | ${row.deterministicPassed} | ${row.llmPassed}/${row.llmConsidered} | ${row.judgeAgreement}/${row.judgeAgreementConsidered} (${percent(row.judgeAgreementRate)}) | ${incidentCell(row.safetyViolations, row.unsafeRuns, row.safetyRate)} | ${incidentCell(row.policyIncidents, row.policyIncidentRuns, row.policyIncidentRate)} | ${incidentCell(row.commandErrors, row.commandErrorRuns, row.commandErrorRate)} | ${incidentCell(row.apiErrors, row.apiErrorRuns, row.apiErrorRate)} | ${incidentCell(row.otherToolErrors, row.otherToolErrorRuns, row.otherToolErrorRate)} | ${incidentCell(row.infrastructureErrors, row.infrastructureErrorRuns, row.infrastructureErrorRate)} | ${incidentCell(row.expectedErrors, row.expectedErrorRuns, row.expectedErrorRate)} | ${incidentCell(row.errors, row.errorRuns, row.errorRate)} | ${fixed(row.meanInputTokens)} | ${fixed(row.meanCacheReadInputTokens)} | ${fixed(row.meanCacheCreationInputTokens)} | ${coveredMean(row.meanOutputTokens, row.outputTokenCoveredRuns, row.runs)} | ${coveredMean(row.meanTerminalAnswerCharacters, row.terminalAnswerCharacterCoveredRuns, row.runs)} | ${coveredMean(row.meanTerminalAnswerBytes, row.terminalAnswerByteCoveredRuns, row.runs)} | ${costMean(row)} (${row.reportedCostSamples}/${row.runs}) | ${fixed(row.meanWallTimeMs)} | ${fixed(row.p50WallTimeMs)}/${fixed(row.p95WallTimeMs)} | ${fixed(row.meanTurns)} | ${fixed(row.meanToolCalls)} | ${fixed(row.p50ToolCalls)}/${fixed(row.p95ToolCalls)} |`;
}

function componentMarkdownRows(rows: readonly AggregateRow[]): string[] {
	return rows.flatMap((row) => [
		...COMPONENT_TIMING_METRIC_KEYS.map((key) => {
			const metric = row.componentTimings[key];
			return `| ${row.key} | ${key} | ${fixed(metric.totalMs)} | ${metric.meanMs === undefined ? "n/a" : fixed(metric.meanMs)} | ${metric.coveredRuns}/${row.runs} | ${metric.eventCount} |`;
		}),
		`| ${row.key} | retries | ${row.retries} | ${row.meanRetries === undefined ? "n/a" : fixed(row.meanRetries)} | ${row.retryCoveredRuns}/${row.runs} | n/a |`,
	]);
}

export interface ReportMetadata {
	claudeVersions: string[];
	matrixRunIds: string[];
	benchmarkSeeds: string[];
	snapshotTimestamps: string[];
	snapshotHashes: string[];
	taskManifestHashes: string[];
	harnessCommits: string[];
	harnessSourceHashes: string[];
	axiBinaryHashes: string[];
	models: string[];
	gradingModes: string[];
	answerContracts: string[];
}
export function metadataFromResults(
	results: readonly BenchmarkResult[],
): ReportMetadata {
	const unique = (values: readonly unknown[]): string[] =>
		[
			...new Set(
				values.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				),
			),
		].sort((left, right) => left.localeCompare(right));
	return {
		matrixRunIds: unique(results.map((result) => result.matrixRunId)),
		benchmarkSeeds: unique(results.map((result) => result.benchmarkSeed)),
		snapshotTimestamps: unique(
			results.map((result) => result.snapshotTimestamp),
		),
		snapshotHashes: unique(results.map((result) => result.snapshotHash)),
		taskManifestHashes: unique(
			results.map((result) => result.taskManifestHash),
		),
		harnessCommits: unique(
			results.flatMap((result) =>
				result.harnessCommit ? [result.harnessCommit] : [],
			),
		),
		harnessSourceHashes: unique(
			results.flatMap((result) =>
				result.harnessSourceHash ? [result.harnessSourceHash] : [],
			),
		),
		axiBinaryHashes: unique(
			results.flatMap((result) =>
				result.axiBinaryHash ? [result.axiBinaryHash] : [],
			),
		),
		claudeVersions: unique(
			results.flatMap((result) =>
				result.claudeVersion ? [result.claudeVersion] : [],
			),
		),
		gradingModes: unique(results.map((result) => result.gradingMode)),
		answerContracts: unique(results.map((result) => result.answerContract)),
		models: unique(results.map((result) => result.model)),
	};
}

const markdownHeader =
	"| Run/task | Runs | Passes | Pass rate | Deterministic | LLM | Judge agreement (passed/failed only) | Safety violations / unsafe runs (hard safety rate) | Policy incidents / affected runs (rate) | Command errors / affected runs (rate) | API errors / affected runs (rate) | Other tool errors / affected runs (rate) | Infrastructure errors / affected runs (rate) | Expected errors / affected runs (rate) | Unexpected errors / affected runs (rate) | Mean input tokens | Mean cache-read tokens | Mean cache-creation tokens | Mean output tokens (covered/runs) | Mean terminal chars (covered/runs) | Mean terminal bytes (covered/runs) | Mean reported cost USD (covered/runs) | Mean agent wall time ms | p50/p95 agent wall time ms | Mean turns | Mean tool calls | p50/p95 tool calls |";
export interface CanonicalAdoptionAssessment {
	status: "adopt" | "retain" | "not_evaluable";
	reasons: string[];
	terminalCharacterReduction?: number;
	outputTokenReduction?: number;
}

export function assessCanonicalAdoption(
	results: readonly BenchmarkResult[],
): CanonicalAdoptionAssessment {
	const axiResults = results.filter((result) => result.condition === "axi");
	const first = axiResults[0];
	if (!first) {
		return {
			status: "not_evaluable",
			reasons: ["cohort has no AXI results"],
		};
	}

	if (
		!Array.isArray(first.expectedConditions) ||
		!Array.isArray(first.expectedAnswerContracts) ||
		!Array.isArray(first.expectedTaskIds) ||
		!first.expectedConditions.includes("axi") ||
		!first.expectedAnswerContracts.includes("compact") ||
		!first.expectedAnswerContracts.includes("canonical")
	) {
		return {
			status: "not_evaluable",
			reasons: ["cohort does not declare both answer contracts and AXI"],
		};
	}
	const expectedQualityKeys = first.expectedConditions.flatMap((condition) =>
		first.expectedTaskIds.flatMap((taskId) =>
			Array.from(
				{ length: first.expectedRepeatCount },
				(_, index) =>
					["compact", "canonical"].map(
						(contract) =>
							`${condition}/${contract}/${taskId}/${index + 1}`,
					),
			).flat(),
		),
	);
	const qualityByKey = new Map<string, BenchmarkResult>();
	let duplicateQualityCell = false;
	for (const result of results) {
		const key = `${result.condition}/${result.answerContract}/${result.taskId}/${result.repeatIndex}`;
		if (qualityByKey.has(key)) duplicateQualityCell = true;
		qualityByKey.set(key, result);
	}
	if (
		duplicateQualityCell ||
		expectedQualityKeys.length === 0 ||
		qualityByKey.size !== expectedQualityKeys.length ||
		expectedQualityKeys.some((key) => !qualityByKey.has(key))
	) {
		return {
			status: "not_evaluable",
			reasons: ["incomplete or duplicate condition/contract/task-repeat cells"],
		};
	}
	const qualityRows = expectedQualityKeys.map((key) => qualityByKey.get(key)!);
	const compactQualityRows = qualityRows.filter(
		(row) => row.answerContract === "compact",
	);
	const canonicalQualityRows = qualityRows.filter(
		(row) => row.answerContract === "canonical",
	);

	const expectedKeys = first.expectedTaskIds.flatMap((taskId) =>
		Array.from(
			{ length: first.expectedRepeatCount },
			(_, index) => `${taskId}/${index + 1}`,
		),
	);
	const pairs = new Map<
		string,
		{ compact?: BenchmarkResult; canonical?: BenchmarkResult }
	>();
	let duplicatePairCell = false;
	for (const result of axiResults) {
		const key = `${result.taskId}/${result.repeatIndex}`;
		const pair = pairs.get(key) ?? {};
		if (pair[result.answerContract]) {
			duplicatePairCell = true;
		}
		pair[result.answerContract] = result;
		pairs.set(key, pair);
	}
	const expectedPairs = expectedKeys.map((key) => pairs.get(key));
	if (
		duplicatePairCell ||
		expectedKeys.length === 0 ||
		pairs.size !== expectedKeys.length ||
		expectedPairs.some((pair) => !pair?.compact || !pair.canonical)
	) {
		return {
			status: "not_evaluable",
			reasons: ["incomplete or duplicate AXI compact/canonical task-repeat pairs"],
		};
	}

	const compactRows = expectedPairs.map((pair) => pair!.compact!);
	const canonicalRows = expectedPairs.map((pair) => pair!.canonical!);
	const axiPairRows = [...compactRows, ...canonicalRows];
	if (
		qualityRows.some(
			(row) =>
				row.llmGrade.status !== "passed" && row.llmGrade.status !== "failed",
		)
	) {
		return {
			status: "not_evaluable",
			reasons: ["incomplete judge coverage"],
		};
	}

	const charactersCovered = axiPairRows.every(
		(row) =>
			row.terminalAnswerCharacters !== undefined &&
			Number.isFinite(row.terminalAnswerCharacters),
	);
	const tokensCovered = axiPairRows.every(
		(row) => row.outputTokensCovered && Number.isFinite(row.outputTokens),
	);
	if (!charactersCovered && !tokensCovered) {
		return {
			status: "not_evaluable",
			reasons: ["neither terminal-character nor provider output-token coverage is complete"],
		};
	}

	const sum = (
		items: readonly BenchmarkResult[],
		selector: (row: BenchmarkResult) => number,
	): number => items.reduce((total, row) => total + selector(row), 0);
	const reduction = (baseline: number, candidate: number): number =>
		baseline === 0 ? 0 : (baseline - candidate) / baseline;
	const terminalCharacterReduction = charactersCovered
		? reduction(
				sum(compactRows, (row) => row.terminalAnswerCharacters!),
				sum(canonicalRows, (row) => row.terminalAnswerCharacters!),
			)
		: undefined;
	const outputTokenReduction = tokensCovered
		? reduction(
				sum(compactRows, (row) => row.outputTokens),
				sum(canonicalRows, (row) => row.outputTokens),
			)
		: undefined;
	const sizeTargetPassed =
		(terminalCharacterReduction ?? Number.NEGATIVE_INFINITY) >= 0.15 ||
		(outputTokenReduction ?? Number.NEGATIVE_INFINITY) >= 0.15;
	if (!sizeTargetPassed && (!charactersCovered || !tokensCovered)) {
		return {
			status: "not_evaluable",
			reasons: ["available size metric missed 15%, but alternate size coverage is incomplete"],
			...(terminalCharacterReduction !== undefined
				? { terminalCharacterReduction }
				: {}),
			...(outputTokenReduction !== undefined ? { outputTokenReduction } : {}),
		};
	}

	const reasons: string[] = [];
	const canonicalDeterministic = canonicalQualityRows.every(
		(row) =>
			row.deterministicGrade.passed &&
			row.deterministicGrade.formatPassed &&
			row.deterministicGrade.factChecks.length > 0 &&
			row.deterministicGrade.factChecks.every(
				(fact) => fact.passed && fact.grounded,
			),
	);
	if (!canonicalDeterministic) {
		reasons.push("canonical deterministic grading or grounding is not fully passing");
	}
	const agreement = (items: readonly BenchmarkResult[]): number =>
		items.filter(
			(row) =>
				row.deterministicGrade.passed === (row.llmGrade.status === "passed"),
		).length;
	if (agreement(canonicalQualityRows) < agreement(compactQualityRows)) {
		reasons.push("canonical judge agreement is lower");
	}
	if (!sizeTargetPassed) {
		reasons.push("neither covered size metric is reduced by at least 15%");
	}
	if (
		sum(canonicalRows, (row) => row.turns) >
		sum(compactRows, (row) => row.turns)
	) {
		reasons.push("canonical turns increased");
	}
	if (
		sum(canonicalRows, (row) => row.toolCalls) >
		sum(compactRows, (row) => row.toolCalls)
	) {
		reasons.push("canonical tool calls increased");
	}
	const comparisons: Array<[
		string,
		(row: BenchmarkResult) => number,
	]> = [
		["hard safety incidents", (row) => row.safetyViolationCount],
		[
			"policy incidents",
			(row) => row.policyIncidentCount ?? row.policyIncidents?.length ?? 0,
		],
		["command errors", (row) => row.commandErrorCount ?? 0],
		["API errors", (row) => row.apiErrorCount ?? 0],
		["other tool errors", (row) => row.toolErrorCount ?? 0],
		["infrastructure failures", (row) => row.infrastructureErrorCount ?? 0],
	];
	for (const [label, selector] of comparisons) {
		if (sum(canonicalQualityRows, selector) > sum(compactQualityRows, selector)) {
			reasons.push(`${label} increased`);
		}
	}

	return {
		status: reasons.length === 0 ? "adopt" : "retain",
		reasons,
		...(terminalCharacterReduction !== undefined
			? { terminalCharacterReduction }
			: {}),
		...(outputTokenReduction !== undefined ? { outputTokenReduction } : {}),
	};
}

const markdownSeparator =
	"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
const emptyMarkdownRow =
	"| (no results) | 0 | 0 | 0.0% | 0 | 0/0 | 0/0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 | 0 | 0 | n/a (0/0) | n/a (0/0) | n/a (0/0) | n/a (0/0) | 0 | 0/0 | 0 | 0 | 0/0 |";

export function renderMarkdownReport(
	results: readonly BenchmarkResult[],
	aggregate = aggregateResults(results),
	metadata = metadataFromResults(results),
	selectedMatrixRunId?: string,
	adoption = assessCanonicalAdoption(results),
): string {
	const selected =
		selectedMatrixRunId ??
		(metadata.matrixRunIds.length === 1 ? metadata.matrixRunIds[0] : undefined);
	const lines = [
		"# Linear read-only benchmark report",
		"",
		"This report contains bounded aggregate metrics only. Raw agent JSONL and dynamic snapshot facts remain in gitignored benchmark artifacts.",
		"",
		`- Selected matrix run ID: ${selected ?? "none"}`,
		`- Runs: ${aggregate.runs}`,
		`- Overall passes: ${aggregate.passed}/${aggregate.runs} (${percent(aggregate.runs === 0 ? 0 : aggregate.passed / aggregate.runs)})`,
		`- Deterministic passes: ${aggregate.deterministicPassed}/${aggregate.runs}`,
		`- LLM judge passes: ${aggregate.llmPassed}/${aggregate.llmConsidered} considered`,
		`- Judge agreement (deterministic vs judge, passed/failed judge results only): ${aggregate.judgeAgreement}/${aggregate.judgeAgreementConsidered} (${percent(aggregate.judgeAgreementRate)})`,
		`- Totals (not comparable averages) — input/cache/output tokens: ${aggregate.inputTokens}/${aggregate.cacheReadInputTokens + aggregate.cacheCreationInputTokens}/${aggregate.outputTokens}`,
		`- Totals (not comparable averages) — reported cost (USD): ${aggregate.reportedCostUsd.toFixed(6)} across ${aggregate.reportedCostSamples}/${aggregate.runs} results; missing coverage: ${aggregate.missingCostCount}`,
		`- Totals (not comparable averages) — agent wall time (ms), turns, tool calls: ${aggregate.wallTimeMs.toFixed(0)}/${aggregate.turns}/${aggregate.toolCalls}`,
		`- Retries: ${aggregate.retries} across ${aggregate.retryCoveredRuns}/${aggregate.runs} covered results.`,
		"- Agent wall time preserves benchmark agent/interface execution semantics; judge execution and judge artifact writes are excluded.",
		"- Component intervals overlap and must not be summed as a wall-time decomposition. Missing measurements remain uncovered rather than becoming zero latency.",
		`- Model(s): ${metadata.models.join(", ") || "unknown"}`,
		`- Grading mode(s): ${metadata.gradingModes.join(", ") || "unknown"}`,
		`- Benchmark seed(s): ${metadata.benchmarkSeeds.join(", ") || "unknown"}`,
		`- Snapshot timestamp(s): ${metadata.snapshotTimestamps.join(", ") || "unknown"}`,
		`- Snapshot hash(es): ${metadata.snapshotHashes.join(", ") || "unknown"}`,
		`- Task manifest hash(es): ${metadata.taskManifestHashes.join(", ") || "unknown"}`,
		`- Harness commit(s): ${metadata.harnessCommits.join(", ") || "unknown"}`,
		`- Harness source hash(es): ${metadata.harnessSourceHashes.join(", ") || "unknown"}`,
		`- AXI binary hash(es): ${metadata.axiBinaryHashes.join(", ") || "not applicable"}`,
		`- Claude version(s): ${metadata.claudeVersions.join(", ") || "unknown"}`,
		`- Answer contract(s): ${metadata.answerContracts.join(", ") || "unknown"}`,
		`- Canonical adoption assessment: ${adoption.status} — ${adoption.reasons.join("; ") || "all gates passed"}`,
		`- Terminal character reduction: ${adoption.terminalCharacterReduction === undefined ? "n/a" : percent(adoption.terminalCharacterReduction)}`,
		`- Provider output-token reduction: ${adoption.outputTokenReduction === undefined ? "n/a" : percent(adoption.outputTokenReduction)}`,
		`- Coverage — terminal characters: ${aggregate.terminalAnswerCharacterCoveredRuns}/${aggregate.runs}; terminal bytes: ${aggregate.terminalAnswerByteCoveredRuns}/${aggregate.runs}; output tokens: ${aggregate.outputTokenCoveredRuns}/${aggregate.runs}`,
		"",
		"## Summary by condition (per-run means)",
		"",
		markdownHeader,
		markdownSeparator,
		...aggregate.byCondition.map(rowMarkdown),
		...(aggregate.byCondition.length === 0 ? [emptyMarkdownRow] : []),
		"",
		"## Component timing by condition",
		"",
		"| Condition | Component | Total ms/count | Mean ms per covered run | Covered/runs | Events |",
		"| --- | --- | ---: | ---: | ---: | ---: |",
		...componentMarkdownRows(aggregate.byCondition),
		"",
		"## Per task and condition (per-run means)",
		"",
		markdownHeader,
		markdownSeparator,
		...aggregate.byTask.map(rowMarkdown),
		...(aggregate.byTask.length === 0 ? [emptyMarkdownRow] : []),
		"",
		"## Interpretation",
		"",
		"Rows report per-run means; p50/p95 use the selected run's individual results. Judge agreement compares deterministic pass/fail with passed/failed judge results and excludes skipped/error judge results. Component means divide by covered runs only; retry totals and coverage stay separate from latency. Every incident category is shown as an incident total followed by affected runs; rates are run-level rates capped at 100%. Unexpected errors are command, API, other tool, and infrastructure errors combined; expected errors are reported separately. Totals above are sums and are not comparable averages. Agent wall time excludes the optional judge. Missing provider cost and component timing remain uncovered rather than becoming zero. Policy incidents are audit findings and do not override correctness; hard safety violations do override correctness, as do true infrastructure failures. Deterministic grading requires condition-appropriate tool use, the task minimum call count, every required fact in the final answer, and linked non-error tool-result evidence (with expected not-found tool errors allowed for the not-found task). Reports contain no per-request content.",
		"",
	];
	return lines.join("\n");
}

function snakeCase(value: string): string {
	return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

const csvColumns = [
	"task_id",
	"category",
	"condition",
	"runs",
	"passes",
	"pass_rate",
	"deterministic_passes",
	"llm_passes",
	"llm_considered",
	"judge_agreement",
	"judge_agreement_considered",
	"judge_agreement_rate",
	"safety_violations",
	"unsafe_runs",
	"safety_rate",
	"hard_safety_incidents",
	"hard_safety_runs",
	"hard_safety_rate",
	"policy_incidents",
	"policy_incident_runs",
	"policy_incident_rate",
	"command_errors",
	"command_error_runs",
	"command_error_rate",
	"api_errors",
	"api_error_runs",
	"api_error_rate",
	"other_tool_errors",
	"other_tool_error_runs",
	"other_tool_error_rate",
	"infrastructure_errors",
	"infrastructure_error_runs",
	"infrastructure_error_rate",
	"expected_errors",
	"expected_error_runs",
	"expected_error_rate",
	"errors",
	"error_runs",
	"error_rate",
	"mean_input_tokens",
	"mean_cache_read_input_tokens",
	"mean_cache_creation_input_tokens",
	"mean_output_tokens",
	"mean_reported_cost_usd",
	"reported_cost_samples",
	"missing_cost_count",
	"mean_wall_time_ms",
	"p50_wall_time_ms",
	"p95_wall_time_ms",
	"mean_turns",
	"mean_tool_calls",
	"p50_tool_calls",
	"p95_tool_calls",
	...COMPONENT_TIMING_METRIC_KEYS.flatMap((key) => {
		const prefix = snakeCase(key);
		return [
			`${prefix}_total_ms`,
			`${prefix}_mean_ms`,
			`${prefix}_covered_runs`,
			`${prefix}_event_count`,
		];
	}),
	"retries",
	"mean_retries",
	"retry_covered_runs",
	"answer_contract",
	"output_token_covered_runs",
	"mean_terminal_answer_characters",
	"terminal_answer_character_covered_runs",
	"mean_terminal_answer_bytes",
	"terminal_answer_byte_covered_runs",
	"canonical_adoption_status",
	"canonical_adoption_reasons",
	"terminal_character_reduction",
	"output_token_reduction",
];

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRow(
	row: AggregateRow,
	assessment?: CanonicalAdoptionAssessment,
): string {
	return [
		row.taskId ?? "",
		row.category ?? "",
		row.condition ?? row.key,
		row.runs,
		row.passed,
		row.passRate.toFixed(6),
		row.deterministicPassed,
		row.llmPassed,
		row.llmConsidered,
		row.judgeAgreement,
		row.judgeAgreementConsidered,
		row.judgeAgreementRate.toFixed(6),
		row.safetyViolations,
		row.unsafeRuns,
		row.safetyRate.toFixed(6),
		row.hardSafetyIncidents,
		row.hardSafetyRuns,
		row.hardSafetyRate.toFixed(6),
		row.policyIncidents,
		row.policyIncidentRuns,
		row.policyIncidentRate.toFixed(6),
		row.commandErrors,
		row.commandErrorRuns,
		row.commandErrorRate.toFixed(6),
		row.apiErrors,
		row.apiErrorRuns,
		row.apiErrorRate.toFixed(6),
		row.otherToolErrors,
		row.otherToolErrorRuns,
		row.otherToolErrorRate.toFixed(6),
		row.infrastructureErrors,
		row.infrastructureErrorRuns,
		row.infrastructureErrorRate.toFixed(6),
		row.expectedErrors,
		row.expectedErrorRuns,
		row.expectedErrorRate.toFixed(6),
		row.errors,
		row.errorRuns,
		row.errorRate.toFixed(6),
		row.meanInputTokens.toFixed(6),
		row.meanCacheReadInputTokens.toFixed(6),
		row.meanCacheCreationInputTokens.toFixed(6),
		row.meanOutputTokens === undefined ? "" : row.meanOutputTokens.toFixed(6),
		row.meanReportedCostUsd === undefined
			? ""
			: row.meanReportedCostUsd.toFixed(6),
		row.reportedCostSamples,
		row.missingCostCount,
		row.meanWallTimeMs.toFixed(3),
		row.p50WallTimeMs.toFixed(3),
		row.p95WallTimeMs.toFixed(3),
		row.meanTurns.toFixed(6),
		row.meanToolCalls.toFixed(6),
		row.p50ToolCalls.toFixed(3),
		row.p95ToolCalls.toFixed(3),
		...COMPONENT_TIMING_METRIC_KEYS.flatMap((key) => {
			const metric = row.componentTimings[key];
			return [
				metric.totalMs.toFixed(3),
				metric.meanMs === undefined ? "" : metric.meanMs.toFixed(3),
				metric.coveredRuns,
				metric.eventCount,
			];
		}),
		row.retries,
		row.meanRetries === undefined ? "" : row.meanRetries.toFixed(6),
		row.retryCoveredRuns,
		row.answerContract ?? "",
		row.outputTokenCoveredRuns,
		row.meanTerminalAnswerCharacters === undefined
			? ""
			: row.meanTerminalAnswerCharacters.toFixed(6),
		row.terminalAnswerCharacterCoveredRuns,
		row.meanTerminalAnswerBytes === undefined
			? ""
			: row.meanTerminalAnswerBytes.toFixed(6),
		row.terminalAnswerByteCoveredRuns,
		assessment?.status ?? "",
		assessment?.reasons.join("; ") ?? "",
		assessment?.terminalCharacterReduction === undefined
			? ""
			: assessment.terminalCharacterReduction.toFixed(6),
		assessment?.outputTokenReduction === undefined
			? ""
			: assessment.outputTokenReduction.toFixed(6),
	]
		.map(csvCell)
		.join(",");
}

export function renderCsvReport(
	aggregate: ReportAggregate,
	assessment?: CanonicalAdoptionAssessment,
): string {
	return [
		csvColumns.join(","),
		...aggregate.byTask.map((row) => csvRow(row, assessment)),
	].join("\n") + "\n";
}

export async function writeReports(
	markdownFile: string,
	csvFile: string,
	results: readonly BenchmarkResult[],
	selectedMatrixRunId?: string,
	adoptionResults: readonly BenchmarkResult[] = results,
): Promise<void> {
	const resultRunIds = new Set(results.map((result) => result.matrixRunId));
	if (
		resultRunIds.size > 1 ||
		(selectedMatrixRunId !== undefined &&
			results.some((result) => result.matrixRunId !== selectedMatrixRunId))
	) {
		throw new Error(
			"report results must already contain one selected matrix cohort; writeReports will not switch cohorts",
		);
	}
	if (
		selectedMatrixRunId !== undefined &&
		adoptionResults.some(
			(result) => result.matrixRunId !== selectedMatrixRunId,
		)
	) {
		throw new Error(
			"adoption assessment results must belong to the selected matrix cohort",
		);
	}
	await mkdir(dirname(markdownFile), { recursive: true });
	await mkdir(dirname(csvFile), { recursive: true });
	const selectedResults = [...results];
	const aggregate = aggregateResults(selectedResults);
	const metadata = metadataFromResults(selectedResults);
	const assessment = assessCanonicalAdoption(adoptionResults);
	await writeFile(
		markdownFile,
		renderMarkdownReport(
			selectedResults,
			aggregate,
			metadata,
			selectedMatrixRunId,
			assessment,
		),
		{ mode: 0o600 },
	);
	await writeFile(csvFile, renderCsvReport(aggregate, assessment), { mode: 0o600 });
}
