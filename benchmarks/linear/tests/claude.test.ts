import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildClaudeArgs,
	buildClaudeEnvironment,
	createMcpConfig,
	executeClaude,
	isReadOnlyLinearMcpUrl,
	parseClaudeStream,
} from "../src/claude.js";
import { toolUseCounts } from "../src/grader.js";

const stream = [
	JSON.stringify({
		type: "assistant",
		message: {
			content: [
				{
					type: "tool_use",
					id: "bash-1",
					name: "Bash",
					input: { command: "magi-linear-axi issue view ENG-10" },
				},
			],
			usage: { input_tokens: 12, output_tokens: 3 },
		},
	}),
	JSON.stringify({
		type: "user",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: "bash-1",
					content: [{ type: "text", text: "ENG-10 Improve query latency" }],
					is_error: false,
				},
			],
		},
	}),
	JSON.stringify({
		type: "assistant",
		message: {
			content: [
				{
					type: "tool_use",
					id: "mcp-1",
					name: "mcp__linear__get_issue",
					input: { id: "ENG-10" },
				},
				{ type: "text", text: "The issue was read." },
			],
		},
	}),
	JSON.stringify({
		type: "stream_event",
		event: { type: "content_block_delta", delta: { text: "Final answer." } },
	}),
	JSON.stringify({
		type: "result",
		subtype: "success",
		result: "Final answer.",
		usage: {
			input_tokens: 100,
			cache_read_input_tokens: 20,
			cache_creation_input_tokens: 4,
			output_tokens: 30,
		},
		total_cost_usd: 0.0123,
		num_turns: 2,
		duration_ms: 450,
	}),
].join("\n");

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDescendantPid(
	pidFile: string,
	timeoutMs = 1_000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const pid = Number((await readFile(pidFile, "utf8")).trim());
			if (Number.isInteger(pid) && pid > 0) {
				return pid;
			}
		} catch {
			// The fixture may still be starting or writing the PID file.
		}
		await delay(10);
	}
	throw new Error(`timed out waiting for descendant PID file: ${pidFile}`);
}

async function waitForProcessExitWithEsrch(
	pid: number,
	timeoutMs = 1_000,
): Promise<"ESRCH"> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return "ESRCH";
			}
			throw error;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} still exists after timeout`);
}

describe("Claude stream-json backend", () => {
	it("extracts final answer, usage, turns, tool calls, and linked tool results", () => {
		const parsed = parseClaudeStream(stream);
		expect(parsed.finalAnswer).toBe("Final answer.");
		expect(parsed.terminalStatus).toBe("success");
		expect(parsed.toolCalls.map((call) => call.name)).toEqual([
			"Bash",
			"mcp__linear__get_issue",
		]);
		expect(parsed.toolResults).toEqual([
			{
				toolUseId: "bash-1",
				text: "ENG-10 Improve query latency",
				isError: false,
			},
		]);
		expect(toolUseCounts(parsed)).toEqual({ total: 2, bash: 1, mcp: 1 });
		expect(parsed.usage).toMatchObject({
			inputTokens: 100,
			cacheReadInputTokens: 20,
			cacheCreationInputTokens: 4,
			outputTokens: 30,
			reportedCostUsd: 0.0123,
		});
		expect(parsed.turns).toBe(2);
		expect(parsed.durationMs).toBe(450);
	});

	it("requires exactly one terminal success result event", () => {
		const missingSubtype = parseClaudeStream(
			JSON.stringify({ type: "result", result: "answer" }),
		);
		expect(missingSubtype.terminalStatus).toBe("non_success");
		expect(missingSubtype.errors).toContain(
			"Claude Code returned a result without a success subtype",
		);

		const noTerminal = parseClaudeStream(
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "answer" }] },
			}),
		);
		expect(noTerminal.terminalStatus).toBe("missing");

		const duplicateTerminal = parseClaudeStream(
			[
				JSON.stringify({ type: "result", subtype: "success", result: "first" }),
				JSON.stringify({
					type: "result",
					subtype: "success",
					result: "second",
				}),
			].join("\n"),
		);
		expect(duplicateTerminal.terminalStatus).toBe("non_success");
		expect(duplicateTerminal.errors).toContain(
			"Claude Code emitted multiple result events",
		);
	});

	it("merges a content-block start and input deltas into the later complete tool use", () => {
		const raw = [
			JSON.stringify({
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "bash-2",
						name: "Bash",
						input: {},
					},
				},
			}),
			JSON.stringify({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json: '{"command":"magi-linear-axi issue ',
					},
				},
			}),
			JSON.stringify({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: 'view ENG-11"}' },
				},
			}),
			JSON.stringify({
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "bash-2",
							name: "Bash",
							input: { command: "magi-linear-axi issue view ENG-11" },
						},
					],
				},
			}),
		].join("\n");
		const parsed = parseClaudeStream(raw);
		expect(parsed.terminalStatus).toBe("missing");
		expect(parsed.toolCalls).toHaveLength(1);
		expect(parsed.toolCalls[0]).toMatchObject({
			id: "bash-2",
			name: "Bash",
			input: { command: "magi-linear-axi issue view ENG-11" },
		});
	});

	it("marks unfinished streamed tool input as a parser failure", () => {
		const parsed = parseClaudeStream(
			[
				JSON.stringify({
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "bash-incomplete",
							name: "Bash",
							input: {},
						},
					},
				}),
				JSON.stringify({
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 0,
						delta: {
							type: "input_json_delta",
							partial_json: '{"command":"magi-linear-axi issue',
						},
					},
				}),
			].join("\n"),
		);
		expect(parsed.parseErrors).toBe(1);
		expect(parsed.terminalStatus).toBe("missing");
		expect(parsed.errors).toContain(
			"Claude Code ended with incomplete tool input JSON",
		);
	});

	it("preserves malformed and non-success tool-result evidence", () => {
		const parsed = parseClaudeStream(
			[
				JSON.stringify({
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: "mcp-2",
								name: "mcp__linear__get_issue",
								input: {},
							},
						],
					},
				}),
				JSON.stringify({
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "mcp-2",
								content: "Issue not found",
								is_error: true,
							},
						],
					},
				}),
				JSON.stringify({
					type: "user",
					message: {
						content: [
							{ type: "tool_result", content: "missing id", is_error: true },
						],
					},
				}),
			].join("\n"),
		);
		expect(parsed.toolResults).toEqual([
			{ toolUseId: "mcp-2", text: "Issue not found", isError: true },
		]);
		expect(parsed.terminalStatus).toBe("missing");
		expect(parsed.errors).toContain("Claude Code returned a tool error");
		expect(parsed.errors).toContain(
			"Claude Code emitted a malformed tool result",
		);
		expect(parsed.parseErrors).toBe(1);
	});

	it("builds isolated, restrictive condition arguments", () => {
		const axiArgs = buildClaudeArgs({
			condition: "axi",
			model: "claude-sonnet-4-6",
			prompt: "task",
			axiBin: "/tmp/magi-linear-axi",
		});
		expect(axiArgs).toContain("Bash");
		expect(axiArgs).toContain("Bash(/tmp/magi-linear-axi:*)");
		expect(axiArgs).toContain("--setting-sources");
		expect(axiArgs).toContain("");
		expect(axiArgs).toContain("--no-session-persistence");
		expect(axiArgs).toContain("--disable-slash-commands");
		expect(axiArgs.slice(-2)).toEqual(["--", "task"]);
		const mcpArgs = buildClaudeArgs({
			condition: "mcp",
			model: "claude-sonnet-4-6",
			prompt: "task",
			mcpConfigPath: "/tmp/mcp.json",
		});
		expect(mcpArgs).toContain("--strict-mcp-config");
		expect(mcpArgs).toContain("mcp__linear__*");
		expect(mcpArgs).toContain("--disallowedTools");
		expect(mcpArgs).toContain("Bash");
		expect(mcpArgs.slice(-2)).toEqual(["--", "task"]);
	});

	it("force-kills a Claude process that ignores the timeout signal", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "linear-benchmark-timeout-test-"),
		);
		const executable = join(directory, "stalled-claude");
		try {
			await writeFile(
				executable,
				"#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n",
			);
			await chmod(executable, 0o700);
			const startedAt = performance.now();
			const execution = await executeClaude({
				condition: "judge",
				model: "test-model",
				prompt: "test prompt",
				claudeBin: executable,
				cwd: directory,
				timeoutMs: 200,
			});
			expect(performance.now() - startedAt).toBeLessThan(3_000);
			expect(execution.commandError).toContain(
				"exceeded the benchmark timeout",
			);
			expect(execution.parsed.signal).toBe("SIGKILL");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("kills a same-group Claude descendant and bounds inherited-stdio cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}
		const directory = await mkdtemp(
			join(tmpdir(), "linear-benchmark-process-tree-test-"),
		);
		const executable = join(directory, "tree-claude");
		const descendantPidFile = join(directory, "descendant.pid");
		const nodeBinForShell = process.execPath.replaceAll("'", "'\\\"'\\\"'");
		const pidFileForShell = descendantPidFile.replaceAll("'", "'\\\"'\\\"'");
		let executionPromise: ReturnType<typeof executeClaude> | undefined;
		try {
			await writeFile(
				executable,
				`#!/bin/sh\n'${nodeBinForShell}' -e 'setInterval(() => {}, 1000)' &\ndescendant_pid=$!\nprintf '%s\\n' "$descendant_pid" > '${pidFileForShell}'\nwhile :; do :; done\n`,
			);
			await chmod(executable, 0o700);
			const startedAt = performance.now();
			executionPromise = executeClaude({
				condition: "judge",
				model: "test-model",
				prompt: "test prompt",
				claudeBin: executable,
				cwd: directory,
				timeoutMs: 1_000,
			});
			const descendantPid = await waitForDescendantPid(descendantPidFile, 2_000);
			const execution = await executionPromise;
			expect(performance.now() - startedAt).toBeLessThan(4_000);
			expect(execution.commandError).toContain(
				"exceeded the benchmark timeout",
			);
			expect(execution.parsed.signal).toBe("SIGKILL");
			expect(await waitForProcessExitWithEsrch(descendantPid)).toBe("ESRCH");
		} finally {
			await executionPromise?.catch(() => undefined);
			// The production process-group cleanup must reap the descendant; this
			// test intentionally does not kill it as a fallback.
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("allowlists Claude runtime credentials and omits unrelated secrets", () => {
		const environment = buildClaudeEnvironment(
			{
				PATH: "/bin",
				HOME: "/tmp/home",
				ANTHROPIC_API_KEY: "anthropic",
				CLAUDE_CODE_OAUTH_TOKEN: "oauth",
				LINEAR_API_KEY: "linear",
				OPENAI_API_KEY: "openai",
				GITHUB_TOKEN: "github",
			},
			"axi",
		);
		expect(environment).toMatchObject({
			PATH: "/bin",
			HOME: "/tmp/home",
			ANTHROPIC_API_KEY: "anthropic",
			CLAUDE_CODE_OAUTH_TOKEN: "oauth",
			LINEAR_API_URL: "https://api.linear.app/graphql",
		});
		expect(environment).not.toHaveProperty("LINEAR_API_KEY");
		expect(
			buildClaudeEnvironment(
				{ LINEAR_API_KEY: "linear", ANTHROPIC_API_KEY: "anthropic" },
				"mcp",
			),
		).toMatchObject({ LINEAR_API_KEY: "linear" });
		expect(environment).not.toHaveProperty("OPENAI_API_KEY");
		expect(environment).not.toHaveProperty("GITHUB_TOKEN");
		expect(environment.LINEAR_API_URL).toBe("https://api.linear.app/graphql");
		expect(
			buildClaudeEnvironment(
				{
					LINEAR_API_KEY: "linear",
					LINEAR_API_URL: "https://evil.example/graphql",
					ANTHROPIC_API_KEY: "anthropic",
				},
				"axi",
			).LINEAR_API_URL,
		).toBe("https://api.linear.app/graphql");
		expect(
			buildClaudeEnvironment(
				{ LINEAR_API_KEY: "linear", ANTHROPIC_API_KEY: "anthropic" },
				"judge",
			),
		).not.toHaveProperty("LINEAR_API_KEY");
	});

	it("writes an ephemeral placeholder-only MCP config and rejects other endpoints", async () => {
		const handle = await createMcpConfig();
		try {
			const contents = await readFile(handle.filePath, "utf8");
			expect(contents).toContain("https://mcp.linear.app/mcp/readonly");
			expect(contents).toContain('"alwaysLoad": true');
			expect(contents).toContain("${LINEAR_API_KEY}");
			expect(contents).not.toContain("lin_api_");
			expect(
				isReadOnlyLinearMcpUrl("https://mcp.linear.app/mcp/readonly"),
			).toBe(true);
			expect(isReadOnlyLinearMcpUrl("https://mcp.linear.app/mcp")).toBe(false);
			await expect(
				createMcpConfig("https://mcp.linear.app/mcp"),
			).rejects.toThrow();
		} finally {
			await handle.cleanup();
		}
	});
});
