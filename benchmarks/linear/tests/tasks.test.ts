import { describe, expect, it } from "vitest";
import { generateTasks } from "../src/tasks.js";
import {
	allDuplicateTitleSnapshot,
	duplicateTitleSnapshot,
	exactLimitCommentSnapshot,
	oversizedCommentSnapshot,
	richSnapshot,
	sparseSnapshot,
} from "./fixtures.js";

describe("dynamic task generation", () => {
	it("builds the full pilot suite from rich read-only facts and explicit minima", () => {
		const manifest = generateTasks(richSnapshot());
		expect(manifest.tasks).toHaveLength(8);
		expect(manifest.tasks.map((task) => task.id)).toEqual([
			"issue-lookup",
			"issue-search",
			"issue-fields",
			"issue-comments",
			"project-lookup",
			"compare-issues",
			"relation-traversal",
			"invalid-issue",
		]);
		expect(
			manifest.tasks.find((task) => task.id === "issue-lookup")?.requiredFacts,
		).toContainEqual({
			label: "issue URL",
			kind: "contains",
			value: "https://linear.app/acme/issue/ENG-10",
			source: "issue_view",
		});
		expect(
			manifest.tasks.find((task) => task.id === "issue-lookup")?.prompt,
		).toContain("issue identifier <ENG-10>");
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")
				?.requiredFacts,
		).toContainEqual({
			label: "selected comment ID",
			kind: "contains",
			value: "comment-1",
		});
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")
				?.requiredFacts,
		).toContainEqual({
			label: "selected comment body",
			kind: "contains",
			value: "Profiling is complete.",
		});
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")?.requiredFacts,
		).not.toContainEqual({
			label: "issue identifier",
			kind: "contains",
			value: "ENG-10",
		});
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")?.prompt,
		).toContain("issue identifier <ENG-10>");
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")?.prompt,
		).toContain("Find comment <comment-1>");
		expect(
			manifest.tasks.find((task) => task.id === "issue-comments")?.prompt,
		).not.toContain("along with the issue identifier");
		expect(
			manifest.tasks.find((task) => task.id === "relation-traversal")
				?.requiredFacts,
		).toContainEqual({
			label: "related issue identifier",
			kind: "contains",
			value: "ENG-11",
		});
		expect(
			manifest.tasks.find((task) => task.id === "relation-traversal")
				?.requiredFacts,
		).toContainEqual({
			label: "related issue title",
			kind: "contains",
			value: "Tune cache behavior",
		});
		expect(
			manifest.tasks.find((task) => task.id === "relation-traversal"),
		).toMatchObject({
			category: "investigation",
			minimumToolCalls: 1,
		});
		expect(
			manifest.tasks.find((task) => task.id === "relation-traversal")?.prompt,
		).toContain("issue identifier <ENG-10>");
		expect(
			manifest.tasks.find((task) => task.id === "relation-traversal")?.prompt,
		).not.toContain("second lookup");
		expect(
			manifest.tasks.find((task) => task.id === "compare-issues")?.prompt,
		).toContain("issue identifiers <ENG-10> and <ENG-11>");
		expect(
			manifest.tasks.find((task) => task.id === "issue-search")?.prompt,
		).toContain("exact full title phrase <Improve query latency>");
		expect(
			manifest.tasks.find((task) => task.id === "project-lookup")?.prompt,
		).toContain("existing project <project-1>");
		for (const generatedTask of manifest.tasks) {
			if (generatedTask.id !== "project-lookup") {
				expect(generatedTask.prompt).not.toContain("<issue-1>");
				expect(generatedTask.prompt).not.toContain("<issue-2>");
			}
		}
		expect(
			manifest.tasks
				.filter((task) => task.category === "multi_step")
				.every((task) => task.minimumToolCalls === 2),
		).toBe(true);
		expect(
			manifest.tasks
				.filter((task) => task.category === "single_step")
				.every((task) => task.minimumToolCalls === 1),
		).toBe(true);
		expect(manifest.warnings).toHaveLength(0);

		const forbiddenSharedSyntax = /(?:issue\s+(?:query|view)|--[A-Za-z][A-Za-z-]*|magi-linear-axi|Bash\(|mcp__linear__|\b(?:executable|wrapper)\b)/iu;
		for (const generatedTask of manifest.tasks) {
			expect(generatedTask.prompt).not.toMatch(forbiddenSharedSyntax);
			for (const hint of generatedTask.gradingHints) {
				expect(hint).not.toMatch(forbiddenSharedSyntax);
			}
		}
	});

		it("uses interface-common search/view replacements and explicit warnings for sparse workspaces", () => {
			const manifest = generateTasks(sparseSnapshot());
			expect(manifest.tasks).toHaveLength(8);
			expect(manifest.tasks.map((task) => task.id)).toEqual([
				"issue-lookup",
				"issue-search",
				"issue-fields",
				"issue-url",
				"project-missing-search-view",
				"second-issue-missing-search-view",
				"relation-missing-search-view",
				"invalid-issue",
			]);
			expect(manifest.warnings.join(" ")).toMatch(/replacement/u);
			const replacementIds = [
				"project-missing-search-view",
				"second-issue-missing-search-view",
				"relation-missing-search-view",
			];
			const replacementTitles = replacementIds.map(
				(replacementId) =>
						manifest.tasks.find((task) => task.id === replacementId)?.title,
			);
			expect(new Set(replacementTitles).size).toBe(3);
			for (const replacementId of replacementIds) {
				const replacement = manifest.tasks.find((task) => task.id === replacementId);
				expect(replacement?.title).toBeTruthy();
				expect(replacement?.prompt).toContain(
					"exact full title <Small fix>",
				);
				expect(replacement?.prompt).toContain(
					"directly retrieve the human issue identifier returned by that search",
				);
				expect(replacement?.prompt).toContain("separate later read");
				expect(replacement?.requiredOperations).toEqual([
					{
						kind: "issue_search",
						operand: "Small fix",
						requiredResultValues: ["ENG-10", "Small fix"],
					},
					{
						kind: "issue_view",
						operand: "ENG-10",
						requiredResultValues: [
							"ENG-10",
							"Small fix",
							"Todo",
							"https://linear.app/acme/issue/ENG-10",
						],
					},
				]);
				expect(replacement?.minimumToolCalls).toBe(2);
				expect(replacement?.requiredFacts).toContainEqual({
								label: "issue identifier",
								kind: "contains",
								value: "ENG-10",
								source: "issue_view",
				});
				expect(replacement?.requiredFacts).toContainEqual({
								label: "issue title",
								kind: "contains",
								value: "Small fix",
								source: "issue_view",
				});
				expect(replacement?.requiredFacts).toContainEqual({
								label: "workflow state",
								kind: "contains",
								value: "Todo",
								source: "issue_view",
				});
				expect(replacement?.requiredFacts).toContainEqual({
								label: "issue URL",
								kind: "contains",
								value: "https://linear.app/acme/issue/ENG-10",
								source: "issue_view",
				});
			}
			const forbiddenSharedSyntax = /(?:issue\s+(?:query|view)|--[A-Za-z][A-Za-z-]*|magi-linear-axi|Bash\(|mcp__linear__|\b(?:executable|wrapper)\b)/iu;
			for (const generatedTask of manifest.tasks) {
				expect(generatedTask.prompt).not.toMatch(forbiddenSharedSyntax);
				for (const hint of generatedTask.gradingHints) {
					expect(hint).not.toMatch(forbiddenSharedSyntax);
				}
			}
			expect(
				manifest.tasks.find((task) => task.id === "invalid-issue")?.prompt,
			).toContain("ENG-999999999");
			expect(
				manifest.tasks.find((task) => task.id === "invalid-issue")?.requiredFacts,
			).toContainEqual({
				label: "invalid issue is explicitly absent",
				kind: "not_found",
				value: "ENG-999999999",
				source: "issue_view",
			});
		});

	it("uses only the persisted confirmed-absent identifier in the invalid task", () => {
		const snapshot = richSnapshot();
		snapshot.confirmedAbsentIssueIdentifier = "OPS-4242";
		const invalid = generateTasks(snapshot).tasks.find((task) => task.id === "invalid-issue");
		expect(invalid?.prompt).toContain("OPS-4242");
		expect(invalid?.prompt).not.toContain("ENG-999999999");
		expect(invalid?.requiredOperations[0]?.operand).toBe("OPS-4242");
	});

	it("uses the snapshot search ground-truth identifier in deterministic order", () => {
		const manifest = generateTasks(duplicateTitleSnapshot());
		const search = manifest.tasks.find((task) => task.id === "issue-search");
		const lookup = manifest.tasks.find((task) => task.id === "issue-lookup");
		const comparison = manifest.tasks.find((task) => task.id === "compare-issues");

		expect(search?.prompt).toContain(
			"exact full title phrase <Unique search candidate>",
		);
		expect(search?.requiredFacts).toContainEqual({
			label: "searched issue identifier",
			kind: "contains",
			value: "ENG-12",
			source: "issue_search",
		});
		expect(lookup?.prompt).toContain("issue identifier <ENG-12>");
		expect(comparison?.prompt).toContain(
			"issue identifiers <ENG-12> and <ENG-10>",
		);

		const regenerated = generateTasks(duplicateTitleSnapshot());
		expect(regenerated.tasks).toEqual(manifest.tasks);
		expect(regenerated.warnings).toEqual(manifest.warnings);
	});

	it("rejects missing or stale persisted ground truth instead of selecting local values", () => {
		const missingSearch = richSnapshot();
		delete missingSearch.searchIssueIdentifier;
		expect(() => generateTasks(missingSearch)).toThrow(/missing .*searchIssueIdentifier/u);
		expect(() => generateTasks({ ...richSnapshot(), searchIssueIdentifier: "ENG-404" })).toThrow(
			/searchIssueIdentifier .* stale/u,
		);

		const missingAbsence = richSnapshot();
		delete (missingAbsence as Partial<typeof missingAbsence>).confirmedAbsentIssueIdentifier;
		expect(() => generateTasks(missingAbsence)).toThrow(/missing confirmedAbsentIssueIdentifier/u);
		expect(() => generateTasks({
			...richSnapshot(),
			confirmedAbsentIssueIdentifier: "ENG-10",
		})).toThrow(/collides with a locally captured issue/u);
	});

	it("rejects a snapshot whose issue titles are all ambiguous", () => {
		expect(() => generateTasks(allDuplicateTitleSnapshot())).toThrow(
			/searchIssueIdentifier .* locally unique/u,
		);
	});

	it("selects exactly 240 Unicode code points and never slices an issue title", () => {
		const title = "🙂".repeat(240);
		const snapshot = richSnapshot();
		snapshot.issues[0]!.title = title;
		const manifest = generateTasks(snapshot);
		const search = manifest.tasks.find((task) => task.id === "issue-search");
		expect(search?.requiredOperations[0]).toEqual({
			kind: "issue_search",
			operand: title,
			requiredResultValues: ["ENG-10", title],
		});
		expect(Array.from(title)).toHaveLength(240);
	});

	it("fails clearly when the persisted primary issue has no representable core title", () => {
		const snapshot = richSnapshot();
		snapshot.issues[0]!.title = "🙂".repeat(241);
		expect(() => generateTasks(snapshot)).toThrow(/not representable in AXI/u);
	});

	it("skips an unrepresentable secondary issue instead of making a fake comparison", () => {
		const snapshot = richSnapshot();
		snapshot.issues[1]!.title = "🙂".repeat(241);
		const manifest = generateTasks(snapshot);
		expect(manifest.tasks.map((task) => task.id)).toContain("second-issue-missing-search-view");
		expect(manifest.tasks.map((task) => task.id)).not.toContain("compare-issues");
		expect(JSON.stringify(manifest)).not.toContain("🙂".repeat(241));
	});

	it("selects representable projects and omits unrepresentable optional project fields", () => {
		const snapshot = richSnapshot();
		snapshot.projects = [
			{ id: "project-long", name: "🙂".repeat(241), url: "https://example.test/long", statusName: "Planned" },
			{ id: "project-good", name: "Usable project", url: "🙂".repeat(241), statusName: "🙂".repeat(241) },
		];
		const project = generateTasks(snapshot).tasks.find((task) => task.id === "project-lookup");
		expect(project).toBeDefined();
		expect(project?.prompt).toContain("project-good");
		expect(project?.requiredFacts).toEqual([{ label: "project name", kind: "contains", value: "Usable project" }]);
		expect(JSON.stringify(project)).not.toContain("🙂".repeat(241));
	});

	it("omits unrepresentable optional issue fields from facts and operation evidence", () => {
		const snapshot = richSnapshot();
		const long = "🙂".repeat(241);
		snapshot.issues[0]!.stateName = long;
		snapshot.issues[0]!.url = long;
		const lookup = generateTasks(snapshot).tasks.find((task) => task.id === "issue-lookup");
		expect(lookup?.requiredFacts).not.toContainEqual(expect.objectContaining({ value: long }));
		expect(lookup?.requiredOperations[0]?.requiredResultValues).toEqual(["ENG-10", "Improve query latency"]);
	});

	it("selects a relation with a representable core and omits an unrepresentable related title", () => {
		const snapshot = richSnapshot();
		snapshot.issues[0]!.relations[0]!.relatedTitle = "🙂".repeat(241);
		const relation = generateTasks(snapshot).tasks.find((task) => task.id === "relation-traversal");
		expect(relation).toBeDefined();
		expect(relation?.requiredFacts).toEqual([
			{ label: "base issue identifier", kind: "contains", value: "ENG-10" },
			{ label: "relation type", kind: "contains", value: "blocks" },
			{ label: "related issue identifier", kind: "contains", value: "ENG-11" },
		]);
		expect(JSON.stringify(relation)).not.toContain("🙂".repeat(241));
	});

	it("uses a grounded replacement when relation core values are unrepresentable", () => {
		const snapshot = richSnapshot();
		snapshot.issues[0]!.relations[0]!.relatedIdentifier = "🙂".repeat(241);
		const manifest = generateTasks(snapshot);
		expect(manifest.tasks.map((task) => task.id)).toContain("relation-missing-search-view");
		expect(manifest.tasks.map((task) => task.id)).not.toContain("relation-traversal");
	});

	it("falls back instead of selecting or slicing an oversized Unicode comment", () => {
		const manifest = generateTasks(oversizedCommentSnapshot());

		expect(manifest.tasks.map((task) => task.id)).not.toContain("issue-comments");
		expect(manifest.tasks.map((task) => task.id)).toContain("issue-url");
		expect(manifest.warnings.join(" ")).toContain(
			"no comment body was representable",
		);
		expect(JSON.stringify(manifest)).not.toContain("long-comment");
		expect(JSON.stringify(manifest)).not.toContain("🙂".repeat(241));
	});

	it("accepts a comment body at exactly the Unicode character limit", () => {
		const body = "🙂".repeat(240);
		const manifest = generateTasks(exactLimitCommentSnapshot());
		const comments = manifest.tasks.find((task) => task.id === "issue-comments");

		expect(comments).toBeDefined();
		expect(comments?.requiredFacts).toContainEqual({
			label: "selected comment body",
			kind: "contains",
			value: body,
		});
		expect(Array.from(body)).toHaveLength(240);
	});

	it("does not depend on mutable global counters", () => {
		const first = generateTasks(richSnapshot());
		const second = generateTasks(richSnapshot());
		expect(first.tasks.map((task) => task.id)).toEqual(
			second.tasks.map((task) => task.id),
		);
	});
});
