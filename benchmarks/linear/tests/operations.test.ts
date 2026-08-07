import { describe, expect, it } from "vitest";
import {
	classifyOperations,
	operationRequirementsMatch,
} from "../src/operations.js";
import type { ParsedToolCall, ParsedToolResult, RequiredOperation } from "../src/types.js";

const axiCalls: ParsedToolCall[] = [
	{
		id: "axi-search",
		name: "Bash",
		kind: "bash",
		input: {
			command: "/tmp/axi-wrapper issue query --search=' Full title ' --fields compact",
		},
	},
	{
		id: "axi-view",
		name: "Bash",
		kind: "bash",
		input: { command: "/tmp/axi-wrapper issue view ENG-10 --fields compact" },
	},
];

const mcpCalls: ParsedToolCall[] = [
	{
		id: "mcp-search",
		name: "mcp__linear__list_issues",
		kind: "mcp",
		input: { query: "Full title" },
	},
	{
		id: "mcp-view",
		name: "mcp__linear__get_issue",
		kind: "mcp",
		input: { identifier: "ENG-10" },
	},
];

const requirements: RequiredOperation[] = [
	{
		kind: "issue_search",
		operand: "Full title",
		requiredResultValues: ["ENG-10", "Full title"],
	},
	{
		kind: "issue_view",
		operand: "ENG-10",
		requiredResultValues: ["ENG-10", "Full title"],
	},
];

function successfulResults(prefix: "axi" | "mcp"): Map<string, ParsedToolResult[]> {
	return new Map([
		[
			`${prefix}-search`,
			[{ toolUseId: `${prefix}-search`, text: "ENG-10 Full title", isError: false }],
		],
		[
			`${prefix}-view`,
			[{ toolUseId: `${prefix}-view`, text: "ENG-10 Full title In Progress", isError: false }],
		],
	]);
}

describe("typed operation extraction and semantics", () => {
	it("retains AXI tool IDs and trim-only search/view operands", () => {
		const observed = classifyOperations("axi", axiCalls, "/tmp/axi-wrapper");
		expect(observed).toMatchObject([
			{
				kind: "issue_search",
				toolUseId: "axi-search",
				operand: "Full title",
				searchText: "Full title",
			},
			{
				kind: "issue_view",
				toolUseId: "axi-view",
				operand: "ENG-10",
				issueIdentifier: "ENG-10",
			},
		]);
	});

	it("skips StructuredOutput while retaining original user call indexes", () => {
		const internal: ParsedToolCall = {
			id: "structured-answer",
			name: "StructuredOutput",
			kind: "structured_output",
			input: { value: "final" },
		};
		const observed = classifyOperations(
			"axi",
			[axiCalls[0]!, internal, axiCalls[1]!],
			"/tmp/axi-wrapper",
		);
		expect(observed.map((operation) => operation.kind)).toEqual([
			"issue_search",
			"issue_view",
		]);
		expect(observed.map((operation) => operation.callIndex)).toEqual([0, 2]);
		expect(observed.map((operation) => operation.toolUseId)).toEqual([
			"axi-search",
			"axi-view",
		]);
	});

	it("extracts an exact operand from a double-quoted compact search", () => {
		const calls: ParsedToolCall[] = [{
			id: "axi-double-quoted-search",
			name: "Bash",
			kind: "bash",
			input: {
				command: '/tmp/axi-wrapper issue query --search="Full title" --fields compact',
			},
		}];
		const observed = classifyOperations("axi", calls, "/tmp/axi-wrapper");
		expect(observed).toMatchObject([{
			kind: "issue_search",
			toolUseId: "axi-double-quoted-search",
			operand: "Full title",
			searchText: "Full title",
		}]);
		const required: RequiredOperation[] = [{
			kind: "issue_search",
			operand: "Full title",
			requiredResultValues: ["ENG-10", "Full title"],
		}];
		const linked = new Map<string, ParsedToolResult[]>([[
			"axi-double-quoted-search",
			[{ toolUseId: "axi-double-quoted-search", text: "ENG-10 Full title", isError: false }],
		]]);
		expect(operationRequirementsMatch(required, observed, linked)).toBe(true);
	});

	it("classifies legacy and malformed AXI selectors as other", () => {
		const commands = [
			"/tmp/axi-wrapper issue view ENG-10",
			"/tmp/axi-wrapper issue query --search=Full title",
			"/tmp/axi-wrapper issue view ENG-10 --fields full",
			"/tmp/axi-wrapper issue view ENG-10 --fields compact --fields compact",
			"/tmp/axi-wrapper issue comment list ENG-10 --fields compact --limit=9",
		];
		const observed = classifyOperations(
			"axi",
			commands.map((command, index) => ({
				id: `invalid-${index}`,
				name: "Bash",
				kind: "bash" as const,
				input: { command },
			})),
			"/tmp/axi-wrapper",
		);
		expect(observed.map((operation) => operation.kind)).toEqual(commands.map(() => "other"));
	});

	it("retains MCP tool IDs and the typed query/identifier operands", () => {
		const observed = classifyOperations("mcp", mcpCalls);
		expect(observed).toMatchObject([
			{
				kind: "issue_search",
				toolUseId: "mcp-search",
				searchText: "Full title",
			},
			{
				kind: "issue_view",
				toolUseId: "mcp-view",
				issueIdentifier: "ENG-10",
			},
		]);
	});

	it.each([
		["axi", axiCalls, successfulResults("axi")],
		["mcp", mcpCalls, successfulResults("mcp")],
	] as const)("requires matching operands and linked successful results for %s", (condition, calls, results) => {
		const observed = classifyOperations(condition, calls, "/tmp/axi-wrapper");
		expect(operationRequirementsMatch(requirements, observed, results)).toBe(true);

		const wrongOperand = [...requirements];
		wrongOperand[0] = { ...wrongOperand[0]!, operand: "Other title" };
		expect(operationRequirementsMatch(wrongOperand, observed, results)).toBe(false);

		const missingSearchResult = new Map(results);
		missingSearchResult.delete(`${condition}-search`);
		expect(operationRequirementsMatch(requirements, observed, missingSearchResult)).toBe(false);
	});

	it("allows only the explicitly modeled issue-scoped invalid-issue error", () => {
		const invalid: RequiredOperation[] = [{
			kind: "issue_view",
			operand: "ENG-999",
			expectedError: "issue_not_found",
		}];
		const observed = classifyOperations("mcp", [{
			id: "mcp-invalid",
			name: "mcp__linear__get_issue",
			kind: "mcp",
			input: { id: "ENG-999" },
		}]);
		expect(operationRequirementsMatch(invalid, observed, new Map([
			[
				"mcp-invalid",
				[{ toolUseId: "mcp-invalid", text: "entity not found: issue", isError: true }],
			],
		]))).toBe(true);
		expect(operationRequirementsMatch(invalid, observed, new Map([
			[
				"mcp-invalid",
				[{ toolUseId: "mcp-invalid", text: "HTTP 404", isError: true }],
			],
		]))).toBe(false);
	});
});
