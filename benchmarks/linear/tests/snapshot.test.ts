import { describe, expect, it } from "vitest";
import {
	captureSnapshot,
	parseSnapshot,
	ISSUE_DETAIL_LIMIT,
	ISSUE_DETAIL_QUERY,
	ISSUE_TITLE_SEARCH_QUERY,
	INVALID_ISSUE_QUERY,
	ISSUES_QUERY,
	SEARCH_VALIDATION_LIMIT,
	MAX_SNAPSHOT_LIMIT,
	PROJECTS_QUERY,
	snapshotHash,
	VIEWER_QUERY,
} from "../src/snapshot.js";
import { assertQueryOnly, GraphqlSafetyError } from "../src/graphql.js";

function responses(): Record<string, Record<string, unknown>> {
	return {
		BenchmarkViewer: { viewer: { id: "viewer-1", name: "ignored" } },
		BenchmarkTeams: {
			teams: {
				nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
				pageInfo: { hasNextPage: false },
			},
		},
		BenchmarkIssues: {
			issues: {
				nodes: [
					{
						id: "issue-1",
						identifier: "ENG-1",
						title: "Read latency",
						url: "https://linear.app/acme/issue/ENG-1",
						priority: 1,
						state: { name: "Todo", type: "backlog" },
						team: { id: "team-1", key: "ENG", name: "Engineering" },
					},
				],
				pageInfo: { hasNextPage: false },
			},
		},
		BenchmarkIssueTitleSearch: {
			issues: {
				nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Read latency" }],
				pageInfo: { hasNextPage: false },
			},
		},
		BenchmarkConfirmedAbsentIssue: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
		BenchmarkIssueDetail: {
			issue: {
				comments: {
					nodes: [
						{
							id: "comment-1",
							body: "Read this comment",
							createdAt: "ignored",
							user: { name: "ignored" },
						},
					],
					pageInfo: { hasNextPage: false },
				},
				relations: {
					nodes: [
						{
							id: "relation-1",
							type: "blocks",
							relatedIssue: { identifier: "ENG-2", title: "ignored" },
						},
					],
					pageInfo: { hasNextPage: false },
				},
				inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
			},
		},
		BenchmarkProjects: {
			projects: {
				nodes: [
					{
						id: "project-1",
						name: "Performance",
						slugId: "ignored",
						url: "https://linear.app/acme/project/performance",
						status: { name: "Planned", type: "ignored" },
						health: "ignored",
					},
				],
				pageInfo: { hasNextPage: false },
			},
		},
	};
}

describe("read-only snapshot capture", () => {
	it("parses and hashes the recorded search ground truth", () => {
		const snapshot = {
			version: 1 as const,
			generatedAt: "2026-08-05T12:00:00.000Z",
			viewer: { id: "viewer-1" },
			teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
			issues: [{ id: "issue-1", identifier: "ENG-1", title: "Read latency", comments: [], relations: [] }],
			projects: [],
			searchIssueIdentifier: "ENG-1",
			confirmedAbsentIssueIdentifier: "ENG-999999999",
			warnings: [],
		};
		expect(parseSnapshot(snapshot).searchIssueIdentifier).toBe("ENG-1");
		expect(snapshotHash(snapshot)).not.toBe(snapshotHash({ ...snapshot, searchIssueIdentifier: "ENG-2" }));
	});

	it("rejects snapshots with a missing confirmed absence field", () => {
		const snapshot = {
			version: 1 as const,
			generatedAt: "2026-08-05T12:00:00.000Z",
			viewer: { id: "viewer-1" },
			teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
			issues: [{ id: "issue-1", identifier: "ENG-1", title: "Read latency", comments: [], relations: [] }],
			projects: [],
			searchIssueIdentifier: "ENG-1",
			warnings: [],
		};
		expect(() => parseSnapshot(snapshot)).toThrow(/invalid or incomplete/u);
		expect(() => parseSnapshot({ ...snapshot, confirmedAbsentIssueIdentifier: "" })).toThrow(/invalid or incomplete/u);
	});

	it("uses staged bounded queries and keeps only task-relevant facts", async () => {
		const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
			[];
		const fixture = responses();
		const snapshot = await captureSnapshot({
			requester: async (query, variables) => {
				calls.push({ query, variables });
				const operation = query.match(/query\s+(\w+)/u)?.[1];
				if (!operation || !fixture[operation]) {
					throw new Error(`missing fixture for ${operation ?? "unknown"}`);
				}
				return fixture[operation];
			},
			now: () => new Date("2026-08-05T12:00:00.000Z"),
		});
		expect(calls).toHaveLength(7);
		expect(calls.map((call) => call.query)).toContain(ISSUES_QUERY);
		expect(calls.map((call) => call.query)).toContain(ISSUE_TITLE_SEARCH_QUERY);
		expect(calls.map((call) => call.query)).toContain(INVALID_ISSUE_QUERY);
		expect(INVALID_ISSUE_QUERY).toContain("includeArchived:true");
		expect(calls.find((call) => call.query === INVALID_ISSUE_QUERY)?.variables).toEqual({ number: 999999999, teamKey: "ENG" });
		expect(
			calls.find((call) => call.query === ISSUE_TITLE_SEARCH_QUERY)?.variables,
		).toEqual({ title: "Read latency", first: SEARCH_VALIDATION_LIMIT });
		expect(calls.map((call) => call.query)).toContain(ISSUE_DETAIL_QUERY);
		expect(calls.map((call) => call.query)).toContain(PROJECTS_QUERY);
		for (const call of calls) {
			expect(() => assertQueryOnly(call.query)).not.toThrow();
		}
		expect(snapshot.viewer).toEqual({ id: "viewer-1" });
		expect(snapshot.searchIssueIdentifier).toBe("ENG-1");
		expect(snapshot.confirmedAbsentIssueIdentifier).toBe("ENG-999999999");
		expect(snapshot.issues[0]).toMatchObject({
			identifier: "ENG-1",
			title: "Read latency",
			stateName: "Todo",
		});
		expect(snapshot.issues[0]).not.toHaveProperty("priority");
		expect(snapshot.issues[0].comments).toEqual([
			{ id: "comment-1", body: "Read this comment" },
		]);
		expect(snapshot.issues[0].relations).toEqual([
			{ type: "blocks", relatedIdentifier: "ENG-2", relatedTitle: "ignored" },
		]);
		expect(snapshot.projects[0]).toEqual({
			id: "project-1",
			name: "Performance",
			url: "https://linear.app/acme/project/performance",
			statusName: "Planned",
		});
		expect(ISSUES_QUERY).not.toMatch(/comments|relations|priority/iu);
		expect(PROJECTS_QUERY).not.toMatch(/slugId|health|targetDate|priority/iu);
		expect(VIEWER_QUERY).not.toMatch(/name/iu);
		expect(snapshotHash(snapshot)).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("confirms the first team-scoped issue number that is explicitly absent", async () => {
		const queried: Array<{ query: string; variables?: Record<string, unknown> }> = [];
		const snapshot = await captureSnapshot({
			requester: async (query, variables) => {
				queried.push({ query, variables });
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				if (query.includes("BenchmarkTeams")) return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } };
				if (query === ISSUES_QUERY) return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact", team: { id: "team-1", key: "ENG", name: "Engineering" } }] } };
				if (query === ISSUE_TITLE_SEARCH_QUERY) return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact" }], pageInfo: { hasNextPage: false } } };
				if (query === ISSUE_DETAIL_QUERY) return { issue: { comments: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } } };
				return { projects: { nodes: [] } };
			},
		});
		expect(snapshot.confirmedAbsentIssueIdentifier).toBe("ENG-999999999");
		expect(queried.filter((call) => call.query === INVALID_ISSUE_QUERY)).toHaveLength(1);
		expect(queried.find((call) => call.query === INVALID_ISSUE_QUERY)?.variables).toEqual({ number: 999999999, teamKey: "ENG" });
	});

	it("tries the next deterministic identifier after a collision and never exceeds the hard probe cap", async () => {
		const queried: number[] = [];
		const capture = (responsesForProbe: (number: number) => Record<string, unknown>) => captureSnapshot({
			requester: async (query, variables) => {
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query === INVALID_ISSUE_QUERY) {
					const number = Number(variables?.number);
					queried.push(number);
					return responsesForProbe(number);
				}
				if (query.includes("BenchmarkTeams")) return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } };
				if (query === ISSUES_QUERY) return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact", team: { id: "team-1", key: "ENG", name: "Engineering" } }] } };
				if (query === ISSUE_TITLE_SEARCH_QUERY) return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact" }], pageInfo: { hasNextPage: false } } };
				if (query === ISSUE_DETAIL_QUERY) return { issue: { comments: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } } };
				return { projects: { nodes: [] } };
			},
		});
		const snapshot = await capture((number) => ({
			issues: { nodes: number === 999999999 ? [{ id: "collision" }] : [], pageInfo: { hasNextPage: false } },
		}));
		expect(snapshot.confirmedAbsentIssueIdentifier).toBe("ENG-999999998");
		expect(queried).toEqual([999999999, 999999998]);

		await expect(capture(() => ({ issues: { nodes: [{ id: "collision" }], pageInfo: { hasNextPage: false } } }))).rejects.toThrow(/10 query-only probes/u);
		expect(queried.slice(-10)).toHaveLength(10);
	});

	it("propagates an absence-probe request error instead of treating it as absence", async () => {
		await expect(captureSnapshot({
			requester: async (query) => {
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query === INVALID_ISSUE_QUERY) throw new Error("transport failure");
				if (query.includes("BenchmarkTeams")) return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } };
				return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact", team: { id: "team-1", key: "ENG", name: "Engineering" } }] } };
			},
		})).rejects.toThrow(/transport failure/u);
	});

	it("rejects substring ambiguity, detects duplicates beyond the initial list, and accepts a unique probe", async () => {
		const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
		const issues = [
			{ id: "issue-1", identifier: "ENG-1", title: "Alpha", state: { name: "Todo" } },
			{ id: "issue-2", identifier: "ENG-2", title: "Alpha extended", state: { name: "Todo" } },
		];
		const snapshot = await captureSnapshot({
			first: 2,
			requester: async (query, variables) => {
				calls.push({ query, variables });
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query.includes("BenchmarkTeams")) {
					return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false } } };
				}
				if (query === ISSUES_QUERY) {
					return { issues: { nodes: issues.map((issue) => ({ ...issue, team: { id: "team-1", key: "ENG", name: "Engineering" } })), pageInfo: { hasNextPage: false } } };
				}
				if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				if (query === ISSUE_TITLE_SEARCH_QUERY) {
					const title = String(variables?.title);
					return {
						issues: {
							nodes: title === "Alpha"
								? issues.map(({ id, identifier, title: issueTitle }) => ({ id, identifier, title: issueTitle }))
								: [{ id: "issue-2", identifier: "ENG-2", title: "Alpha extended" }],
							pageInfo: { hasNextPage: false },
						},
					};
				}
				if (query === ISSUE_DETAIL_QUERY) {
					return { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } }, relations: { nodes: [], pageInfo: { hasNextPage: false } }, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } } } };
				}
				return { projects: { nodes: [], pageInfo: { hasNextPage: false } } };
			},
		});
		expect(snapshot.searchIssueIdentifier).toBe("ENG-2");
		expect(calls.filter((call) => call.query === ISSUE_TITLE_SEARCH_QUERY)).toHaveLength(2);
		expect(calls.filter((call) => call.query === ISSUE_TITLE_SEARCH_QUERY).every((call) => call.variables?.first === SEARCH_VALIDATION_LIMIT)).toBe(true);
	});

	it("skips unrepresentable issue identifiers and titles during search-source validation", async () => {
		const longTitle = "🙂".repeat(241);
		const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
		const snapshot = await captureSnapshot({
			first: 2,
			requester: async (query, variables) => {
				calls.push({ query, variables });
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				if (query.includes("BenchmarkTeams")) return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }] } };
				if (query === ISSUES_QUERY) return { issues: { nodes: [
					{ id: "long", identifier: "ENG-1", title: longTitle, team: { id: "team-1", key: "ENG", name: "Engineering" } },
					{ id: "short", identifier: "ENG-2", title: "Representable", team: { id: "team-1", key: "ENG", name: "Engineering" } },
				] } };
				if (query === ISSUE_TITLE_SEARCH_QUERY) return { issues: { nodes: [{ id: "short", identifier: "ENG-2", title: "Representable" }], pageInfo: { hasNextPage: false } } };
				if (query === ISSUE_DETAIL_QUERY) return { issue: { comments: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] } } };
				return { projects: { nodes: [] } };
			},
		});
		expect(snapshot.searchIssueIdentifier).toBe("ENG-2");
		expect(calls.filter((call) => call.query === ISSUE_TITLE_SEARCH_QUERY).map((call) => call.variables?.title)).toEqual(["Representable"]);
		expect(snapshot.issues[0]?.title).toBe(longTitle);
	});

	it("rejects duplicate validation results beyond the initial issue response and hasNextPage", async () => {
		const capture = async (probe: Record<string, unknown>) => captureSnapshot({
			first: 1,
			requester: async (query) => {
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query.includes("BenchmarkTeams")) return { teams: { nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }], pageInfo: { hasNextPage: false } } };
				if (query === ISSUES_QUERY) return { issues: { nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact", team: { id: "team-1", key: "ENG", name: "Engineering" } }], pageInfo: { hasNextPage: false } } };
				if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				if (query === ISSUE_TITLE_SEARCH_QUERY) return { issues: probe };
				if (query === ISSUE_DETAIL_QUERY) return { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } }, relations: { nodes: [], pageInfo: { hasNextPage: false } }, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } } } };
				return { projects: { nodes: [], pageInfo: { hasNextPage: false } } };
			},
		});
		const duplicate = await capture({ nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact" }, { id: "issue-2", identifier: "ENG-2", title: "Exact" }], pageInfo: { hasNextPage: false } });
		expect(duplicate.searchIssueIdentifier).toBeUndefined();
		const paginated = await capture({ nodes: [{ id: "issue-1", identifier: "ENG-1", title: "Exact" }], pageInfo: { hasNextPage: true } });
		expect(paginated.searchIssueIdentifier).toBeUndefined();
	});

	it("caps primary and detail bounds and warns when optional detail fails", async () => {
		const issueNodes = Array.from({ length: 30 }, (_, index) => ({
			id: `issue-${index}`,
			identifier: `ENG-${index + 1}`,
			title: `Issue ${index + 1}`,
			state: { name: "Todo" },
			team: { id: "team-1", key: "ENG", name: "Engineering" },
		}));
		const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
			[];
		const snapshot = await captureSnapshot({
			first: 100,
			requester: async (query, variables) => {
				calls.push({ query, variables });
				if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
				if (query === ISSUES_QUERY)
					return {
						issues: { nodes: issueNodes, pageInfo: { hasNextPage: true } },
					};
				if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
				if (query.includes("BenchmarkTeams"))
					return {
						teams: {
							nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
							pageInfo: {},
						},
					};
				if (query === ISSUE_DETAIL_QUERY) throw new Error("detail unavailable");
				return { projects: { nodes: [], pageInfo: {} } };
			},
		});
		expect(snapshot.issues).toHaveLength(MAX_SNAPSHOT_LIMIT);
		expect(
			calls.filter((call) => call.query === ISSUE_DETAIL_QUERY),
		).toHaveLength(ISSUE_DETAIL_LIMIT);
		expect(
			calls
				.filter((call) => call.query === ISSUE_DETAIL_QUERY)
				.every(
					(call) =>
						call.variables?.commentFirst === 10 &&
						call.variables?.relationFirst === 10,
				),
		).toBe(true);
		expect(
			calls.filter((call) => call.query === ISSUES_QUERY)[0]?.variables?.first,
		).toBe(MAX_SNAPSHOT_LIMIT);
		expect(snapshot.warnings.join(" ")).toMatch(/first 25/u);
		expect(snapshot.warnings.join(" ")).toMatch(/first 10 issues/u);
	});

	it("fails closed when an injected optional request triggers the query guard", async () => {
		await expect(
			captureSnapshot({
				requester: async (query) => {
					if (query === VIEWER_QUERY) return { viewer: { id: "viewer-1" } };
					if (query.includes("BenchmarkTeams"))
						return {
							teams: {
								nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
							},
						};
					if (query.includes("BenchmarkIssues"))
						return {
							issues: {
								nodes: [
									{
										id: "issue-1",
										identifier: "ENG-1",
										title: "Issue",
										team: { id: "team-1", key: "ENG", name: "Engineering" },
									},
								],
							},
						};
					if (query === INVALID_ISSUE_QUERY) return { issues: { nodes: [], pageInfo: { hasNextPage: false } } };
					if (query.includes("BenchmarkIssueDetail"))
						return Promise.reject(
							new GraphqlSafetyError("injected detail mutation"),
						);
					return { projects: { nodes: [] } };
				},
			}),
		).rejects.toThrow(/injected detail mutation/u);
	});

	it("does not hide a primary query failure behind optional warnings", async () => {
		await expect(
			captureSnapshot({
				requester: async (query) => {
					if (query === VIEWER_QUERY) throw new Error("primary viewer failure");
					return { teams: { nodes: [] } };
				},
			}),
		).rejects.toThrow(/primary viewer failure/u);
	});

	it("fails clearly when core workspace data is too sparse", async () => {
		await expect(
			captureSnapshot({
				requester: async (query) => {
					if (query.includes("BenchmarkViewer")) {
						return { viewer: { id: "viewer-1" } };
					}
					if (query.includes("BenchmarkTeams")) {
						return { teams: { nodes: [] } };
					}
					return { issues: { nodes: [] } };
				},
			}),
		).rejects.toThrow(/no readable teams/u);
	});
});
