import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateResults,
  filterResults,
  latestMatrixRunId,
  metadataFromResults,
  readResults,
  renderCsvReport,
  renderMarkdownReport,
  selectCohort,
  validateCohort,
  writeReports,
} from "../src/report.js";
import { result } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("report aggregation", () => {
  it("aggregates per-run means and distributions without leaking final answers", () => {
    const results = [
      result({ wallTimeMs: 1000, judgeWallTimeMs: 9000, orchestrationWallTimeMs: 12000, toolCalls: 1 }),
      result({
        resultId: "result-2",
        condition: "mcp",
        matrixRunId: "run-1",
        startedAt: "2026-08-05T12:00:02.000Z",
        mcpToolCalls: 1,
        bashToolCalls: 0,
        toolCalls: 3,
        wallTimeMs: 3000,
        overallPassed: false,
        deterministicGrade: { ...result().deterministicGrade, passed: false },
        llmGrade: { status: "failed", model: "claude-sonnet-4-6", score: 0, rationale: "no" },
        gradingMode: "deterministic+llm",
        reportedCostUsd: undefined,
      }),
    ];
    const aggregate = aggregateResults(results);
    expect(aggregate.runs).toBe(2);
    expect(aggregate.passed).toBe(1);
    expect(aggregate.byCondition.map((row) => row.key)).toEqual(["axi", "mcp"]);
    expect(aggregate.byTask).toHaveLength(2);
    expect(aggregate.byCondition.find((row) => row.condition === "axi")?.meanWallTimeMs).toBe(1000);
    expect(aggregate.wallTimeMs).toBe(4000);
    expect(aggregate.byCondition.find((row) => row.condition === "mcp")?.meanToolCalls).toBe(3);
    expect(aggregate.byCondition.find((row) => row.condition === "mcp")?.missingCostCount).toBe(1);
    expect(aggregate.byCondition.find((row) => row.condition === "mcp")?.meanReportedCostUsd).toBeUndefined();
    const markdown = renderMarkdownReport(results, aggregate);
    const csv = renderCsvReport(aggregate);
    expect(markdown).toContain("Summary by condition (per-run means)");
    expect(markdown).toContain("Totals (not comparable averages)");
    expect(markdown).toContain("Task manifest hash(es): task-manifest-hash");
    expect(markdown).not.toContain("secret dynamic answer");
    expect(csv).toContain("mean_wall_time_ms");
    expect(csv).toContain("missing_cost_count");
    expect(csv).not.toContain("secret dynamic answer");
  });

  it("reports deterministic/judge agreement and excludes skipped or error judges", () => {
    const results = [
      result({ llmGrade: { status: "passed", model: "judge" } }),
      result({
        resultId: "agree-failed",
        deterministicGrade: { ...result().deterministicGrade, passed: false },
        llmGrade: { status: "failed", model: "judge" },
      }),
      result({ resultId: "disagree", llmGrade: { status: "failed", model: "judge" } }),
      result({ resultId: "judge-error", llmGrade: { status: "error", model: "judge" } }),
      result({ resultId: "judge-skipped" }),
    ];
    const aggregate = aggregateResults(results);
    expect(aggregate.judgeAgreement).toBe(2);
    expect(aggregate.judgeAgreementConsidered).toBe(3);
    expect(aggregate.judgeAgreementRate).toBeCloseTo(2 / 3);
    expect(renderMarkdownReport(results, aggregate)).toContain("2/3 (66.7%)");
    const csv = renderCsvReport(aggregate);
    expect(csv).toContain("judge_agreement,judge_agreement_considered,judge_agreement_rate");
    expect(csv).toContain(",2,3,0.666667,");
  });

  it("counts each incident separately from affected-run rates", () => {
    const aggregate = aggregateResults([
      result({
        safetyViolationCount: 2,
        policyIncidentCount: 3,
        commandErrorCount: 2,
        apiErrorCount: 1,
        toolErrorCount: 4,
        infrastructureErrorCount: 1,
        expectedErrorCount: 2,
        errorCount: 8,
      }),
      result({ resultId: "result-2", repeatIndex: 2 }),
    ]);
    expect(aggregate.safetyViolations).toBe(2);
    expect(aggregate.unsafeRuns).toBe(1);
    expect(aggregate.safetyRate).toBe(0.5);
    expect(aggregate.policyIncidents).toBe(3);
    expect(aggregate.policyIncidentRuns).toBe(1);
    expect(aggregate.commandErrors).toBe(2);
    expect(aggregate.apiErrors).toBe(1);
    expect(aggregate.otherToolErrors).toBe(4);
    expect(aggregate.infrastructureErrors).toBe(1);
    expect(aggregate.expectedErrors).toBe(2);
    expect(aggregate.errors).toBe(8);
    expect(aggregate.errorRuns).toBe(1);
    expect(aggregate.errorRate).toBe(0.5);
    expect(aggregate.safetyRate).toBeLessThanOrEqual(1);
    expect(aggregate.policyIncidentRate).toBeLessThanOrEqual(1);
    expect(aggregate.commandErrorRate).toBeLessThanOrEqual(1);
    expect(aggregate.apiErrorRate).toBeLessThanOrEqual(1);
    expect(aggregate.otherToolErrorRate).toBeLessThanOrEqual(1);
    expect(aggregate.infrastructureErrorRate).toBeLessThanOrEqual(1);
    expect(aggregate.expectedErrorRate).toBeLessThanOrEqual(1);
    expect(renderCsvReport(aggregate)).toContain("policy_incidents");
    expect(renderCsvReport(aggregate)).toContain("other_tool_errors");
    expect(renderMarkdownReport([
      result({ safetyViolationCount: 2, policyIncidentCount: 3, errorCount: 8 }),
      result({ resultId: "result-2", repeatIndex: 2 }),
    ], aggregate)).toContain("Policy incidents / affected runs");
    expect(renderMarkdownReport([
      result({ safetyViolationCount: 2, errorCount: 8 }),
      result({ resultId: "result-2", repeatIndex: 2 }),
    ], aggregate)).toContain("do not override correctness");
  });

  it("treats missing new counters as zero for legacy result rows", () => {
    const legacy = { ...result() };
    delete legacy.expectedErrorCount;
    delete legacy.commandErrorCount;
    delete legacy.apiErrorCount;
    delete legacy.toolErrorCount;
    delete legacy.infrastructureErrorCount;
    delete legacy.policyIncidentCount;
    delete legacy.policyIncidents;
    const aggregate = aggregateResults([legacy]);
    expect(aggregate.expectedErrors).toBe(0);
    expect(aggregate.commandErrors).toBe(0);
    expect(aggregate.apiErrors).toBe(0);
    expect(aggregate.otherToolErrors).toBe(0);
    expect(aggregate.infrastructureErrors).toBe(0);
    expect(aggregate.policyIncidents).toBe(0);
  });

  it("validates expected cells and rejects interrupted, duplicate, or mixed cohorts", () => {
    const metadata = {
      expectedConditions: ["axi", "mcp"] as const,
      expectedTaskIds: ["issue-lookup", "issue-fields"] as const,
      expectedRepeatCount: 2,
      judgeEnabled: false,
    };
    const cohort = metadata.expectedConditions.flatMap((condition) =>
      metadata.expectedTaskIds.flatMap((taskId) =>
        Array.from({ length: metadata.expectedRepeatCount }, (_, index) => result({
          resultId: `${condition}-${taskId}-${index + 1}`,
          matrixRunId: "valid-cohort",
          condition,
          taskId,
          repeatIndex: index + 1,
          expectedConditions: [...metadata.expectedConditions],
          expectedTaskIds: [...metadata.expectedTaskIds],
          expectedRepeatCount: metadata.expectedRepeatCount,
          judgeEnabled: metadata.judgeEnabled,
        })),
      ),
    );
    expect(validateCohort(cohort).matrixRunId).toBe("valid-cohort");
    expect(selectCohort([...cohort, result({ matrixRunId: "older", startedAt: "2026-08-05T11:00:00.000Z" })]).results)
      .toHaveLength(cohort.length);
    expect(() => validateCohort(cohort.slice(0, -1))).toThrow(/missing expected cell/u);
    expect(() => validateCohort([...cohort.slice(0, -1), cohort[0]])).toThrow(/duplicate/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, expectedConditions: ["axi"] }
      : item))).toThrow(/mixed expected cohort metadata/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, taskId: "unexpected" }
      : item))).toThrow(/unexpected task/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, taskManifestHash: "different-task-manifest" }
      : item))).toThrow(/task manifest hash differs/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, harnessSourceHash: "different-source" }
      : item))).toThrow(/harness source hash differs/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, claudeVersion: "different-claude" }
      : item))).toThrow(/Claude version differs/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, axiBinaryHash: "different-axi" }
      : item))).toThrow(/AXI binary hash differs/u);
  });

  it("selects and filters one matrix cohort instead of mixing append-only runs", () => {
    const results = [
      result({ matrixRunId: "old", startedAt: "2026-08-05T12:00:00.000Z" }),
      result({ resultId: "new", matrixRunId: "new", startedAt: "2026-08-05T12:10:00.000Z" }),
    ];
    expect(latestMatrixRunId(results)).toBe("new");
    expect(filterResults(results, { matrixRunIds: ["old"] })).toHaveLength(1);
    expect(metadataFromResults([results[1]])).toMatchObject({
      matrixRunIds: ["new"],
      taskManifestHashes: ["task-manifest-hash"],
    });
  });

  it("refuses to switch cohorts while writing already-filtered reports", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-report-write-test-"));
    temporaryDirectories.push(directory);
    await expect(writeReports(
      join(directory, "report.md"),
      join(directory, "report.csv"),
      [result({ matrixRunId: "run-a" }), result({ resultId: "result-2", matrixRunId: "run-b" })],
      "run-a",
    )).rejects.toThrow(/one selected matrix cohort/u);
  });

  it("reads appended JSONL results and returns an empty missing file", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-report-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "results.jsonl");
    await writeFile(filePath, `${JSON.stringify(result())}\n${JSON.stringify(result({ resultId: "result-2" }))}\n`);
    await expect(readResults(filePath)).resolves.toHaveLength(2);
    await expect(readResults(join(directory, "missing.jsonl"))).resolves.toEqual([]);
    const contents = await readFile(filePath, "utf8");
    expect(contents.split("\n").filter(Boolean)).toHaveLength(2);
  });
});
