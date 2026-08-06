import { describe, expect, it } from "vitest";
import {
	classifyErrors,
	gradeDeterministically,
	mentionsNotFound,
	runJudge,
	toolUseCounts,
} from "../src/grader.js";
import type { BenchmarkTask, ParsedClaudeStream } from "../src/types.js";

const task: BenchmarkTask = {
	id: "task",
	category: "single_step",
	title: "Task",
	prompt: "Read the issue.",
	minimumToolCalls: 1,
	requiredOperations: [],
	requiredFacts: [
		{ label: "identifier", kind: "contains", value: "ENG-10" },
		{ label: "title", kind: "contains", value: "Improve query latency" },
	],
	gradingHints: [],
};

function stream(
	toolCalls: ParsedClaudeStream["toolCalls"],
	toolResults: ParsedClaudeStream["toolResults"] = [],
): ParsedClaudeStream {
	return {
		finalAnswer: "",
		toolCalls,
		toolResults,
		usage: {
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
		},
		turns: 1,
		errors: [],
		parseErrors: 0,
		terminalStatus: "success",
	};
}

const evidence = [
	{ toolUseId: "axi-1", text: "ENG-10 Improve query latency", isError: false },
];

describe("deterministic grading", () => {
	it("requires condition tool use, minimum calls, final facts, and linked evidence", () => {
		const grade = gradeDeterministically(
			task,
			"ENG-10 — Improve query latency",
			"axi",
			stream(
				[
					{
						id: "axi-1",
						name: "Bash",
						kind: "bash",
						input: { command: "magi-linear-axi issue view ENG-10" },
					},
				],
				evidence,
			),
			[],
		);
		expect(grade.passed).toBe(true);
		expect(grade.score).toBe(1);
		expect(grade.factChecks.every((fact) => fact.grounded)).toBe(true);
	});

	it("does not accept unsupported final-answer guessing without linked tool results", () => {
		const grade = gradeDeterministically(
			task,
			"ENG-10 — Improve query latency",
			"axi",
			stream([
				{
					id: "axi-1",
					name: "Bash",
					kind: "bash",
					input: { command: "magi-linear-axi issue view ENG-10" },
				},
			]),
			[],
		);
		expect(grade.passed).toBe(false);
		expect(grade.reason).toMatch(/grounded|evidence/u);
	});

	it("requires the encoded minimum tool-call count", () => {
		const multi = { ...task, minimumToolCalls: 2 };
		const grade = gradeDeterministically(
			multi,
			"ENG-10 Improve query latency",
			"axi",
			stream(
				[
					{
						id: "axi-1",
						name: "Bash",
						kind: "bash",
						input: { command: "magi-linear-axi issue view ENG-10" },
					},
				],
				evidence,
			),
			[],
		);
		expect(grade.passed).toBe(false);
		expect(grade.reason).toMatch(/at least 2/u);
	});

	it("lets a safety violation override otherwise correct facts", () => {
		const grade = gradeDeterministically(
			task,
			"ENG-10 Improve query latency",
			"axi",
			stream(
				[
					{
						id: "axi-1",
						name: "Bash",
						kind: "bash",
						input: { command: "magi-linear-axi issue view ENG-10" },
					},
				],
				evidence,
			),
			[
				{
					source: "axi-bash",
					operation: "write-shaped AXI operation",
					message: "write",
				},
			],
		);
		expect(grade.passed).toBe(false);
		expect(grade.reason).toMatch(/safety/u);
	});

	it("requires explicit issue absence in both the answer and linked error evidence", () => {
		const notFoundTask: BenchmarkTask = {
			...task,
			requiredFacts: [
				{ label: "not found", kind: "not_found", value: "ENG-999" },
			],
		};
		const missingEvidence = gradeDeterministically(
			notFoundTask,
			"The issue ENG-999 was not found.",
			"mcp",
			stream([
				{
					id: "mcp-1",
					name: "mcp__linear__get_issue",
					kind: "mcp",
					input: { id: "ENG-999" },
				},
			]),
			[],
		);
		expect(missingEvidence.passed).toBe(false);

		const axiGrade = gradeDeterministically(
			notFoundTask,
			"The issue ENG-999 is not found.",
			"axi",
			stream(
				[
					{
						id: "axi-1",
						name: "Bash",
						kind: "bash",
						input: { command: "magi-linear-axi issue view ENG-999" },
					},
				],
				[{ toolUseId: "axi-1", text: "issue not found", isError: true }],
			),
			[],
		);
		expect(axiGrade.passed).toBe(true);
		expect(axiGrade.infrastructureFailure).toBe(false);

		const mcpGrade = gradeDeterministically(
			notFoundTask,
			"No such issue: ENG-999.",
			"mcp",
			stream(
				[
					{
						id: "mcp-1",
						name: "mcp__linear__get_issue",
						kind: "mcp",
						input: { id: "ENG-999" },
					},
				],
				[
					{
						toolUseId: "mcp-1",
						text: "entity not found: issue",
						isError: true,
					},
				],
			),
			[],
		);
		expect(mcpGrade.passed).toBe(true);

		const genericError = gradeDeterministically(
			notFoundTask,
			"The issue ENG-999 is not found.",
			"mcp",
			stream(
				[
					{
						id: "mcp-1",
						name: "mcp__linear__get_issue",
						kind: "mcp",
						input: { id: "ENG-999" },
					},
				],
				[
					{
						toolUseId: "mcp-1",
						text: "Unauthorized API schema error",
						isError: true,
					},
				],
			),
			[],
		);
		expect(genericError.passed).toBe(false);
		expect(genericError.factChecks[0]?.grounded).toBe(false);

		const nonErrorMention = gradeDeterministically(
			notFoundTask,
			"The issue ENG-999 is not found.",
			"mcp",
			stream(
				[
					{
						id: "mcp-1",
						name: "mcp__linear__get_issue",
						kind: "mcp",
						input: { id: "ENG-999" },
					},
				],
				[
					{
						toolUseId: "mcp-1",
						text: "Issue not found in a prose description",
						isError: false,
					},
				],
			),
			[],
		);
		expect(nonErrorMention.factChecks[0]?.grounded).toBe(false);
	});

	it("rejects unscoped, transport, permission, and generic lookup wording", () => {
		for (const message of [
			"executable not found",
			"HTTP 404 Not Found",
			"permission denied: issue is not visible",
			"permission denied: issue ENG-999 not found",
			"cannot find issue ENG-999",
			"unable to find issue ENG-999",
			"the resource is absent",
		]) {
			expect(mentionsNotFound(message), message).toBe(false);
		}
		for (const message of [
			"Issue ENG-999 not found",
			"Issue ENG-999 does not exist",
			"Issue ENG-999 doesn't exist",
			"no such issue: ENG-999",
			"entity not found: issue ENG-999",
			"Could not find referenced Issue.",
			"not found for issue ENG-999",
		]) {
			expect(mentionsNotFound(message), message).toBe(true);
		}
	});

	it("classifies linked errors without turning ordinary tool errors into infrastructure", () => {
		const commandStream = stream(
			[{ id: "axi-1", name: "Bash", kind: "bash", input: {} }],
			[
				{
					toolUseId: "axi-1",
					text: "usage: issue view (exit code 2)",
					isError: true,
				},
			],
		);
		expect(classifyErrors(commandStream, task)).toMatchObject({
			commandErrorCount: 1,
			infrastructureErrorCount: 0,
			toolErrorCount: 0,
		});

		const apiStream = stream(
			[{ id: "axi-1", name: "Bash", kind: "bash", input: {} }],
			[
				{
					toolUseId: "axi-1",
					text: "API transport failure (exit 1)",
					isError: true,
				},
			],
		);
		expect(classifyErrors(apiStream, task)).toMatchObject({
			apiErrorCount: 1,
			infrastructureErrorCount: 0,
		});

		const toolStream = stream(
			[{ id: "axi-1", name: "Bash", kind: "bash", input: {} }],
			[{ toolUseId: "axi-1", text: "unexpected tool failure", isError: true }],
		);
		expect(classifyErrors(toolStream, task)).toMatchObject({
			toolErrorCount: 1,
			infrastructureErrorCount: 0,
		});

		const expectedTask: BenchmarkTask = {
			...task,
			requiredFacts: [{ label: "not found", kind: "not_found" }],
		};
		const expectedStream = stream(
			[{ id: "axi-1", name: "Bash", kind: "bash", input: {} }],
			[{ toolUseId: "axi-1", text: "issue not found", isError: true }],
		);
		expect(classifyErrors(expectedStream, expectedTask)).toMatchObject({
			expectedErrorCount: 1,
			commandErrorCount: 0,
			apiErrorCount: 0,
			toolErrorCount: 0,
			infrastructureErrorCount: 0,
		});

		const runtime = stream([], []);
		runtime.errors = ["Claude Code process exceeded the benchmark timeout"];
		expect(classifyErrors(runtime, task).infrastructureErrorCount).toBe(1);
	});

	it("does not let command/API/tool errors override otherwise grounded correctness", () => {
		const streamWithError = stream(
			[
				{ id: "axi-1", name: "Bash", kind: "bash", input: {} },
				{ id: "axi-2", name: "Bash", kind: "bash", input: {} },
			],
			[
				{ toolUseId: "axi-1", text: "usage (exit code 2)", isError: true },
				{
					toolUseId: "axi-2",
					text: "ENG-10 Improve query latency",
					isError: false,
				},
			],
		);
		const grade = gradeDeterministically(
			task,
			"ENG-10 — Improve query latency",
			"axi",
			streamWithError,
			[],
		);
		expect(grade.passed).toBe(true);
		expect(grade.infrastructureFailure).toBe(false);
	});

	it("requires terminal success before accepting a judge result", async () => {
		const missingTerminal = stream([], []);
		missingTerminal.terminalStatus = "missing";
		missingTerminal.finalAnswer = '{"passed":true,"score":1,"rationale":"ok"}';
		const deterministic = gradeDeterministically(
			task,
			"",
			"axi",
			missingTerminal,
			[],
		);
		const baseOptions = {
			task,
			condition: "axi" as const,
			answer: "",
			deterministic,
			toolCounts: toolUseCounts(missingTerminal),
			cwd: "/tmp",
		};
		const missing = await runJudge({
			...baseOptions,
			execute: async () => ({
				stdout: "",
				stderr: "",
				parsed: missingTerminal,
			}),
		});
		expect(missing.grade.status).toBe("error");

		const successful = stream([], []);
		successful.finalAnswer = '{"passed":true,"score":1,"rationale":"ok"}';
		const judged = await runJudge({
			...baseOptions,
			toolCounts: toolUseCounts(successful),
			execute: async () => ({
				stdout: "judge",
				stderr: "",
				parsed: successful,
			}),
		});
		expect(judged.grade).toMatchObject({ status: "passed", score: 1 });
	});

	it("fails parse, process, and non-success failures", () => {
		const broken = stream(
			[
				{
					id: "axi-1",
					name: "Bash",
					kind: "bash",
					input: { command: "magi-linear-axi issue view ENG-10" },
				},
			],
			evidence,
		);
		broken.parseErrors = 1;
		expect(
			gradeDeterministically(
				task,
				"ENG-10 Improve query latency",
				"axi",
				broken,
				[],
			).passed,
		).toBe(false);
		const nonSuccess = stream(
			[
				{
					id: "axi-1",
					name: "Bash",
					kind: "bash",
					input: { command: "magi-linear-axi issue view ENG-10" },
				},
			],
			evidence,
		);
		nonSuccess.errors = ["Claude Code returned a non-success result"];
		expect(
			gradeDeterministically(
				task,
				"ENG-10 Improve query latency",
				"axi",
				nonSuccess,
				[],
			).passed,
		).toBe(false);
		const missingTerminal = stream(
			[
				{
					id: "axi-1",
					name: "Bash",
					kind: "bash",
					input: { command: "magi-linear-axi issue view ENG-10" },
				},
			],
			evidence,
		);
		missingTerminal.terminalStatus = "missing";
		expect(
			gradeDeterministically(
				task,
				"ENG-10 Improve query latency",
				"axi",
				missingTerminal,
				[],
			).infrastructureFailure,
		).toBe(true);
	});

	it("enforces exact typed operation operands and linked result semantics for AXI and MCP", () => {
		const searchTask: BenchmarkTask = {
			...task,
			title: "Search",
			requiredOperations: [{
				kind: "issue_search",
				operand: "Improve query latency",
				requiredResultValues: ["ENG-10", "Improve query latency"],
			}],
			requiredFacts: [
				{ label: "searched identifier", kind: "contains", value: "ENG-10", source: "issue_search" },
				{ label: "searched title", kind: "contains", value: "Improve query latency", source: "issue_search" },
			],
		};
		const replacementTask: BenchmarkTask = {
			...task,
			title: "Replacement",
			minimumToolCalls: 2,
			requiredOperations: [
				{
					kind: "issue_search",
					operand: "Improve query latency",
					requiredResultValues: ["ENG-10", "Improve query latency"],
				},
				{
					kind: "issue_view",
					operand: "ENG-10",
					requiredResultValues: ["ENG-10", "Improve query latency"],
				},
			],
			requiredFacts: [
				{ label: "view identifier", kind: "contains", value: "ENG-10", source: "issue_view" },
				{ label: "view title", kind: "contains", value: "Improve query latency", source: "issue_view" },
			],
		};
		const invalidTask: BenchmarkTask = {
			...task,
			title: "Invalid issue",
			requiredOperations: [{
				kind: "issue_view",
				operand: "ENG-999",
				expectedError: "issue_not_found",
			}],
			requiredFacts: [{
				label: "not found",
				kind: "not_found",
				value: "ENG-999",
				source: "issue_view",
			}],
		};
		const axiSearchCall = (id = "axi-search", search = "Improve query latency") => ({
			id,
			name: "Bash",
			kind: "bash" as const,
			input: { command: `magi-linear-axi issue query --search='${search}'` },
		});
		const axiViewCall = (id = "axi-view", identifier = "ENG-10") => ({
			id,
			name: "Bash",
			kind: "bash" as const,
			input: { command: `magi-linear-axi issue view ${identifier}` },
		});
		const mcpSearchCall = (id = "mcp-search", search = "Improve query latency") => ({
			id,
			name: "mcp__linear__search_issues",
			kind: "mcp" as const,
			input: { query: search },
		});
		const mcpListCall = (id = "mcp-list", search = "Improve query latency") => ({
			id,
			name: "mcp__linear__list_issues",
			kind: "mcp" as const,
			input: { query: search, limit: 2 },
		});
		const mcpViewCall = (id = "mcp-view", identifier = "ENG-10") => ({
			id,
			name: "mcp__linear__get_issue",
			kind: "mcp" as const,
			input: { id: identifier },
		});
		const searchResult = (id: string, isError = false) => ({
			toolUseId: id,
			text: "ENG-10 Improve query latency",
			isError,
		});
		const viewResult = (id: string, isError = false) => ({
			toolUseId: id,
			text: "ENG-10 Improve query latency In Progress",
			isError,
		});
		const grade = (
			benchmarkTask: BenchmarkTask,
			condition: "axi" | "mcp",
			calls: ParsedClaudeStream["toolCalls"],
			results: ParsedClaudeStream["toolResults"],
			answer = "ENG-10 Improve query latency",
		) => gradeDeterministically(
			benchmarkTask,
			answer,
			condition,
			stream([...calls], [...results]),
			[],
		);

		for (const [condition, calls, results] of [
			["axi", [axiSearchCall()], [searchResult("axi-search")]],
			["mcp", [mcpSearchCall()], [searchResult("mcp-search")]],
			["mcp", [mcpListCall()], [searchResult("mcp-list")]],
			["axi", [axiSearchCall(), axiViewCall()], [searchResult("axi-search"), viewResult("axi-view")]],
			["mcp", [mcpSearchCall(), mcpViewCall()], [searchResult("mcp-search"), viewResult("mcp-view")]],
		] as const) {
			const benchmarkTask = calls.length === 1 ? searchTask : replacementTask;
			expect(grade(benchmarkTask, condition, [...calls], [...results]).passed).toBe(true);
		}

		const failures = [
			[
				"errored search plus good view",
				grade(
					replacementTask,
					"axi",
					[axiSearchCall(), axiViewCall()],
					[searchResult("axi-search", true), viewResult("axi-view")],
				),
			],
			[
				"wrong search term plus good view",
				grade(
					replacementTask,
					"mcp",
					[mcpSearchCall("mcp-search", "Improve latency"), mcpViewCall()],
					[searchResult("mcp-search"), viewResult("mcp-view")],
				),
			],
			[
				"successful search plus mismatched view identifier",
				grade(
					replacementTask,
					"axi",
					[axiSearchCall(), axiViewCall("axi-view", "ENG-11")],
					[searchResult("axi-search"), viewResult("axi-view")],
				),
			],
			[
				"missing linked search result",
				grade(
					replacementTask,
					"mcp",
					[mcpSearchCall(), mcpViewCall()],
					[
						{ toolUseId: "unrelated", text: "ENG-10 Improve query latency", isError: false },
						viewResult("mcp-view"),
					],
				),
			],
			[
				"case-mismatched search term",
				grade(
					searchTask,
					"mcp",
					[mcpSearchCall("mcp-search", "improve query latency")],
					[searchResult("mcp-search")],
				),
			],
		] as const;
		for (const [label, failed] of failures) {
			expect(failed.passed, label).toBe(false);
			expect(failed.operationChecksPassed, label).toBe(false);
		}

		const help = {
			id: "help",
			name: "Bash",
			kind: "bash" as const,
			input: { command: "magi-linear-axi --help" },
		};
		for (const [label, calls, results] of [
			["duplicate search", [axiSearchCall("one"), axiSearchCall("two")], [searchResult("one"), searchResult("two")]],
			["help plus search", [help, axiSearchCall()], [searchResult("axi-search")]],
			["reversed search/view", [axiViewCall(), axiSearchCall()], [viewResult("axi-view"), searchResult("axi-search")]],
		] as const) {
			const failed = grade(
				label === "reversed search/view" ? replacementTask : searchTask,
				"axi",
				[...calls],
				[...results],
			);
			expect(failed.passed, label).toBe(false);
			expect(failed.operationChecksPassed, label).toBe(false);
		}

		for (const [condition, call, result] of [
			[
				"axi",
				axiViewCall("invalid-axi", "ENG-999"),
				{ toolUseId: "invalid-axi", text: "entity not found: issue", isError: true },
			],
			[
				"mcp",
				mcpViewCall("invalid-mcp", "ENG-999"),
				{ toolUseId: "invalid-mcp", text: "Issue ENG-999 does not exist", isError: true },
			],
		] as const) {
			const valid = grade(
				invalidTask,
				condition,
				[call],
				[result],
				"The issue ENG-999 was not found.",
			);
			expect(valid.passed, condition).toBe(true);
			expect(valid.operationChecksPassed, condition).toBe(true);
		}
		expect(grade(searchTask, "axi", [], []).passed).toBe(false);
	});
});
