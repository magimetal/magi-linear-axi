import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINEAR_GRAPHQL_ENDPOINT } from "./graphql.js";
import { redactSecrets, toolCall } from "./safety.js";
import type {
	ClaudeUsage,
	Condition,
	ParsedClaudeStream,
	ParsedToolCall,
	ParsedToolResult,
	PhaseKey,
	PhaseMetrics,
	PhaseSize,
} from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CLAUDE_BIN = "claude";
export const LINEAR_READONLY_MCP_URL = "https://mcp.linear.app/mcp/readonly";

export interface ClaudeCommandOptions {
	condition: Condition | "judge";
	model: string;
	prompt: string;
	mcpConfigPath?: string;
	/** Absolute per-case AXI broker wrapper used for command-scoped Bash permission. */
	axiBin?: string;
}

export interface ClaudeExecutionOptions extends ClaudeCommandOptions {
	claudeBin?: string;
	cwd: string;
	environment?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	redactionSecrets?: readonly string[];
}

export interface ClaudeExecution {
	stdout: string;
	stderr: string;
	parsed: ParsedClaudeStream;
	commandError?: string;
	claudeProcessLifetimeMs?: number;
	streamParseMs?: number;
}

export interface McpConfigHandle {
	directory: string;
	filePath: string;
	cleanup: () => Promise<void>;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function contentItems(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(objectValue) : [];
}

function contentFromMessage(
	event: Record<string, unknown>,
): Record<string, unknown>[] {
	const message = objectValue(event.message);
	if (Array.isArray(message.content)) {
		return contentItems(message.content);
	}
	if (Array.isArray(event.content)) {
		return contentItems(event.content);
	}
	return [];
}

function toolKind(name: string): ParsedToolCall["kind"] {
	if (name.toLowerCase() === "bash") {
		return "bash";
	}
	if (name.toLowerCase().startsWith("mcp__")) {
		return "mcp";
	}
	return "other";
}

function addUsage(
	target: ClaudeUsage,
	coverage: { outputTokens: boolean },
	value: unknown,
): void {
	const usage = objectValue(value);
	const inputTokens = numberValue(usage.input_tokens);
	const cacheRead = numberValue(usage.cache_read_input_tokens);
	const cacheCreation = numberValue(usage.cache_creation_input_tokens);
	const outputTokens = numberValue(usage.output_tokens);
	if (inputTokens !== undefined) target.inputTokens += inputTokens;
	if (cacheRead !== undefined) target.cacheReadInputTokens += cacheRead;
	if (cacheCreation !== undefined) target.cacheCreationInputTokens += cacheCreation;
	if (outputTokens !== undefined) {
		target.outputTokens += outputTokens;
		coverage.outputTokens = true;
		target.outputTokensCovered = true;
	}
}

function setFinalUsage(
	target: ClaudeUsage,
	coverage: { outputTokens: boolean },
	value: unknown,
): void {
	const usage = objectValue(value);
	const inputTokens = numberValue(usage.input_tokens);
	const cacheRead = numberValue(usage.cache_read_input_tokens);
	const cacheCreation = numberValue(usage.cache_creation_input_tokens);
	const outputTokens = numberValue(usage.output_tokens);
	if (inputTokens !== undefined) target.inputTokens = inputTokens;
	if (cacheRead !== undefined) target.cacheReadInputTokens = cacheRead;
	if (cacheCreation !== undefined) target.cacheCreationInputTokens = cacheCreation;
	if (outputTokens !== undefined) {
		target.outputTokens = outputTokens;
		target.outputTokensCovered = true;
		coverage.outputTokens = true;
	}
}

function phaseSize(text: string): PhaseSize {
	return {
		codePoints: [...text].length,
		utf8Bytes: Buffer.byteLength(text, "utf8"),
	};
}

function buildPhaseMetrics(options: {
	toolCalls: readonly ParsedToolCall[];
	toolArgumentsMalformed: boolean;
	toolResults: readonly ParsedToolResult[];
	toolResultsMalformed: boolean;
	assistantMessages: readonly string[];
	deltaText?: string;
	terminalText?: string;
	thinkingText?: string;
	streamMalformed: boolean;
}): PhaseMetrics {
	const metrics: PhaseMetrics = { coverage: [] };
	const add = (key: PhaseKey, text: string | undefined): void => {
		if (text === undefined) return;
		metrics[key] = phaseSize(text);
		metrics.coverage.push(key);
	};
	if (options.streamMalformed) return metrics;

	if (!options.toolArgumentsMalformed && options.toolCalls.length > 0) {
		add(
			"assistantToolArguments",
			options.toolCalls.map((call) => JSON.stringify(call.input) ?? "").join(""),
		);
	}

	if (options.terminalText !== undefined) {
		const messages = [...options.assistantMessages];
		let duplicateIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index] === options.terminalText) {
				duplicateIndex = index;
				break;
			}
		}
		if (duplicateIndex >= 0) messages.splice(duplicateIndex, 1);
		let preterminal = messages.join("");
		if (!preterminal && options.deltaText?.endsWith(options.terminalText)) {
			preterminal = options.deltaText.slice(0, -options.terminalText.length);
		}
		add("visibleAssistantTextBeforeTerminal", preterminal);
		add("terminalAnswerText", options.terminalText);
	}

	add("thinkingReasoning", options.thinkingText);

	if (!options.toolResultsMalformed && options.toolResults.length > 0) {
		const toolIds = new Set(
			options.toolCalls.flatMap((call) => call.id ? [call.id] : []),
		);
		const linked = options.toolResults.filter((result) => toolIds.has(result.toolUseId));
		if (linked.length > 0) {
			add("linkedToolResultText", linked.map((result) => result.text).join(""));
		}
	}
	return metrics;
}

function mergeInputs(existing: unknown, incoming: unknown): unknown {
	if (incoming === undefined) {
		return existing ?? {};
	}
	if (
		existing &&
		typeof existing === "object" &&
		!Array.isArray(existing) &&
		incoming &&
		typeof incoming === "object" &&
		!Array.isArray(incoming)
	) {
		return {
			...(existing as Record<string, unknown>),
			...(incoming as Record<string, unknown>),
		};
	}
	return incoming;
}

function contentText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => {
				const record = objectValue(item);
				return textValue(record.text) ?? contentText(record.content);
			})
			.join("");
	}
	if (value && typeof value === "object") {
		const record = objectValue(value);
		return textValue(record.text) ?? contentText(record.content);
	}
	return "";
}

function parsedToolResult(
	item: Record<string, unknown>,
): ParsedToolResult | undefined {
	const toolUseId = textValue(item.tool_use_id);
	if (!toolUseId) {
		return undefined;
	}
	return {
		toolUseId,
		text: contentText(item.content ?? item.text),
		isError: item.is_error === true,
	};
}

/** Parses Claude Code stream-json without assuming a particular event ordering. */
export function parseClaudeStream(raw: string): ParsedClaudeStream {
	const usage: ClaudeUsage = {
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		outputTokensCovered: false,
	};
	const usageCoverage = { outputTokens: false };
	const toolCalls: ParsedToolCall[] = [];
	const toolCallsById = new Map<string, ParsedToolCall>();
	const pendingInputJson = new Map<string, string>();
	const toolBlockIds = new Map<number, string>();
	const toolResultsById = new Map<string, ParsedToolResult>();
	const assistantMessages: string[] = [];
	const deltaTexts: string[] = [];
	const completeThinkingTexts: string[] = [];
	const deltaThinkingTexts: string[] = [];
	const errors: string[] = [];
	let parseErrors = 0;
	let resultText: string | undefined;
	let resultEvents = 0;
	let terminalStatus: ParsedClaudeStream["terminalStatus"] = "missing";
	let turns: number | undefined;
	let durationMs: number | undefined;
	let resultUsage: unknown;
	let resultCost: number | undefined;
	let lastToolBlockId: string | undefined;
	let toolArgumentsMalformed = false;
	let toolResultsMalformed = false;
	let streamMalformed = false;

	const addTool = (item: Record<string, unknown>): void => {
		const name = textValue(item.name);
		const id = textValue(item.id) ?? textValue(item.tool_use_id);
		if (id && toolCallsById.has(id)) {
			const existing = toolCallsById.get(id);
			if (existing) {
				existing.input = mergeInputs(
					existing.input,
					item.input ?? item.arguments,
				);
				if (name && existing.name === "unknown") {
					existing.name = name;
					existing.kind = toolKind(name);
				}
			}
			return;
		}
		if (!name) {
			toolArgumentsMalformed = true;
			if (id) {
				parseErrors += 1;
				errors.push("Claude Code emitted a tool use without a name");
			}
			return;
		}
		const input = item.input ?? item.arguments ?? {};
		const parsed = toolCall(name, input, id);
		parsed.kind = toolKind(name);
		toolCalls.push(parsed);
		if (id) {
			toolCallsById.set(id, parsed);
			lastToolBlockId = id;
			const pending = pendingInputJson.get(id);
			if (pending) {
				try {
					parsed.input = mergeInputs(
						parsed.input,
						JSON.parse(pending) as unknown,
					);
					pendingInputJson.delete(id);
				} catch {
					// The stream may split a JSON object across more deltas. Keep it pending.
				}
			}
		}
	};

	const addToolInputDelta = (streamEvent: Record<string, unknown>): void => {
		const index = numberValue(streamEvent.index);
		const id =
			(index !== undefined ? toolBlockIds.get(index) : undefined) ??
			lastToolBlockId;
		const delta = objectValue(streamEvent.delta);
		const partialJson = textValue(delta.partial_json);
		if (!partialJson || !id) {
			if (!id && partialJson) {
				toolArgumentsMalformed = true;
				parseErrors += 1;
				errors.push("Claude Code emitted an input delta without a tool use id");
			}
			return;
		}
		const combined = `${pendingInputJson.get(id) ?? ""}${partialJson}`;
		pendingInputJson.set(id, combined);
		try {
			const parsedInput: unknown = JSON.parse(combined);
			const tool = toolCallsById.get(id);
			if (tool) {
				tool.input = mergeInputs(tool.input, parsedInput);
			}
			pendingInputJson.delete(id);
		} catch {
			// Wait for the rest of the JSON object.
		}
	};

	const addToolResult = (item: Record<string, unknown>): void => {
		const result = parsedToolResult(item);
		if (!result) {
			toolResultsMalformed = true;
			parseErrors += 1;
			errors.push("Claude Code emitted a malformed tool result");
			return;
		}
		const existing = toolResultsById.get(result.toolUseId);
		if (existing) {
			existing.text = result.text || existing.text;
			existing.isError = existing.isError || result.isError;
		} else {
			toolResultsById.set(result.toolUseId, result);
		}
		if (result.isError) {
			errors.push("Claude Code returned a tool error");
		}
	};

	for (const line of raw.split(/\r?\n/u)) {
		if (!line.trim()) {
			continue;
		}
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				streamMalformed = true;
				parseErrors += 1;
				continue;
			}
			event = parsed as Record<string, unknown>;
		} catch {
			streamMalformed = true;
			parseErrors += 1;
			continue;
		}
		const eventType = textValue(event.type);
		const message = objectValue(event.message);
		if (
			eventType === "assistant" &&
			!Array.isArray(message.content) &&
			!Array.isArray(event.content)
		) {
			streamMalformed = true;
			parseErrors += 1;
		}
		addUsage(usage, usageCoverage, message.usage);
		addUsage(usage, usageCoverage, event.usage);

		const items = contentFromMessage(event);
		let assistantMessageText: string | undefined;
		for (const item of items) {
			const itemType = textValue(item.type);
			if (itemType === "tool_use") {
				addTool(item);
			} else if (itemType === "tool_result") {
				addToolResult(item);
			} else if (eventType === "assistant" && itemType === "text") {
				const text = textValue(item.text);
				if (text === undefined) {
					streamMalformed = true;
					parseErrors += 1;
				} else {
					assistantMessageText = `${assistantMessageText ?? ""}${text}`;
				}
			} else if (eventType === "assistant" && itemType === "thinking") {
				const thinking = textValue(item.thinking) ?? textValue(item.text);
				if (thinking === undefined) {
					streamMalformed = true;
					parseErrors += 1;
				} else {
					completeThinkingTexts.push(thinking);
				}
			}
		}
		if (assistantMessageText !== undefined) {
			assistantMessages.push(assistantMessageText);
		}

		if (eventType === "stream_event") {
			const streamEvent = objectValue(event.event);
			const streamType = textValue(streamEvent.type);
			const index = numberValue(streamEvent.index);
			if (streamType === "content_block_start") {
				const contentBlock = objectValue(streamEvent.content_block);
				const blockType = textValue(contentBlock.type);
				if (blockType === "tool_use") {
					const id = textValue(contentBlock.id);
					if (id && index !== undefined) toolBlockIds.set(index, id);
					addTool(contentBlock);
				} else if (blockType === "thinking") {
					const thinking = textValue(contentBlock.thinking);
					if (thinking !== undefined) completeThinkingTexts.push(thinking);
				}
			} else if (streamType === "content_block_delta") {
				const delta = objectValue(streamEvent.delta);
				const deltaType = textValue(delta.type);
				if (deltaType === "thinking_delta") {
					const thinking = textValue(delta.thinking);
					if (thinking === undefined) {
						streamMalformed = true;
						parseErrors += 1;
					} else {
						deltaThinkingTexts.push(thinking);
					}
				} else if (deltaType === "input_json_delta") {
					addToolInputDelta(streamEvent);
				} else {
					const text = textValue(delta.text);
					if (deltaType === "text_delta" && text === undefined) {
						streamMalformed = true;
						parseErrors += 1;
					} else if (text !== undefined) {
						deltaTexts.push(text);
					}
				}
			}
		}

		if (eventType === "tool_use") addTool(event);
		if (eventType === "tool_result") addToolResult(event);
		if (eventType === "result") {
			resultEvents += 1;
			const result = event.result;
			if (typeof result === "string") {
				resultText = result;
			} else {
				streamMalformed = true;
				parseErrors += 1;
			}
			resultUsage = event.usage;
			const eventTurns = numberValue(event.num_turns);
			if (eventTurns !== undefined) turns = eventTurns;
			const eventDuration = numberValue(event.duration_ms);
			if (eventDuration !== undefined) durationMs = eventDuration;
			const cost = numberValue(event.total_cost_usd) ?? numberValue(event.cost_usd);
			if (cost !== undefined) resultCost = cost;
			const subtype = textValue(event.subtype);
			if (resultEvents === 1) {
				terminalStatus = subtype === "success" ? "success" : "non_success";
			} else {
				terminalStatus = "non_success";
			}
			if (subtype !== "success") {
				errors.push(
					subtype === undefined
						? "Claude Code returned a result without a success subtype"
						: "Claude Code returned a non-success result",
				);
			}
		}
		if (eventType === "error" || event.error) {
			errors.push("Claude Code emitted an error event");
		}
	}

	if (pendingInputJson.size > 0) {
		toolArgumentsMalformed = true;
		parseErrors += pendingInputJson.size;
		errors.push("Claude Code ended with incomplete tool input JSON");
	}
	if (resultUsage !== undefined) {
		setFinalUsage(usage, usageCoverage, resultUsage);
	}
	if (resultCost !== undefined) usage.reportedCostUsd = resultCost;
	if (resultEvents > 1) {
		streamMalformed = true;
		terminalStatus = "non_success";
		errors.push("Claude Code emitted multiple result events");
	}
	const finalAnswer = resultText ??
		(deltaTexts.length > 0 ? deltaTexts.join("") : assistantMessages.join("\n"));
	const parsedToolResults = [...toolResultsById.values()];
	const thinkingText = completeThinkingTexts.length > 0
		? completeThinkingTexts.join("")
		: deltaThinkingTexts.length > 0
			? deltaThinkingTexts.join("")
			: undefined;
	return {
		finalAnswer,
		toolCalls,
		toolResults: parsedToolResults,
		usage,
		usageCoverage,
		phaseMetrics: buildPhaseMetrics({
			toolCalls,
			toolArgumentsMalformed,
			toolResults: parsedToolResults,
			toolResultsMalformed,
			assistantMessages,
			...(deltaTexts.length > 0 ? { deltaText: deltaTexts.join("") } : {}),
			...(resultText !== undefined ? { terminalText: resultText } : {}),
			...(thinkingText !== undefined ? { thinkingText } : {}),
			streamMalformed,
		}),
		turns: turns ?? assistantMessages.length,
		...(durationMs !== undefined ? { durationMs } : {}),
		errors,
		parseErrors,
		terminalStatus,
		terminalAnswerObserved: resultText !== undefined,
	};
}

export function buildClaudeArgs(options: ClaudeCommandOptions): string[] {
	const args = [
		"--print",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		options.model,
		"--setting-sources",
		"",
		"--no-session-persistence",
		"--disable-slash-commands",
	];
	if (options.condition === "axi") {
		args.push(
			"--tools",
			"Bash",
			"--allowedTools",
			options.axiBin ? `Bash(${options.axiBin}:*)` : "Bash",
		);
		if (options.mcpConfigPath) {
			args.push("--strict-mcp-config", "--mcp-config", options.mcpConfigPath);
		}
	} else if (options.condition === "mcp") {
		if (!options.mcpConfigPath) {
			throw new Error("MCP condition requires an ephemeral MCP config path");
		}
		args.push(
			"--tools",
			"",
			"--strict-mcp-config",
			"--mcp-config",
			options.mcpConfigPath,
			"--allowedTools",
			"mcp__linear__*",
			"--disallowedTools",
			"Bash",
		);
	} else {
		args.push("--tools", "");
	}
	// Claude's tool-list flags are variadic and otherwise consume the positional prompt.
	args.push("--", options.prompt);
	return args;
}

const SAFE_ENVIRONMENT_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"COLORTERM",
	"TERM_PROGRAM",
	"COLUMNS",
	"LINES",
	"NO_COLOR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function buildClaudeEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	condition: Condition | "judge" = "judge",
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	if (condition !== "judge") {
		environment.LINEAR_API_URL = LINEAR_GRAPHQL_ENDPOINT;
	}
	// AXI credentials live only in the per-case Unix-socket broker. Never copy
	// an inherited or caller-supplied key into Claude's AXI process environment.
	if (condition === "mcp" && source.LINEAR_API_KEY !== undefined) {
		environment.LINEAR_API_KEY = source.LINEAR_API_KEY;
	}
	return environment;
}

const POST_KILL_GRACE_MS = 500;

function killClaudeProcessTree(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			// A detached Unix child is the process-group leader. Negative PID sends
			// SIGKILL to the leader and every descendant in that group.
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through when the group has already disappeared or cannot be
			// addressed, then make the direct-child kill attempt.
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// The process may have exited between the group and direct kill attempts.
	}
}

export async function executeClaude(
	options: ClaudeExecutionOptions,
): Promise<ClaudeExecution> {
	const command = options.claudeBin ?? DEFAULT_CLAUDE_BIN;
	const args = buildClaudeArgs(options);
	const sourceEnvironment = { ...process.env, ...(options.environment ?? {}) };
	const environment = buildClaudeEnvironment(
		sourceEnvironment,
		options.condition,
	);
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
	const processStarted = performance.now();
	let stdout = "";
	let stderr = "";
	let commandError: string | undefined;
	let processDurationMs = 0;
	let result: { exitCode?: number; signal?: string };
	try {
		result = await new Promise<{ exitCode?: number; signal?: string }>(
			(resolve) => {
				const child = spawn(command, args, {
					cwd: options.cwd,
					env: environment,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					...(process.platform !== "win32" ? { detached: true } : {}),
				});
				let settled = false;
				let timedOut = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let postKillGrace: ReturnType<typeof setTimeout> | undefined;
				const clearTimers = (): void => {
					if (timer !== undefined) {
						clearTimeout(timer);
					}
					if (postKillGrace !== undefined) {
						clearTimeout(postKillGrace);
					}
				};
				const settle = (value: { exitCode?: number; signal?: string }): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimers();
					resolve(value);
				};
				const forceTimeoutSettlement = (): void => {
					if (settled) {
						return;
					}
					// A descendant can retain inherited stdout/stderr after the direct
					// child dies. Destroy both streams so close cannot block forever.
					killClaudeProcessTree(child);
					child.stdout?.destroy();
					child.stderr?.destroy();
					child.unref();
					settle({ signal: "SIGKILL" });
				};
				timer = setTimeout(() => {
					if (settled) {
						return;
					}
					timedOut = true;
					commandError = "Claude Code process exceeded the benchmark timeout";
					killClaudeProcessTree(child);
					postKillGrace = setTimeout(
						forceTimeoutSettlement,
						POST_KILL_GRACE_MS,
					);
				}, timeoutMs);
				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => {
					stdout += chunk;
				});
				child.stderr?.on("data", (chunk: string) => {
					stderr += chunk;
				});
				child.once("error", (error) => {
					if (timedOut) {
						return;
					}
					commandError = `Claude Code could not be started: ${error.message}`;
					settle({});
				});
				child.once("close", (exitCode, signal) => {
					if (timedOut) {
						settle({ signal: signal ?? "SIGKILL" });
						return;
					}
					settle({
						...(exitCode !== null ? { exitCode } : {}),
						...(signal !== null ? { signal } : {}),
					});
				});
			},
		);
	} catch (error: unknown) {
		commandError = `Claude Code process failed: ${error instanceof Error ? error.message : "unknown error"}`;
		result = {};
	}
	processDurationMs = performance.now() - processStarted;
	const secrets = options.redactionSecrets ?? [];
	const parseStarted = performance.now();
	const rawPhaseMetrics = parseClaudeStream(stdout).phaseMetrics;
	stdout = redactSecrets(stdout, secrets);
	stderr = redactSecrets(stderr, secrets);
	const parsed = parseClaudeStream(stdout);
	parsed.phaseMetrics = rawPhaseMetrics;
	const streamParseDurationMs = performance.now() - parseStarted;
	if (result.exitCode !== undefined) {
		parsed.exitCode = result.exitCode;
	}
	if (result.signal !== undefined) {
		parsed.signal = result.signal;
	}
	if (commandError) {
		parsed.errors.push(commandError);
	}
	return {
		stdout,
		stderr,
		parsed,
		claudeProcessLifetimeMs: processDurationMs,
		streamParseMs: streamParseDurationMs,
		...(commandError ? { commandError } : {}),
	};
}

async function createConfigFile(config: unknown): Promise<McpConfigHandle> {
	const directory = await mkdtemp(join(tmpdir(), "linear-benchmark-mcp-"));
	const filePath = join(directory, "mcp.json");
	await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	return {
		directory,
		filePath,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}

export async function createMcpConfig(
	url = LINEAR_READONLY_MCP_URL,
): Promise<McpConfigHandle> {
	if (!isReadOnlyLinearMcpUrl(url)) {
		throw new Error(
			"MCP benchmark config must use the exact Linear read-only endpoint",
		);
	}
	return createConfigFile({
		mcpServers: {
			linear: {
				type: "http",
				url,
				alwaysLoad: true,
				headers: {
					Authorization: "Bearer ${LINEAR_API_KEY}",
				},
			},
		},
	});
}

export function createEmptyMcpConfig(): Promise<McpConfigHandle> {
	return createConfigFile({ mcpServers: {} });
}

export function isReadOnlyLinearMcpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "mcp.linear.app" &&
			parsed.port === "" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.pathname === "/mcp/readonly" &&
			parsed.search === "" &&
			parsed.hash === ""
		);
	} catch {
		return false;
	}
}
