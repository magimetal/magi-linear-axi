import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	BenchmarkResult,
	CohortMetadata,
	Condition,
	ResultFilters,
	TaskCategory,
} from "./types.js";

export interface AggregateRow {
	key: string;
	taskId?: string;
	category?: TaskCategory;
	condition?: Condition;
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
	reportedCostUsd: number;
	reportedCostSamples: number;
	missingCostCount: number;
	wallTimeMs: number;
	turns: number;
	toolCalls: number;
	meanInputTokens: number;
	meanCacheReadInputTokens: number;
	meanCacheCreationInputTokens: number;
	meanOutputTokens: number;
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
	reportedCostUsd: number;
	reportedCostSamples: number;
	missingCostCount: number;
	wallTimeMs: number;
	turns: number;
	toolCalls: number;
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
		reportedCostUsd: 0,
		reportedCostSamples: 0,
		missingCostCount: 0,
		wallTimeMs: 0,
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
	totals.outputTokens += numeric(result.outputTokens);
	if (
		result.reportedCostUsd !== undefined &&
		Number.isFinite(result.reportedCostUsd)
	) {
		totals.reportedCostUsd += result.reportedCostUsd;
		totals.reportedCostSamples += 1;
	} else {
		totals.missingCostCount += 1;
	}
	totals.wallTimeMs += numeric(result.wallTimeMs);
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
	metadata?: Pick<AggregateRow, "taskId" | "category" | "condition">,
): AggregateRow {
	const row: AggregateRow = {
		key,
		runs: totals.runs,
		passed: totals.passed,
		deterministicPassed: totals.deterministicPassed,
		llmPassed: totals.llmPassed,
		llmConsidered: totals.llmConsidered,
		judgeAgreement: totals.judgeAgreement,
		judgeAgreementConsidered: totals.judgeAgreementConsidered,
		judgeAgreementRate: rate(totals.judgeAgreement, totals.judgeAgreementConsidered),
		safetyViolations: totals.safetyViolations,
		unsafeRuns: totals.unsafeRuns,
		safetyRate: rate(totals.unsafeRuns, totals.runs),
		hardSafetyIncidents: totals.safetyViolations,
		hardSafetyRuns: totals.unsafeRuns,
		hardSafetyRate: rate(totals.unsafeRuns, totals.runs),
		policyIncidents: totals.policyIncidents,
		policyIncidentRuns: totals.policyIncidentRuns,
		policyIncidentRate: rate(totals.policyIncidentRuns, totals.runs),
		commandErrors: totals.commandErrors,
		commandErrorRuns: totals.commandErrorRuns,
		commandErrorRate: rate(totals.commandErrorRuns, totals.runs),
		apiErrors: totals.apiErrors,
		apiErrorRuns: totals.apiErrorRuns,
		apiErrorRate: rate(totals.apiErrorRuns, totals.runs),
		toolErrors: totals.toolErrors,
		toolErrorRuns: totals.toolErrorRuns,
		toolErrorRate: rate(totals.toolErrorRuns, totals.runs),
		otherToolErrors: totals.toolErrors,
		otherToolErrorRuns: totals.toolErrorRuns,
		otherToolErrorRate: rate(totals.toolErrorRuns, totals.runs),
		infrastructureErrors: totals.infrastructureErrors,
		infrastructureErrorRuns: totals.infrastructureErrorRuns,
		infrastructureErrorRate: rate(totals.infrastructureErrorRuns, totals.runs),
		expectedErrors: totals.expectedErrors,
		expectedErrorRuns: totals.expectedErrorRuns,
		expectedErrorRate: rate(totals.expectedErrorRuns, totals.runs),
		errors: totals.errors,
		errorRuns: totals.errorRuns,
		errorRate: rate(totals.errorRuns, totals.runs),
		inputTokens: totals.inputTokens,
		cacheReadInputTokens: totals.cacheReadInputTokens,
		cacheCreationInputTokens: totals.cacheCreationInputTokens,
		outputTokens: totals.outputTokens,
		reportedCostUsd: totals.reportedCostUsd,
		reportedCostSamples: totals.reportedCostSamples,
		missingCostCount: totals.missingCostCount,
		wallTimeMs: totals.wallTimeMs,
		turns: totals.turns,
		toolCalls: totals.toolCalls,
		meanInputTokens: mean(totals.inputTokens, totals.runs),
		meanCacheReadInputTokens: mean(totals.cacheReadInputTokens, totals.runs),
		meanCacheCreationInputTokens: mean(
			totals.cacheCreationInputTokens,
			totals.runs,
		),
		meanOutputTokens: mean(totals.outputTokens, totals.runs),
		...(totals.reportedCostSamples > 0
			? {
					meanReportedCostUsd:
						totals.reportedCostUsd / totals.reportedCostSamples,
				}
			: {}),
		meanWallTimeMs: mean(totals.wallTimeMs, totals.runs),
		p50WallTimeMs: percentile(totals.durations, 0.5),
		p95WallTimeMs: percentile(totals.durations, 0.95),
		meanTurns: mean(totals.turns, totals.runs),
		meanToolCalls: mean(totals.toolCalls, totals.runs),
		p50ToolCalls: percentile(totals.toolCallValues, 0.5),
		p95ToolCalls: percentile(totals.toolCallValues, 0.95),
		passRate: totals.runs === 0 ? 0 : totals.passed / totals.runs,
	};
	if (metadata?.taskId) {
		row.taskId = metadata.taskId;
	}
	if (metadata?.category) {
		row.category = metadata.category;
	}
	if (metadata?.condition) {
		row.condition = metadata.condition;
	}
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
		if (filters.matrixRunId && filters.matrixRunId !== result.matrixRunId) {
			return false;
		}
		if (
			filters.matrixRunIds &&
			!filters.matrixRunIds.includes(result.matrixRunId)
		) {
			return false;
		}
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

function cohortMetadata(
	result: BenchmarkResult,
	index: number,
): CohortMetadata {
	const conditions = result.expectedConditions;
	const taskIds = result.expectedTaskIds;
	if (
		!Array.isArray(conditions) ||
		conditions.length === 0 ||
		conditions.some(
			(condition) => condition !== "axi" && condition !== "mcp",
		) ||
		new Set(conditions).size !== conditions.length
	) {
		throw new Error(
			`cohort validation failed: result ${index + 1} has invalid expected conditions`,
		);
	}
	if (
		!Array.isArray(taskIds) ||
		taskIds.length === 0 ||
		taskIds.some(
			(taskId) => typeof taskId !== "string" || taskId.length === 0,
		) ||
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

/** Validates the complete, unfiltered set of expected cells for one matrix run. */
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
	const binaryHashRequired = metadata.expectedConditions.includes("axi");
	if (binaryHashRequired && !first.axiBinaryHash) {
		throw new Error(
			"cohort validation failed: result 1 is missing AXI binary hash",
		);
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
		const currentMetadata = cohortMetadata(result, index);
		if (!sameMetadata(metadata, currentMetadata)) {
			throw new Error(
				`cohort validation failed: result ${index + 1} has mixed expected cohort metadata`,
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
		if (
			(result.harnessCommit ?? undefined) !== (first.harnessCommit ?? undefined)
		) {
			throw new Error(
				`cohort validation failed: harness commit differs at result ${index + 1}`,
			);
		}
		if (
			(result.axiBinaryHash ?? undefined) !== (first.axiBinaryHash ?? undefined)
		) {
			throw new Error(
				`cohort validation failed: AXI binary hash differs at result ${index + 1}`,
			);
		}
	}

	const expectedCells = new Set<string>();
	for (const condition of metadata.expectedConditions) {
		for (const taskId of metadata.expectedTaskIds) {
			for (
				let repeatIndex = 1;
				repeatIndex <= metadata.expectedRepeatCount;
				repeatIndex += 1
			) {
				expectedCells.add(`${condition}/${taskId}/${repeatIndex}`);
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
		const cell = `${result.condition}/${result.taskId}/${result.repeatIndex}`;
		if (seenCells.has(cell)) {
			throw new Error(
				`cohort validation failed: duplicate condition/task/repeat cell ${cell}`,
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
	const missingCells = [...expectedCells].filter(
		(cell) => !seenCells.has(cell),
	);
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

export function aggregateResults(
	results: readonly BenchmarkResult[],
): ReportAggregate {
	const totals = newTotals();
	const conditionTotals = new Map<Condition, Totals>();
	const taskTotals = new Map<
		string,
		{ totals: Totals; category: TaskCategory; condition: Condition }
	>();
	for (const result of results) {
		addResult(totals, result);
		const condition = conditionTotals.get(result.condition) ?? newTotals();
		addResult(condition, result);
		conditionTotals.set(result.condition, condition);
		const key = `${result.condition}/${result.taskId}`;
		const task = taskTotals.get(key) ?? {
			totals: newTotals(),
			category: result.category,
			condition: result.condition,
		};
		addResult(task.totals, result);
		taskTotals.set(key, task);
	}
	const byCondition = [...conditionTotals.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([condition, conditionTotal]) =>
			finishRow(condition, conditionTotal, { condition }),
		);
	const byTask = [...taskTotals.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) =>
			finishRow(key, value.totals, {
				taskId: key.slice(key.indexOf("/") + 1),
				category: value.category,
				condition: value.condition,
			}),
		);
	const total = finishRow("total", totals);
	const { key: _key, ...summary } = total;
	return { ...summary, byCondition, byTask };
}

export async function readResults(
	filePath: string,
): Promise<BenchmarkResult[]> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error: unknown) {
		const code =
			error && typeof error === "object"
				? (error as { code?: unknown }).code
				: undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const results: BenchmarkResult[] = [];
	for (const [index, line] of content.split(/\r?\n/u).entries()) {
		if (!line.trim()) {
			continue;
		}
		try {
			results.push(JSON.parse(line) as BenchmarkResult);
		} catch {
			throw new Error(
				`results file contains invalid JSON on line ${index + 1}`,
			);
		}
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

function rowMarkdown(row: AggregateRow): string {
	return `| ${row.key} | ${row.runs} | ${row.passed} | ${percent(row.passRate)} | ${row.deterministicPassed} | ${row.llmPassed}/${row.llmConsidered} | ${row.judgeAgreement}/${row.judgeAgreementConsidered} (${percent(row.judgeAgreementRate)}) | ${incidentCell(row.safetyViolations, row.unsafeRuns, row.safetyRate)} | ${incidentCell(row.policyIncidents, row.policyIncidentRuns, row.policyIncidentRate)} | ${incidentCell(row.commandErrors, row.commandErrorRuns, row.commandErrorRate)} | ${incidentCell(row.apiErrors, row.apiErrorRuns, row.apiErrorRate)} | ${incidentCell(row.otherToolErrors, row.otherToolErrorRuns, row.otherToolErrorRate)} | ${incidentCell(row.infrastructureErrors, row.infrastructureErrorRuns, row.infrastructureErrorRate)} | ${incidentCell(row.expectedErrors, row.expectedErrorRuns, row.expectedErrorRate)} | ${incidentCell(row.errors, row.errorRuns, row.errorRate)} | ${fixed(row.meanInputTokens)} | ${fixed(row.meanCacheReadInputTokens)} | ${fixed(row.meanCacheCreationInputTokens)} | ${fixed(row.meanOutputTokens)} | ${costMean(row)} (${row.reportedCostSamples}/${row.runs}) | ${fixed(row.meanWallTimeMs)} | ${fixed(row.p50WallTimeMs)}/${fixed(row.p95WallTimeMs)} | ${fixed(row.meanTurns)} | ${fixed(row.meanToolCalls)} | ${fixed(row.p50ToolCalls)}/${fixed(row.p95ToolCalls)} |`;
}

export interface ReportMetadata {
	matrixRunIds: string[];
	benchmarkSeeds: string[];
	snapshotTimestamps: string[];
	snapshotHashes: string[];
	taskManifestHashes: string[];
	harnessCommits: string[];
	harnessSourceHashes: string[];
	axiBinaryHashes: string[];
	claudeVersions: string[];
	models: string[];
	gradingModes: string[];
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
		models: unique(results.map((result) => result.model)),
		gradingModes: unique(results.map((result) => result.gradingMode)),
	};
}

const markdownHeader =
	"| Run/task | Runs | Passes | Pass rate | Deterministic | LLM | Judge agreement (passed/failed only) | Safety violations / unsafe runs (hard safety rate) | Policy incidents / affected runs (rate) | Command errors / affected runs (rate) | API errors / affected runs (rate) | Other tool errors / affected runs (rate) | Infrastructure errors / affected runs (rate) | Expected errors / affected runs (rate) | Unexpected errors / affected runs (rate) | Mean input tokens | Mean cache-read tokens | Mean cache-creation tokens | Mean output tokens | Mean reported cost USD (covered/runs) | Mean agent wall time ms | p50/p95 agent wall time ms | Mean turns | Mean tool calls | p50/p95 tool calls |";
const markdownSeparator =
	"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
const emptyMarkdownRow =
	"| (no results) | 0 | 0 | 0.0% | 0 | 0/0 | 0/0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 / 0 (0.0%) | 0 | 0 | 0 | 0 | n/a (0/0) | 0 | 0/0 | 0 | 0 | 0/0 |";

export function renderMarkdownReport(
	results: readonly BenchmarkResult[],
	aggregate = aggregateResults(results),
	metadata = metadataFromResults(results),
	selectedMatrixRunId?: string,
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
		"- Agent wall time measures benchmark agent/interface execution only; judge execution and judge artifact writes are excluded.",
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
		"",
		"## Summary by condition (per-run means)",
		"",
		markdownHeader,
		markdownSeparator,
		...aggregate.byCondition.map(rowMarkdown),
		...(aggregate.byCondition.length === 0 ? [emptyMarkdownRow] : []),
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
		"Rows report per-run means; p50/p95 use the selected run's individual results. Judge agreement compares deterministic pass/fail with passed/failed judge results and excludes skipped/error judge results. Every incident category is shown as an incident total followed by affected runs; rates are run-level rates capped at 100%. Unexpected errors are command, API, other tool, and infrastructure errors combined; expected errors are reported separately. Totals above are sums and are not comparable averages. Agent wall time excludes the optional judge. A missing provider cost is counted as missing rather than zero. Policy incidents are audit findings and do not override correctness; hard safety violations do override correctness, as do true infrastructure failures. Deterministic grading requires condition-appropriate tool use, the task minimum call count, every required fact in the final answer, and linked non-error tool-result evidence (with expected not-found tool errors allowed for the not-found task).",
		"",
	];
	return lines.join("\n");
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
];

function csvCell(value: string | number): string {
	const text = String(value);
	return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRow(row: AggregateRow): string {
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
		row.meanOutputTokens.toFixed(6),
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
	]
		.map(csvCell)
		.join(",");
}

export function renderCsvReport(aggregate: ReportAggregate): string {
	return (
		[csvColumns.join(","), ...aggregate.byTask.map(csvRow)].join("\n") + "\n"
	);
}

export async function writeReports(
	markdownFile: string,
	csvFile: string,
	results: readonly BenchmarkResult[],
	selectedMatrixRunId?: string,
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
	await mkdir(dirname(markdownFile), { recursive: true });
	await mkdir(dirname(csvFile), { recursive: true });
	const selectedResults = [...results];
	const aggregate = aggregateResults(selectedResults);
	const metadata = metadataFromResults(selectedResults);
	await writeFile(
		markdownFile,
		renderMarkdownReport(
			selectedResults,
			aggregate,
			metadata,
			selectedMatrixRunId,
		),
		{ mode: 0o600 },
	);
	await writeFile(csvFile, renderCsvReport(aggregate), { mode: 0o600 });
}
