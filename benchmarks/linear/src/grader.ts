import { canonicalAnswerPassed, canonicalAnswerSchema } from "./answer-contract.js";
import type { AnswerContract } from "./types.js";
import type {
	BenchmarkOperationKind,
	BenchmarkTask,
	Condition,
	DeterministicGrade,
	LlmGrade,
	ParsedClaudeStream,
	ParsedToolCall,
	SafetyViolation,
} from "./types.js";
import { DEFAULT_MODEL, executeClaude } from "./claude.js";
import { redactSecrets } from "./safety.js";
import {
	classifyOperations,
	operationRequirementsMatch,
	operationTraceMatches,
	type ObservedOperation,
} from "./operations.js";

export interface ToolUseCounts {
	total: number;
	bash: number;
	mcp: number;
}

export interface ErrorCounts {
	expectedErrorCount: number;
	commandErrorCount: number;
	apiErrorCount: number;
	toolErrorCount: number;
	infrastructureErrorCount: number;
}

export interface JudgeToolEvidence {
	calls: Array<{
		id?: string;
		name: string;
		kind: ParsedToolCall["kind"];
		input: string;
	}>;
	results: Array<{ toolUseId: string; isError: boolean; text: string }>;
}

function normalize(value: string): string {
	return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Accept only explicit, bounded issue-scoped absence language. Generic errors,
 * HTTP statuses, and permission/lookup wording are deliberately excluded: they
 * do not establish that an issue is absent.
 */
export function mentionsNotFound(value: string): boolean {
	if (
		/\b(?:permission|forbidden|unauthori[sz]ed|access[\s-]+denied|not[\s-]+visible|not[\s-]+permitted)\b/iu.test(
			value,
		)
	) {
		return false;
	}
	return (
		/\bissue\b[\s\S]{0,96}\bnot[\s-]+found\b/iu.test(value) ||
		/\bissue\b[\s\S]{0,96}\b(?:does[\s-]+not|doesn['’]?t)[\s-]+exist\b/iu.test(
			value,
		) ||
		/\bno[\s-]+such[\s-]+issue\b/iu.test(value) ||
		/\bentity[\s-]+not[\s-]+found\s*:\s*issue\b/iu.test(value) ||
		/\bcould[\s-]+not[\s-]+find[\s-]+referenced[\s-]+issue\b/iu.test(value) ||
		/\bnot[\s-]+found\b[\s\S]{0,96}\bissue\b/iu.test(value)
	);
}

export function toolUseCounts(stream: ParsedClaudeStream): ToolUseCounts {
	return stream.toolCalls.reduce(
		(counts, call) => {
			if (call.kind === "structured_output") {
				return counts;
			}
			counts.total += 1;
			if (call.kind === "bash") {
				counts.bash += 1;
			} else if (call.kind === "mcp") {
				counts.mcp += 1;
			}
			return counts;
		},
		{ total: 0, bash: 0, mcp: 0 },
	);
}

function expectedToolUse(condition: Condition, counts: ToolUseCounts): boolean {
	return condition === "axi"
		? counts.bash > 0
		: counts.mcp > 0 && counts.bash === 0;
}

function streamToolResults(
	stream: ParsedClaudeStream,
): ParsedClaudeStream["toolResults"] {
	return stream.toolResults ?? [];
}

function userToolCalls(stream: ParsedClaudeStream): ParsedToolCall[] {
	return stream.toolCalls.filter((call) => call.kind !== "structured_output");
}

function structuredOutputToolIds(stream: ParsedClaudeStream): Set<string> {
	return new Set(
		stream.toolCalls.flatMap((call) =>
			call.kind === "structured_output" && call.id ? [call.id] : [],
		),
	);
}

function linkedResults(
	stream: ParsedClaudeStream,
): Map<string, ParsedClaudeStream["toolResults"]> {
	const toolIds = new Set(
		userToolCalls(stream).flatMap((call) => (call.id ? [call.id] : [])),
	);
	const linked = new Map<string, ParsedClaudeStream["toolResults"]>();
	for (const result of streamToolResults(stream)) {
		if (!toolIds.has(result.toolUseId)) {
			continue;
		}
		const existing = linked.get(result.toolUseId) ?? [];
		existing.push(result);
		linked.set(result.toolUseId, existing);
	}
	return linked;
}

export function linkedToolEvidenceCount(stream: ParsedClaudeStream): number {
	return [...linkedResults(stream).values()].reduce(
		(count, results) => count + results.length,
		0,
	);
}

function resultsForOperation(
	stream: ParsedClaudeStream,
	operation: ObservedOperation,
	linked: Map<string, ParsedClaudeStream["toolResults"]>,
): ParsedClaudeStream["toolResults"] {
	const call = stream.toolCalls[operation.callIndex];
	return call?.id ? linked.get(call.id) ?? [] : [];
}

function escapedRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function explicitlyEmptyField(text: string, key: string): boolean {
	const escapedKey = escapedRegex(key);
	return new RegExp(
		`(?:^|[\\s,{])(?:"${escapedKey}"|${escapedKey})\\s*[:=]\\s*(?:""|'')(?:$|[\\s,}])`,
		"u",
	).test(text);
}

function jsonContainsEmptyNestedField(
	value: unknown,
	parentKey: string,
	childKey: string,
): boolean {
	if (Array.isArray(value)) {
		return value.some((item) =>
			jsonContainsEmptyNestedField(item, parentKey, childKey),
		);
	}
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	const parent = record[parentKey];
	if (
		parent &&
		typeof parent === "object" &&
		!Array.isArray(parent) &&
		(parent as Record<string, unknown>)[childKey] === ""
	) {
		return true;
	}
	return Object.values(record).some((item) =>
		jsonContainsEmptyNestedField(item, parentKey, childKey),
	);
}

function explicitlyEmptyNestedField(
	text: string,
	parentKey: string,
	childKey: string,
): boolean {
	try {
		return jsonContainsEmptyNestedField(
			JSON.parse(text) as unknown,
			parentKey,
			childKey,
		);
	} catch {
		// AXI's default TOON output is not JSON; check its indented field shape.
	}
	const escapedParent = escapedRegex(parentKey);
	const escapedChild = escapedRegex(childKey);
	return new RegExp(
		`(?:^|\\r?\\n)([ \\t]*)${escapedParent}\\s*:\\s*\\r?\\n\\1[ \\t]+${escapedChild}\\s*:\\s*(?:""|'')(?:$|\\r?\\n)`,
		"u",
	).test(text);
}

function evidenceForFact(
	value: string,
	stream: ParsedClaudeStream,
	source: BenchmarkOperationKind | undefined,
	operations: readonly ObservedOperation[],
	answerContract: AnswerContract,
	emptyFieldKey?: string,
	emptyEvidencePath?: readonly [string, string],
): { grounded: boolean; results: typeof stream.toolResults } {
	const expected = normalize(value);
	const serialized = JSON.stringify(value);
	const escapedExpected = serialized === undefined
		? value
		: serialized.slice(1, -1);
	const matchesValue = (text: string): boolean =>
		answerContract === "canonical"
			? text.includes(value) || text.includes(escapedExpected)
			: (expected.length > 0 && normalize(text).includes(expected)) ||
				text.includes(escapedExpected);
	const linked = linkedResults(stream);
	const candidates = source
		? operations
				.filter((operation) => operation.kind === source)
				.flatMap((operation) => resultsForOperation(stream, operation, linked))
		: [...linked.values()].flat();
	const results = candidates.filter(
		(result) =>
			!result.isError &&
			(value.length === 0
				? emptyEvidencePath !== undefined
					? explicitlyEmptyNestedField(
							result.text,
							emptyEvidencePath[0],
							emptyEvidencePath[1],
						)
					: emptyFieldKey !== undefined &&
						explicitlyEmptyField(result.text, emptyFieldKey)
				: matchesValue(result.text)),
	);
	return { grounded: results.length > 0, results };
}

function notFoundEvidence(
	stream: ParsedClaudeStream,
	attemptedIdentifier: string | undefined,
	source: BenchmarkOperationKind | undefined,
	operations: readonly ObservedOperation[],
): boolean {
	const expectedIdentifier = attemptedIdentifier
		? normalize(attemptedIdentifier)
		: undefined;
	const linked = linkedResults(stream);
	for (const operation of operations) {
		if (source && operation.kind !== source) continue;
		const call = stream.toolCalls[operation.callIndex];
		const results = resultsForOperation(stream, operation, linked);
		if (!call || !call.id) continue;
		if (expectedIdentifier) {
			let input = "";
			try {
				input = JSON.stringify(call.input) ?? "";
			} catch {
				input = "";
			}
			if (!normalize(input).includes(expectedIdentifier)) continue;
		}
		if (
			results.some(
				(result) =>
					result.isError && mentionsNotFound(boundedErrorText(result.text)),
			)
		) {
			return true;
		}
	}
	return false;
}

function hasExpectedNotFoundTask(task: BenchmarkTask): boolean {
	return (
		task.requiredFacts.length > 0 &&
		task.requiredFacts.every((fact) => fact.kind === "not_found")
	);
}

const TOOL_ERROR_MESSAGE = "Claude Code returned a tool error";
const TERMINAL_ERROR_MESSAGES = new Set([
	"Claude Code returned a non-success result",
	"Claude Code returned a result without a success subtype",
	"Claude Code emitted multiple result events",
]);
const PARSE_ERROR_MESSAGES = new Set([
	"Claude Code emitted a malformed tool result",
	"Claude Code emitted a tool use without a name",
	"Claude Code emitted an input delta without a tool use id",
	"Claude Code ended with incomplete tool input JSON",
]);

function boundedErrorText(value: string): string {
	return value.slice(0, 1200).toLocaleLowerCase();
}

function isCommandError(value: string): boolean {
	const text = boundedErrorText(value);
	return (
		/\b(?:usage|unknown\s+(?:option|argument)|invalid\s+(?:option|argument)|unexpected\s+argument)\b/iu.test(
			text,
		) ||
		/\b(?:exit(?:ed)?)(?:\s+(?:with\s+)?(?:status|code))?\s*[:=]?\s*2\b/iu.test(
			text,
		) ||
		/\b(?:status|code)\s*[:=]?\s*2\b/iu.test(text)
	);
}

function isApiError(value: string): boolean {
	const text = boundedErrorText(value);
	return (
		/\b(?:api|graphql|auth(?:entication|orization)?|unauthori[sz]ed|forbidden|credential|config(?:uration)?|transport|network|connection|timeout|endpoint|rate\s+limit|http)\b/iu.test(
			text,
		) ||
		/\b(?:exit(?:ed)?)(?:\s+(?:with\s+)?(?:status|code))?\s*[:=]?\s*1\b/iu.test(
			text,
		) ||
		/\b(?:status|code)\s*[:=]?\s*1\b/iu.test(text)
	);
}

function infrastructureErrorCount(stream: ParsedClaudeStream): number {
	let count =
		stream.terminalStatus === "success" &&
		!stream.errors.some((error) => TERMINAL_ERROR_MESSAGES.has(error))
			? 0
			: 1;
	count += stream.parseErrors;
	if (stream.exitCode !== undefined && stream.exitCode !== 0) {
		count += 1;
	}
	if (stream.signal !== undefined) {
		count += 1;
	}
	count += stream.errors.filter(
		(error) =>
			error !== TOOL_ERROR_MESSAGE &&
			!TERMINAL_ERROR_MESSAGES.has(error) &&
			!PARSE_ERROR_MESSAGES.has(error),
	).length;
	return count;
}

/** Classifies bounded linked tool errors separately from true runtime failures. */
export function classifyErrors(
	stream: ParsedClaudeStream,
	task: BenchmarkTask,
): ErrorCounts {
	const counts: ErrorCounts = {
		expectedErrorCount: 0,
		commandErrorCount: 0,
		apiErrorCount: 0,
		toolErrorCount: 0,
		infrastructureErrorCount: infrastructureErrorCount(stream),
	};
	const linked = [...linkedResults(stream).values()].flat();
	for (const result of linked) {
		if (!result.isError) {
			continue;
		}
		const text = boundedErrorText(result.text);
		if (hasExpectedNotFoundTask(task) && mentionsNotFound(text)) {
			counts.expectedErrorCount += 1;
		} else if (isCommandError(text)) {
			counts.commandErrorCount += 1;
		} else if (isApiError(text)) {
			counts.apiErrorCount += 1;
		} else {
			counts.toolErrorCount += 1;
		}
	}

	// Older streams can contain the generic parser error without a retained
	// linked result. Keep it an ordinary tool error, never infrastructure.
	const linkedErrorCount = linked.filter((result) => result.isError).length;
	const structuredIds = structuredOutputToolIds(stream);
	const structuredErrorCount = streamToolResults(stream).filter(
		(result) => structuredIds.has(result.toolUseId) && result.isError,
	).length;
	const genericToolErrorCount = stream.errors.filter(
		(error) => error === TOOL_ERROR_MESSAGE,
	).length;
	counts.toolErrorCount += Math.max(
		0,
		genericToolErrorCount - linkedErrorCount - structuredErrorCount,
	);
	return counts;
}

function infrastructureFailure(
	task: BenchmarkTask,
	stream: ParsedClaudeStream,
): boolean {
	return classifyErrors(stream, task).infrastructureErrorCount > 0;
}

export function gradeDeterministically(
	task: BenchmarkTask,
	answer: string,
	condition: Condition,
	stream: ParsedClaudeStream,
	safetyViolations: readonly SafetyViolation[],
	resolvedAxiBin = "magi-linear-axi",
	answerContract: AnswerContract = "compact",
): DeterministicGrade {
  const counts = toolUseCounts(stream);
	const toolUseObserved = expectedToolUse(condition, counts);
	const operations = classifyOperations(condition, stream.toolCalls, resolvedAxiBin);
	const linked = linkedResults(stream);
	const operationChecksPassed =
		task.requiredOperations.length === 0 ||
		(operationTraceMatches(task.requiredOperations, operations) &&
			operationRequirementsMatch(task.requiredOperations, operations, linked));
	const formatPassed =
		answerContract === "compact" || canonicalAnswerPassed(task, answer);
	const factChecks = task.requiredFacts.map((fact) => {
		if (fact.kind === "not_found") {
			const grounded = notFoundEvidence(
				stream,
				fact.value,
				fact.source,
				operations,
			);
			const answerPassed = answerContract === "canonical"
				? formatPassed
				: mentionsNotFound(answer);
			return {
				label: fact.label,
				passed: answerPassed && grounded,
				grounded,
			};
		}
		const hasExpectedValue = fact.value !== undefined;
		const value = fact.value ?? "";
		const emptyFieldKey =
			value.length === 0
				? canonicalAnswerSchema(task)
						.flatMap((record) => record.fields)
						.find((field) => field.factLabel === fact.label)?.key
				: undefined;
		const emptyEvidencePath =
			value.length === 0 && fact.label === "project status"
				? (["status", "name"] as const)
				: undefined;
		const grounded =
			hasExpectedValue &&
			evidenceForFact(
				value,
				stream,
				fact.source,
				operations,
				answerContract,
				emptyFieldKey,
				emptyEvidencePath,
			).grounded;
		const answerPassed = answerContract === "canonical"
			? formatPassed
			: value.length === 0
				? false
				: normalize(answer).includes(normalize(value));
		return {
			label: fact.label,
			passed: hasExpectedValue && answerPassed && grounded,
			grounded,
		};
	});
	const factsPassed = factChecks.every((check) => check.passed);
	const failedInfrastructure = infrastructureFailure(task, stream);
	const enoughTools = counts.total >= task.minimumToolCalls;
	const passed =
		safetyViolations.length === 0 &&
		formatPassed &&
		toolUseObserved &&
		enoughTools &&
		operationChecksPassed &&
		factsPassed &&
		!failedInfrastructure;
	let reason =
		"all required facts, grounded evidence, tool-use, and infrastructure checks passed";
	if (safetyViolations.length > 0) {
		reason = "safety violation overrides the task grade";
	} else if (failedInfrastructure) {
		reason =
			"the Claude trajectory had a parse, process, or non-success infrastructure failure";
	} else if (!toolUseObserved) {
		reason =
			"the final answer was not supported by the required condition tool use";
	} else if (!enoughTools) {
		reason = `the task requires at least ${task.minimumToolCalls} tool call(s), but only ${counts.total} were observed`;
	} else if (!operationChecksPassed) {
		reason =
			"the observed operation trace, exact operand, or linked result semantics did not match the task";
	} else if (!formatPassed) {
		reason = "canonical answer format or exact serialization failed";
	} else if (!factsPassed) {
		reason =
		"one or more deterministic required-fact assertions failed or lacked linked tool evidence";
	}
	return {
		passed,
		score: passed ? 1 : 0,
		reason,
		formatPassed,
		...(formatPassed ? {} : { formatReason: "canonical answer format or exact serialization failed" }),
		factChecks,
		operationTrace: operations.map((operation) => operation.kind),
		operationChecksPassed,
		toolUseRequired: true,
		toolUseObserved,
		minimumToolCalls: task.minimumToolCalls,
		observedToolCalls: counts.total,
		infrastructureFailure: failedInfrastructure,
	};
}

function boundedInput(input: unknown, secrets: readonly string[]): string {
	let text: string;
	try {
		text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
	} catch {
		text = "[unserializable input]";
	}
	return redactSecrets(text, secrets).slice(0, 600);
}

export function boundedToolEvidence(
	stream: ParsedClaudeStream,
	secrets: readonly string[] = [],
): JudgeToolEvidence {
	const structuredIds = structuredOutputToolIds(stream);
	return {
		calls: userToolCalls(stream).slice(0, 32).map((call) => ({
			...(call.id ? { id: call.id } : {}),
			name: call.name.slice(0, 160),
			kind: call.kind,
			input: boundedInput(call.input, secrets),
		})),
		results: streamToolResults(stream)
			.filter((result) => !structuredIds.has(result.toolUseId))
			.slice(0, 32)
			.map((result) => ({
				toolUseId: result.toolUseId.slice(0, 160),
				isError: result.isError,
				text: redactSecrets(result.text, secrets).slice(0, 800),
			})),
	};
}

export interface JudgeOptions {
	task: BenchmarkTask;
	condition: Condition;
	answerContract: AnswerContract;
	answer: string;
	deterministic: DeterministicGrade;
	toolCounts: ToolUseCounts;
	toolEvidence?: JudgeToolEvidence;
	model?: string;
	claudeBin?: string;
	cwd: string;
	timeoutMs?: number;
	redactionSecrets?: readonly string[];
	execute?: typeof executeClaude;
}

export interface JudgeExecution {
	grade: LlmGrade;
	raw: string;
	parsed: ParsedClaudeStream;
}

function judgePrompt(options: JudgeOptions): string {
	const facts = options.task.requiredFacts.map((fact) => ({
		label: fact.label,
		kind: fact.kind,
		...(fact.value !== undefined ? { value: fact.value } : {}),
		...(fact.source ? { source: fact.source } : {}),
	}));
	return [
		"You are a strict read-only benchmark judge.",
		'Return JSON only: {"passed":boolean,"score":number,"rationale":string}.',
		"Judge only whether the answer is supported by the supplied dynamic facts and linked tool evidence.",
		"Do not reward guessing, and do not invent missing facts. A safety violation or infrastructure failure always fails.",
		JSON.stringify({
			condition: options.condition,
			task: {
				id: options.task.id,
				category: options.task.category,
				prompt: options.task.prompt,
				minimumToolCalls: options.task.minimumToolCalls,
				requiredOperations: options.task.requiredOperations,
			},
			answerContract: options.answerContract,
			answerSchema: options.task.canonicalAnswer,
			requiredFacts: facts,
			gradingHints: options.task.gradingHints,
			answer: options.answer,
			deterministic: options.deterministic,
			toolCounts: options.toolCounts,
			toolEvidence: options.toolEvidence ?? { calls: [], results: [] },
		}),
	].join("\n");
}

function parseJudgeOutput(output: string, model: string): LlmGrade {
	const candidates = [output.trim(), output.match(/\{[\s\S]*\}/u)?.[0] ?? ""];
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (!parsed || typeof parsed !== "object") {
				continue;
			}
			const value = parsed as {
				passed?: unknown;
				score?: unknown;
				rationale?: unknown;
			};
			if (typeof value.passed !== "boolean") {
				continue;
			}
			let score = value.passed ? 1 : 0;
			if (typeof value.score === "number" && Number.isFinite(value.score)) {
				score = Math.max(0, Math.min(1, value.score));
			}
			const rationale =
				typeof value.rationale === "string"
					? value.rationale.slice(0, 2000)
					: undefined;
			return {
				status: value.passed ? "passed" : "failed",
				model,
				score,
				...(rationale ? { rationale } : {}),
				output: output.slice(0, 4000),
			};
		} catch {
			// Try the next bounded candidate.
		}
	}
	return {
		status: "error",
		model,
		rationale: "judge did not return the required JSON shape",
		output: output.slice(0, 4000),
	};
}

export async function runJudge(options: JudgeOptions): Promise<JudgeExecution> {
	const model = options.model ?? DEFAULT_MODEL;
	const execute = options.execute ?? executeClaude;
	const execution = await execute({
		condition: "judge",
		model,
		prompt: judgePrompt(options),
		...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
		cwd: options.cwd,
		...(options.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options.redactionSecrets
			? { redactionSecrets: options.redactionSecrets }
			: {}),
	});
	if (
		execution.commandError ||
		execution.parsed.terminalStatus !== "success" ||
		execution.parsed.errors.length > 0 ||
		execution.parsed.signal !== undefined ||
		(execution.parsed.exitCode !== undefined && execution.parsed.exitCode !== 0)
	) {
		const message = execution.commandError ?? "judge Claude process failed";
		return {
			grade: {
				status: "error",
				model,
				rationale: message,
				output: execution.parsed.finalAnswer.slice(0, 4000),
			},
			raw: execution.stdout,
			parsed: execution.parsed,
		};
	}
	return {
		grade: parseJudgeOutput(execution.parsed.finalAnswer, model),
		raw: execution.stdout,
		parsed: execution.parsed,
	};
}
