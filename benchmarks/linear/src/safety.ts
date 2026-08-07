import { parseAxiArgv, axiCommandPath } from "./axi-argv.js";
import { assertQueryOnly, GraphqlSafetyError } from "./graphql.js";
import { commandInput, parseShellCommand } from "./operations.js";
import { parsedToolCallKind } from "./types.js";
import type {
	Condition,
	ParsedToolCall,
	PolicyIncident,
	SafetyViolation,
} from "./types.js";

export class ReadOnlyContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReadOnlyContractError";
	}
}

export function assertLiveReadOnlyContract(
	confirmReadOnly: boolean,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const apiKey = environment.LINEAR_API_KEY?.trim();
	if (!apiKey) {
		throw new ReadOnlyContractError(
			"LINEAR_API_KEY is required for live benchmark commands",
		);
	}
	if (!confirmReadOnly) {
		throw new ReadOnlyContractError(
			"live benchmark commands require explicit --confirm-read-only",
		);
	}
	if (environment.LINEAR_BENCHMARK_READ_ONLY !== "1") {
		throw new ReadOnlyContractError(
			"set LINEAR_BENCHMARK_READ_ONLY=1 before running any live benchmark command",
		);
	}
	return apiKey;
}

function looksLikeToken(value: string): boolean {
	return /lin_api_[A-Za-z0-9_-]{8,}/u.test(value);
}

/** Redacts supplied keys and common Linear bearer-token shapes before persistence. */
export function redactSecrets(
	value: string,
	secrets: readonly string[] = [],
): string {
	let redacted = value;
	for (const secret of secrets) {
		if (secret.length > 0) {
			redacted = redacted.split(secret).join("[REDACTED_LINEAR_API_KEY]");
		}
	}
	redacted = redacted.replace(
		/lin_api_[A-Za-z0-9_-]{8,}/gu,
		"[REDACTED_LINEAR_API_KEY]",
	);
	redacted = redacted.replace(
		/(Bearer\s+)([^\s"']+)/giu,
		(_match, prefix: string, token: string) =>
			looksLikeToken(token)
				? `${prefix}[REDACTED_LINEAR_API_KEY]`
				: `${prefix}[REDACTED]`,
	);
	return redacted;
}

function inputText(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	try {
		return JSON.stringify(input) ?? "";
	} catch {
		return "";
	}
}

export function toolCall(
	name: string,
	input: unknown,
	id?: string,
): ParsedToolCall {
	const call: ParsedToolCall = { name, input, kind: parsedToolCallKind(name) };
	if (id) {
		call.id = id;
	}
	return call;
}

function identifierTokens(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.split(/[^A-Za-z0-9]+/u)
		.map((token) => token.toLowerCase())
		.filter(Boolean);
}

const AXI_WRITE_OPERATIONS = new Set([
	"create",
	"update",
	"delete",
	"start",
	"attach",
	"link",
	"archive",
	"unarchive",
	"add",
	"remove",
	"add-project",
	"remove-project",
	"c",
	"u",
	"d",
]);
type AuditFinding = {
	severity: "safety" | "policy";
	source: SafetyViolation["source"];
	operation: string;
	message: string;
};

function policyIncident(
	message: string,
	operation: string,
	source: PolicyIncident["source"] = "tool-policy",
): PolicyIncident {
	return { source, operation, message };
}

function hardSafety(
	message: string,
	operation: string,
	source: SafetyViolation["source"],
): SafetyViolation {
	return { source, operation, message };
}

function hasRawGraphqlMutation(
	tokens: readonly string[],
	apiIndex: number,
): boolean {
	const valueFlags = new Set(["--format", "--variable", "--variables-json"]);
	const argumentsAfterApi: string[] = [];
	const rawArguments = tokens.slice(apiIndex + 1);
	for (let index = 0; index < rawArguments.length; index += 1) {
		const token = rawArguments[index];
		if (valueFlags.has(token.toLowerCase())) {
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			continue;
		}
		argumentsAfterApi.push(token);
	}
	const document = argumentsAfterApi.join(" ");
	try {
		assertQueryOnly(document);
		return false;
	} catch (error: unknown) {
		if (
			error instanceof GraphqlSafetyError &&
			/operation '(?:mutation|subscription)'/iu.test(error.message)
		) {
			return true;
		}
		return false;
	}
}

function axiPathViolation(
	firstSegment: readonly string[],
	resolvedAxiBin: string,
): string | undefined {
	const binary = firstSegment[0];
	if (!binary || binary !== resolvedAxiBin) {
		return `Bash command must invoke the resolved AXI binary (${resolvedAxiBin})`;
	}
	return undefined;
}

function axiOperationFinding(
	firstSegment: readonly string[],
): AuditFinding | undefined {
	const source = "axi-bash" as const;
	if (
		firstSegment.some((token) => {
			const normalized = token.toLowerCase();
			return normalized.startsWith("--endpoint");
		})
	) {
		return {
			severity: "safety",
			source,
			operation: "endpoint override",
			message:
				"explicit --endpoint override is forbidden; the benchmark owns the endpoint",
		};
	}
	if (firstSegment.length === 1) {
		return {
			severity: "policy",
			source,
			operation: "unrecognized AXI operation",
			message: "the AXI operation was not a recognized bounded read",
		};
	}
	const parsed = parseAxiArgv(firstSegment.slice(1));
	if (parsed.ok && (parsed.help || parsed.version || parsed.operation !== undefined)) {
		return undefined;
	}
	if (
		!parsed.ok &&
		firstSegment.some((token) => token === "--help" || token === "-h" || token === "--version" || token === "-V")
	) {
		return {
			severity: "policy",
			source,
			operation: "unrecognized AXI operation",
			message: "the AXI operation was not a recognized bounded read",
		};
	}
	const path = axiCommandPath(firstSegment);
	const family = path[0];
	const operation = path[1];
	if (!family || family === "help" || family === "version") {
		return {
			severity: "policy",
			source,
			operation: "unrecognized AXI operation",
			message: "the AXI operation was not a recognized bounded read",
		};
	}
	if (family === "setup" || family === "config") {
		return {
			severity: "safety",
			source,
			operation: "local-mutating AXI operation",
			message: "AXI setup/config operations are local mutations and are forbidden",
		};
	}
	if (family === "auth") {
		return operation === "whoami"
			? {
					severity: "policy",
					source,
					operation: "unrecognized AXI operation",
					message: "the AXI operation was not a recognized bounded read",
				}
			: {
					severity: "safety",
					source,
					operation: "local-mutating AXI authentication operation",
					message: "AXI authentication writes are forbidden",
				};
	}
	if (family === "schema") {
		return {
			severity: "safety",
			source,
			operation: "AXI schema output",
			message: "AXI schema operations are outside the benchmark read guide",
		};
	}
	if (family === "api") {
		const apiIndex = firstSegment.findIndex(
			(token) => token.toLowerCase() === "api",
		);
		if (apiIndex >= 0 && hasRawGraphqlMutation(firstSegment, apiIndex)) {
			return {
				severity: "safety",
				source,
				operation: "raw GraphQL mutation",
				message: "raw GraphQL mutations are forbidden",
			};
		}
		return {
			severity: "policy",
			source,
			operation: "unrecognized raw AXI API operation",
			message: "the AXI API command was not a recognized bounded read",
		};
	}
	if (AXI_WRITE_OPERATIONS.has(operation ?? "")) {
		return {
			severity: "safety",
			source,
			operation: "write-shaped AXI operation",
			message: "AXI write-shaped operations are forbidden",
		};
	}
	if (operation === "comment" || operation === "relation") {
		const nested = path[2];
		if (nested && AXI_WRITE_OPERATIONS.has(nested)) {
			return {
				severity: "safety",
				source,
				operation: "write-shaped AXI operation",
				message: "AXI comment/relation writes are forbidden",
			};
		}
		return {
			severity: "policy",
			source,
			operation: "unrecognized AXI operation",
			message: "the AXI operation was not a recognized bounded read",
		};
	}
	return {
		severity: "policy",
		source,
		operation: "unrecognized AXI operation",
		message: "the AXI operation was not a recognized bounded read",
	};
}

function mcpWriteShape(name: string, input: unknown): string | undefined {
	const nameTokens = identifierTokens(name.replace(/^mcp__linear__/u, ""));
	const mutationVerbs = new Set([
		"create",
		"update",
		"delete",
		"archive",
		"unarchive",
		"add",
		"remove",
		"start",
		"attach",
		"link",
	]);
	if (nameTokens.some((token) => mutationVerbs.has(token))) {
		return "write-shaped MCP tool";
	}
	const text = inputText(input);
	if (/\bmutation(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\{/iu.test(text)) {
		return "raw GraphQL mutation";
	}
	if (input && typeof input === "object") {
		for (const [key, value] of Object.entries(
			input as Record<string, unknown>,
		)) {
			if (
				!/^(?:operation|action|method|mutation)$/iu.test(key) ||
				typeof value !== "string"
			) {
				continue;
			}
			const valueTokens = identifierTokens(value);
			if (valueTokens.some((token) => mutationVerbs.has(token))) {
				return /comment/iu.test(value)
					? "comment mutation"
					: "write-shaped MCP operation";
			}
		}
	}
	return undefined;
}

export interface TrajectoryAudit {
	safetyViolations: SafetyViolation[];
	policyIncidents: PolicyIncident[];
}

function addFinding(
	audit: TrajectoryAudit,
	finding: AuditFinding,
): void {
	if (finding.severity === "safety") {
		audit.safetyViolations.push({
			source: finding.source,
			operation: finding.operation,
			message: finding.message,
		});
	} else {
		audit.policyIncidents.push({
			source: finding.source,
			operation: finding.operation,
			message: finding.message,
		});
	}
}

/** Audits a complete trajectory and separates hard safety from local policy findings. */
export function scanTrajectory(
	condition: Condition,
	calls: readonly ParsedToolCall[],
	resolvedAxiBin = "magi-linear-axi",
): TrajectoryAudit {
	const audit: TrajectoryAudit = { safetyViolations: [], policyIncidents: [] };
	for (const call of calls) {
		if (call.kind === "structured_output") {
			continue;
		}
		if (condition === "axi") {
			if (call.kind !== "bash" || call.name.toLowerCase() !== "bash") {
				audit.safetyViolations.push(
					hardSafety(
						"AXI condition permits Bash only",
						"wrong tool",
						"tool-policy",
					),
				);
				continue;
			}
			const command = commandInput(call.input);
			if (!command || command.trim().length === 0) {
				audit.policyIncidents.push(
					policyIncident(
						"Bash input did not contain a command string",
						"missing Bash command",
					),
				);
				continue;
			}
			const parsed = parseShellCommand(command);
			if (parsed.unsafeOperator) {
				const malformed = parsed.unsafeOperator === "unterminated shell quote or escape";
				if (malformed) {
					audit.policyIncidents.push(
						policyIncident(
							`AXI Bash command was malformed: ${parsed.unsafeOperator}`,
							parsed.unsafeOperator,
							"axi-bash",
						),
					);
				} else {
					audit.safetyViolations.push(
						hardSafety(
							`AXI Bash command used execution-capable shell syntax: ${parsed.unsafeOperator}`,
							parsed.unsafeOperator,
							"axi-bash",
						),
					);
					// A hard shell escape is already a correctness override. Do not
					// reinterpret the remainder as an additional AXI operation.
					continue;
				}
			}
			const firstSegment = parsed.segments[0] ?? [];
			if (firstSegment.length === 0) {
				if (!parsed.unsafeOperator) {
					audit.policyIncidents.push(
						policyIncident("Bash command was empty", "empty Bash command", "axi-bash"),
					);
				}
				continue;
			}
			const binaryViolation = axiPathViolation(firstSegment, resolvedAxiBin);
			if (binaryViolation) {
				audit.safetyViolations.push(
				hardSafety(binaryViolation, "non-AXI executable", "axi-bash"),
			);
				continue;
			}
			const finding = axiOperationFinding(firstSegment);
			if (finding) {
				addFinding(audit, finding);
			}
			continue;
		}

		if (call.kind === "bash" || call.kind === "other") {
			audit.safetyViolations.push(
				hardSafety(
					"MCP condition permits only Linear MCP tools; Bash and other tools are forbidden",
					"wrong tool",
					"tool-policy",
				),
			);
			continue;
		}
		if (!/^mcp__linear__[A-Za-z0-9_]+$/u.test(call.name)) {
			audit.safetyViolations.push(
				hardSafety(
					"MCP condition permits only the configured Linear MCP server namespace",
					"wrong MCP namespace",
					"tool-policy",
				),
			);
			continue;
		}
		const writeShape = mcpWriteShape(call.name, call.input);
		if (writeShape) {
			audit.safetyViolations.push(
				hardSafety(
					"MCP trajectory contained a write-shaped operation",
					writeShape,
					"mcp-tool",
				),
			);
		}
	}
	return audit;
}

/** Alias retained for callers that use the audit terminology. */
export function scanAudit(
	condition: Condition,
	calls: readonly ParsedToolCall[],
	resolvedAxiBin = "magi-linear-axi",
): TrajectoryAudit {
	return scanTrajectory(condition, calls, resolvedAxiBin);
}

/** Backward-compatible wrapper that returns only hard safety findings. */
export function scanSafety(
	condition: Condition,
	calls: readonly ParsedToolCall[],
	resolvedAxiBin = "magi-linear-axi",
): SafetyViolation[] {
	return scanTrajectory(condition, calls, resolvedAxiBin).safetyViolations;
}
