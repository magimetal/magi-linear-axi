import { describe, expect, it } from "vitest";
import {
	requestLinearGraphql,
	assertQueryOnly,
	GraphqlSafetyError,
} from "../src/graphql.js";
import {
	assertLiveReadOnlyContract,
	scanAudit,
	scanSafety,
	scanTrajectory,
} from "../src/safety.js";

describe("query-only GraphQL guard", () => {
	it("accepts executable named and anonymous queries while ignoring strings/comments", () => {
		expect(() =>
			assertQueryOnly(
				"# mutation in a comment\nquery Viewer { viewer { name } }",
			),
		).not.toThrow();
		expect(() =>
			assertQueryOnly('{ issue(id: "mutation subscription") { title } }'),
		).not.toThrow();
		expect(() =>
			assertQueryOnly(
				'query Read { issue(description: """mutation { no-op }""") { title } }',
			),
		).not.toThrow();
		expect(() =>
			assertQueryOnly(
				"fragment IssueFields on Issue { title } query Read { issue { ...IssueFields } }",
			),
		).not.toThrow();
	});

	it("rejects fragment-only, empty, mutation, and subscription documents", () => {
		expect(() =>
			assertQueryOnly("fragment IssueFields on Issue { title }"),
		).toThrow(/no executable query/u);
		expect(() => assertQueryOnly("   # only a comment\n  ")).toThrow(
			GraphqlSafetyError,
		);
		expect(() =>
			assertQueryOnly("mutation Create { issueCreate { success } }"),
		).toThrow(GraphqlSafetyError);
		expect(() =>
			assertQueryOnly(
				"query Read { viewer { name } } subscription Watch { issue { id } }",
			),
		).toThrow(/subscription/u);
	});

	it("guards the transport before a fetch can occur and sends the raw Linear API key header", async () => {
		let calls = 0;
		await expect(
			requestLinearGraphql(
				"mutation Create { issueCreate { success } }",
				{},
				{
					apiKey: "test-read-only-key",
					fetchImpl: async () => {
						calls += 1;
						return new Response(JSON.stringify({ data: {} }), { status: 200 });
					},
				},
			),
		).rejects.toThrow(GraphqlSafetyError);
		expect(calls).toBe(0);

		let headers: Headers | undefined;
		await requestLinearGraphql(
			"query Viewer { viewer { id } }",
			{},
			{
				apiKey: "lin_api_test_key",
				fetchImpl: async (_input, init) => {
					headers = new Headers(init?.headers);
					return new Response(
						JSON.stringify({ data: { viewer: { id: "viewer-1" } } }),
						{ status: 200 },
					);
				},
			},
		);
		expect(headers?.get("Authorization")).toBe("lin_api_test_key");
		expect(headers?.get("Authorization")).not.toMatch(/^Bearer /u);
	});
});

describe("layered live contract and trajectory scanner", () => {
	it("requires key, explicit confirmation, and the environment latch", () => {
		expect(() => assertLiveReadOnlyContract(false, {})).toThrow(
			/LINEAR_API_KEY/u,
		);
		expect(() =>
			assertLiveReadOnlyContract(false, {
				LINEAR_API_KEY: "test-read-only-key",
				LINEAR_BENCHMARK_READ_ONLY: "1",
			}),
		).toThrow(/confirm-read-only/u);
		expect(() =>
			assertLiveReadOnlyContract(true, {
				LINEAR_API_KEY: "test-read-only-key",
			}),
		).toThrow(/LINEAR_BENCHMARK_READ_ONLY/u);
		expect(
			assertLiveReadOnlyContract(true, {
				LINEAR_API_KEY: "test-read-only-key",
				LINEAR_BENCHMARK_READ_ONLY: "1",
			}),
		).toBe("test-read-only-key");
	});

	it("extracts the command field, requires the resolved binary, and allows documented reads", () => {
		const safe = [
			{
				name: "Bash",
				kind: "bash" as const,
				input: {
					command: "/tmp/bin/magi-linear-axi issue query --search=update",
				},
			},
			{
				name: "Bash",
				kind: "bash" as const,
				input: {
					command: "/tmp/bin/magi-linear-axi issue relation list ENG-10",
				},
			},
			{
				name: "Bash",
				kind: "bash" as const,
				input: { command: "/tmp/bin/magi-linear-axi auth whoami" },
			},
			{
				name: "Bash",
				kind: "bash" as const,
				input: { command: "/tmp/bin/magi-linear-axi --help" },
			},
		];
		expect(scanSafety("axi", safe, "/tmp/bin/magi-linear-axi")).toHaveLength(0);
		expect(
			scanSafety(
				"axi",
				[
					{
						name: "Bash",
						kind: "bash",
						input: { command: "/tmp/other/magi-linear-axi issue view ENG-10" },
					},
				],
				"/tmp/bin/magi-linear-axi",
			),
		).toHaveLength(1);
		expect(
			scanSafety(
				"axi",
				[
					{
						name: "Bash",
						kind: "bash",
						input: { command: "magi-linear-axi issue query --search=update" },
					},
				],
				"/tmp/bin/magi-linear-axi",
			),
		).toHaveLength(1);
	});

	it("rejects every explicit endpoint flag, including the official endpoint", () => {
		const binary = "/tmp/bin/magi-linear-axi";
		const commands = [
			`${binary} issue view ENG-10 --endpoint https://api.linear.app/graphql`,
			`${binary} issue view ENG-10 --endpoint https://evil.example/graphql`,
			`${binary} issue view ENG-10 --endpoint=https://api.linear.app/graphql`,
			`${binary} issue view ENG-10 --endpoint=https://evil.example/graphql`,
		];
		const violations = scanSafety(
			"axi",
			commands.map((command) => ({
				name: "Bash",
				kind: "bash" as const,
				input: { command },
			})),
			binary,
		);
		expect(violations).toHaveLength(commands.length);
		expect(violations.every((violation) => violation.message.length > 0)).toBe(
			true,
		);
	});

	it("finds shell escapes, raw mutations, and every write/local-mutating AXI family", () => {
		const binary = "/tmp/bin/magi-linear-axi";
		const commands = [
			`${binary} issue create --team ENG --title x`,
			`${binary} issue update ENG-10 --title x`,
			`${binary} issue delete ENG-10`,
			`${binary} issue start ENG-10`,
			`${binary} issue attach ENG-10 file`,
			`${binary} issue link ENG-10 https://example.com`,
			`${binary} issue comment add ENG-10 --body x`,
			`${binary} issue comment update c-1 --body x`,
			`${binary} issue comment delete c-1`,
			`${binary} issue relation add ENG-10 blocks ENG-11`,
			`${binary} issue relation delete ENG-10 blocks r-1`,
			`${binary} project archive p-1`,
			`${binary} project unarchive p-1`,
			`${binary} initiative add-project i-1 --project p-1`,
			`${binary} initiative remove-project i-1 --project p-1`,
			`${binary} setup`,
			`${binary} config set endpoint x`,
			`${binary} auth login`,
			`${binary} auth logout`,
			`${binary} auth default`,
			`${binary} auth token`,
			`${binary} api 'mutation Delete { issueDelete { success } }'`,
			`${binary} issue view ENG-10 && ${binary} issue view ENG-11`,
			`${binary} issue view ENG-10 > output.txt`,
			`${binary} issue view $(cat input)`,
		];
		const audit = scanAudit(
			"axi",
			commands.map((command) => ({
				name: "Bash",
				kind: "bash" as const,
				input: { command },
			})),
			"/tmp/bin/magi-linear-axi",
		);
		expect(audit.safetyViolations).toHaveLength(commands.length);
		expect(audit.policyIncidents).toHaveLength(0);
		expect(
			scanTrajectory(
				"axi",
				[{ name: "Bash", kind: "bash", input: { notCommand: "x" } }],
				"/tmp/bin/magi-linear-axi",
			).policyIncidents,
		).toHaveLength(1);
		expect(
			scanTrajectory(
				"axi",
				[
					{
						name: "Bash",
						kind: "bash",
						input: { command: `${binary} issue query | cat` },
					},
				],
				binary,
			).safetyViolations,
		).toHaveLength(1);
	});

	it("classifies shell syntax as hard safety and unrecognized reads as policy", () => {
		const binary = "/tmp/bin/magi-linear-axi";
		const audit = scanAudit(
			"axi",
			[
				{ name: "Bash", kind: "bash", input: { command: `${binary} issue view ENG-10 2>&1` } },
				{ name: "Bash", kind: "bash", input: { command: `${binary} issue view ENG-10 \\\n` } },
				{ name: "Bash", kind: "bash", input: { command: `${binary} issue get ENG-10` } },
			],
			binary,
		);
		expect(audit.safetyViolations).toHaveLength(2);
		expect(audit.policyIncidents).toHaveLength(1);
		expect(audit.safetyViolations.map((incident) => incident.operation)).toEqual([
			"shell operator",
			"line continuation",
		]);
		expect(audit.policyIncidents.map((incident) => incident.operation)).toEqual([
			"unrecognized AXI operation",
		]);
			expect(scanSafety("axi", [
			{ name: "Bash", kind: "bash", input: { command: `${binary} issue get ENG-10` } },
		], binary)).toHaveLength(0);
	});

	it("treats every execution-capable composition and redirection as hard safety", () => {
		const binary = "/tmp/bin/magi-linear-axi";
		const commands = [
			`${binary} issue view ENG-10 | cat`,
			`${binary} issue view ENG-10 && ${binary} --help`,
			`${binary} issue view ENG-10; ${binary} --help`,
			`${binary} issue view ENG-10 &`,
			`${binary} issue view ENG-10 $(printf x)`,
			`${binary} issue view ENG-10 \`printf x\``,
			`${binary} issue view ENG-10 \\\n`,
			`${binary} issue view ENG-10 (extra)`,
			`${binary} issue view ENG-10 2>&1`,
			`${binary} issue view ENG-10 > output.txt`,
			`${binary} issue view ENG-10 < input.txt`,
		];
		const audit = scanAudit(
			"axi",
			commands.map((command) => ({
				name: "Bash",
				kind: "bash" as const,
				input: { command },
			})),
			binary,
		);
		expect(audit.safetyViolations).toHaveLength(commands.length);
		expect(audit.policyIncidents).toHaveLength(0);
	});

	it("finds MCP writes, preserves exact namespace, and does not flag plural read names", () => {
		expect(
			scanSafety("mcp", [
				{ name: "mcp__linear__get_issue", kind: "mcp", input: { id: "ENG-1" } },
				{
					name: "mcp__linear__get_project_updates",
					kind: "mcp",
					input: { project_id: "p-1" },
				},
			]),
		).toHaveLength(0);
		expect(
			scanSafety("mcp", [
				{
					name: "mcp__linear__issueCreate",
					kind: "mcp",
					input: { title: "x" },
				},
				{ name: "mcp__linear__issue_update", kind: "mcp", input: {} },
				{ name: "mcp__linear__comment_add", kind: "mcp", input: {} },
				{
					name: "mcp__linear__execute",
					kind: "mcp",
					input: { operation: "delete" },
				},
				{ name: "mcp__other__get_issue", kind: "mcp", input: {} },
				{ name: "Bash", kind: "bash", input: "echo forbidden" },
			]),
		).toHaveLength(6);
	});
});
