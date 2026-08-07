import { parseAxiArgv } from "./axi-argv.js";
import type {
	BenchmarkOperationKind,
	Condition,
	ObservedOperationKind,
	ParsedToolCall,
	ParsedToolResult,
	RequiredOperation,
} from "./types.js";

export interface ShellParse {
	segments: string[][];
	unsafeOperator?: string;
}

/**
 * Parses only the shell syntax needed to audit an observed command. It never
 * invokes a shell and deliberately stops operation classification when the
 * command contains composition or redirection syntax.
 */
export function parseShellCommand(command: string): ShellParse {
	const segments: string[][] = [[]];
	let word = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	const pushWord = (): void => {
		if (word.length > 0) {
			segments.at(-1)?.push(word);
			word = "";
		}
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			if (character === "\n") {
				return { segments, unsafeOperator: "line continuation" };
			}
			word += character;
			escaped = false;
			continue;
		}
		if (quote === "single") {
			if (character === "'") {
				quote = undefined;
			} else {
				word += character;
			}
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (
				character === "$" &&
				(command[index + 1] === "(" ||
					/[A-Za-z_{]/u.test(command[index + 1] ?? ""))
			) {
				return { segments, unsafeOperator: "shell substitution" };
			}
			word += character;
			continue;
		}
		if (character === "'") {
			quote = "single";
			continue;
		}
		if (character === '"') {
			quote = "double";
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "#" && word.length === 0) {
			break;
		}
		if (/\s/u.test(character)) {
			pushWord();
			if (character === "\n") {
				return { segments, unsafeOperator: "command separator" };
			}
			continue;
		}
		if (
			character === "$" &&
			(command[index + 1] === "(" ||
				/[A-Za-z_{]/u.test(command[index + 1] ?? ""))
		) {
			return { segments, unsafeOperator: "shell substitution" };
		}
		if (character === "`") {
			return { segments, unsafeOperator: "shell substitution" };
		}
		if (character === "|") {
			return {
				segments,
				unsafeOperator:
					command[index + 1] === "|" || command[index - 1] === "|"
						? "shell chaining"
						: "pipeline",
			};
		}
		if (";&><(){}".includes(character)) {
			return { segments, unsafeOperator: "shell operator" };
		}
		word += character;
	}
	if (quote || escaped) {
		return { segments, unsafeOperator: "unterminated shell quote or escape" };
	}
	pushWord();
	return { segments };
}

export function commandInput(input: unknown): string | undefined {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const command = (input as { command?: unknown }).command;
		return typeof command === "string" ? command : undefined;
	}
	// Older Claude stream fixtures represented Bash input directly as a string.
	return typeof input === "string" ? input : undefined;
}

function identifierTokens(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.split(/[^A-Za-z0-9]+/u)
		.map((token) => token.toLowerCase())
		.filter(Boolean);
}

function axiExecutableMatches(command: string, expected: string): boolean {
	if (command === expected) return true;
	// Unit callers often use the default executable name while live runs pass
	// the absolute per-case broker wrapper. The live path is still exact when
	// supplied by the runner; the basename fallback is only for standalone
	// grading fixtures.
	return (
		expected === "magi-linear-axi" &&
		(command.endsWith("/magi-linear-axi") || command.endsWith("/axi-wrapper"))
	);
}

function classifyAxiCall(
	call: ParsedToolCall,
	resolvedAxiBin: string,
): ClassifiedOperation {
	if (call.kind !== "bash" || call.name.toLowerCase() !== "bash") {
		return classifiedOther();
	}
	const command = commandInput(call.input);
	if (!command) return classifiedOther();
	const parsed = parseShellCommand(command);
	if (parsed.unsafeOperator || parsed.segments.length !== 1) {
		return classifiedOther();
	}
	const tokens = parsed.segments[0] ?? [];
	const executable = tokens[0];
	if (!executable || !axiExecutableMatches(executable, resolvedAxiBin)) {
		return classifiedOther();
	}
	const normalized = parseAxiArgv(tokens.slice(1));
	if (!normalized.ok) return classifiedOther();
	if (normalized.help || normalized.version) return { kind: "help" };
	const operation = normalized.operation;
	if (operation?.kind === "issue_query") {
		const search = operation.search.trim();
		return search.length > 0
			? { kind: "issue_search", operand: search, searchText: search }
			: classifiedOther();
	}
	if (operation?.kind === "issue_view") {
		const issueIdentifier = operation.identifier.trim();
		return issueIdentifier.length > 0
			? { kind: "issue_view", operand: issueIdentifier, issueIdentifier }
			: classifiedOther();
	}
	return classifiedOther();
}

function normalizedKey(key: string): string {
	return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

/**
 * Extracts a string from a typed MCP input without treating arbitrary prose as
 * an operand. Key order is deliberate: a tool's query/search field wins over
 * optional display fields, and an explicit identifier wins over a generic id.
 */
function textAtKeys(
	value: unknown,
	keys: readonly string[],
	depth = 0,
): string | undefined {
	if (depth > 6 || value === null || value === undefined) return undefined;
	if (typeof value === "string") {
		try {
			return textAtKeys(JSON.parse(value) as unknown, keys, depth + 1);
		} catch {
			return undefined;
		}
	}
	if (Array.isArray(value)) {
		for (const nested of value) {
			const found = textAtKeys(nested, keys, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof value !== "object") return undefined;
	const entries = Object.entries(value as Record<string, unknown>);
	for (const wanted of keys) {
		for (const [key, nested] of entries) {
			if (normalizedKey(key) !== wanted) continue;
			if (typeof nested === "string" && nested.trim().length > 0) {
				return nested.trim();
			}
			const found = textAtKeys(nested, keys, depth + 1);
			if (found !== undefined) return found;
		}
	}
	for (const [, nested] of entries) {
		const found = textAtKeys(nested, keys, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

const MCP_SEARCH_KEYS = [
	"query",
	"search",
	"searchterm",
	"title",
	"text",
	"term",
	"containsignorecase",
] as const;
const MCP_IDENTIFIER_KEYS = [
	"identifier",
	"issueidentifier",
	"issueid",
	"id",
] as const;

interface ClassifiedOperation {
	kind: ObservedOperationKind;
	operand?: string;
	searchText?: string;
	issueIdentifier?: string;
}

function classifiedOther(): ClassifiedOperation {
	return { kind: "other" };
}

function classifyMcpCall(call: ParsedToolCall): ClassifiedOperation {
	if (
		call.kind !== "mcp" ||
		!/^mcp__linear__[A-Za-z0-9_]+$/u.test(call.name)
	) {
		return classifiedOther();
	}
	const tokens = identifierTokens(call.name.replace(/^mcp__linear__/u, ""));
	const hasIssue = tokens.includes("issue") || tokens.includes("issues");
	const hasOtherEntity = tokens.some((token) =>
		["comment", "comments", "label", "labels", "status", "statuses"].includes(token),
	);
	if (!hasIssue || hasOtherEntity) return classifiedOther();
	const hasSearchVerb = tokens.includes("search");
	const hasListVerb = tokens.includes("list");
	if (hasSearchVerb || hasListVerb) {
		const searchText = textAtKeys(call.input, MCP_SEARCH_KEYS);
		return searchText === undefined
			? classifiedOther()
			: { kind: "issue_search", operand: searchText, searchText };
	}
	const hasGetVerb = tokens.some((token) =>
		["get", "fetch", "retrieve", "view"].includes(token),
	);
	if (!hasGetVerb) return classifiedOther();
	const issueIdentifier = textAtKeys(call.input, MCP_IDENTIFIER_KEYS);
	return issueIdentifier === undefined
		? classifiedOther()
		: {
				kind: "issue_view",
				operand: issueIdentifier,
				issueIdentifier,
			};
}

export interface ObservedOperation {
	kind: ObservedOperationKind;
	condition: Condition;
	callIndex: number;
	/** The Claude tool-use ID used to link this call to its result. */
	toolUseId?: string;
	/** Trimmed operand extracted from the interface-specific call shape. */
	operand?: string;
	/** Trimmed full title supplied to an issue search, when classified. */
	searchText?: string;
	/** Trimmed human identifier supplied to an issue view, when classified. */
	issueIdentifier?: string;
}

export function classifyOperations(
	condition: Condition,
	calls: readonly ParsedToolCall[],
	resolvedAxiBin = "magi-linear-axi",
): ObservedOperation[] {
	return calls.map((call, callIndex) => {
		const classified = condition === "axi"
			? classifyAxiCall(call, resolvedAxiBin)
			: classifyMcpCall(call);
		return {
			kind: classified.kind,
			condition,
			callIndex,
			...(call.id ? { toolUseId: call.id } : {}),
			...(classified.operand !== undefined
				? { operand: classified.operand }
				: {}),
			...(classified.searchText !== undefined
				? { searchText: classified.searchText }
				: {}),
			...(classified.issueIdentifier !== undefined
				? { issueIdentifier: classified.issueIdentifier }
				: {}),
		};
	});
}

export function operationTraceMatches(
	required: readonly { kind: BenchmarkOperationKind }[],
	observed: readonly { kind: ObservedOperationKind }[],
): boolean {
	return (
		required.length === observed.length &&
		required.every((operation, index) => operation.kind === observed[index]?.kind)
	);
}

function exactOperandMatches(
	actual: string | undefined,
	expected: string,
): boolean {
	return actual !== undefined && actual.trim() === expected.trim();
}

function resultContainsValues(
	results: readonly ParsedToolResult[],
	values: readonly string[],
): boolean {
	const expected = values.map((value) => value.trim());
	if (expected.some((value) => value.length === 0)) return false;
	return results
		.filter((result) => !result.isError)
		.some((result) => expected.every((value) => result.text.includes(value)));
}

function issueScopedNotFound(value: string): boolean {
	if (
		/\b(?:permission|forbidden|unauthori[sz]ed|access[\s-]+denied|not[\s-]+visible|not[\s-]+permitted)\b/iu.test(
			value,
		)
	) {
		return false;
	}
	return (
		/\bissue\b[\s\S]{0,96}\bnot[\s-]+found\b/iu.test(value) ||
		/\bissue\b[\s\S]{0,96}\b(?:does[\s-]+not|doesn['’]t)[\s-]+exist\b/iu.test(
			value,
		) ||
		/\bno[\s-]+such[\s-]+issue\b/iu.test(value) ||
		/\bentity[\s-]+not[\s-]+found\s*:\s*issue\b/iu.test(value) ||
		/\bcould[\s-]+not\s+find[\s-]+referenced[\s-]+issue\b/iu.test(value) ||
		/\bnot[\s-]+found\b[\s\S]{0,96}\bissue\b/iu.test(value)
	);
}

function expectedIssueNotFound(
	requirement: RequiredOperation,
	results: readonly ParsedToolResult[],
): boolean {
	return (
		requirement.operand !== undefined &&
		requirement.kind === "issue_view" &&
		requirement.expectedError === "issue_not_found" &&
		results.length > 0 &&
		results.every((result) => result.isError && issueScopedNotFound(result.text))
	);
}

function requiredOperationMatches(
	requirement: RequiredOperation,
	operation: ObservedOperation,
	results: readonly ParsedToolResult[],
): boolean {
	if (
		requirement.operand !== undefined &&
		!exactOperandMatches(operation.operand, requirement.operand)
	) {
		return false;
	}
	if (requirement.expectedError !== undefined) {
		return expectedIssueNotFound(requirement, results);
	}
	return (
		results.some((result) => !result.isError) &&
		resultContainsValues(results, requirement.requiredResultValues ?? [])
	);
}

/**
 * Checks operands and linked result semantics after the exact kind/order
 * trace has matched. Each required result value must come from the same
 * linked non-error result as the operation; an unlinked result cannot satisfy
 * a requirement.
 */
export function operationRequirementsMatch(
	required: readonly RequiredOperation[],
	observed: readonly ObservedOperation[],
	linkedResults: ReadonlyMap<string, readonly ParsedToolResult[]>,
): boolean {
	if (!operationTraceMatches(required, observed)) return false;
	return required.every((requirement, index) => {
		const operation = observed[index];
		if (!operation) return false;
		const results = operation.toolUseId
			? linkedResults.get(operation.toolUseId) ?? []
			: [];
		return requiredOperationMatches(requirement, operation, results);
	});
}
