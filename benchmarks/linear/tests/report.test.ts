import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessCanonicalAdoption,
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

function adoptionCohort(
  compactOverrides: Parameters<typeof result>[0] = {},
  canonicalOverrides: Parameters<typeof result>[0] = {},
) {
  const shared = {
    matrixRunId: "adoption-run",
    expectedConditions: ["axi"] as const,
    expectedAnswerContracts: ["compact", "canonical"] as const,
    expectedTaskIds: ["issue-lookup"],
    expectedRepeatCount: 1,
    judgeEnabled: true,
    llmGrade: { status: "passed" as const, model: "judge" },
    gradingMode: "deterministic+llm" as const,
  };
  return [
    result({
      ...shared,
      resultId: "compact",
      answerContract: "compact",
      terminalAnswerCharacters: 100,
      terminalAnswerBytes: 100,
      outputTokens: 100,
      ...compactOverrides,
    }),
    result({
      ...shared,
      resultId: "canonical",
      answerContract: "canonical",
      terminalAnswerCharacters: 80,
      terminalAnswerBytes: 80,
      outputTokens: 80,
      ...canonicalOverrides,
    }),
  ];
}

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
    expect(aggregate.byCondition.map((row) => row.key)).toEqual(["axi/compact", "mcp/compact"]);
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

  it("keeps zero-duration component samples covered and missing samples absent", () => {
    const aggregate = aggregateResults([
      result({
        componentTiming: {
          graphqlAttemptMs: { totalMs: 0, count: 1 },
          claudeProcessLifetimeMs: { totalMs: 50, count: 1 },
          retries: 0,
          coverage: ["graphqlAttemptMs", "claudeProcessLifetimeMs", "retries"],
        },
      }),
      result({ resultId: "result-2", repeatIndex: 2 }),
    ]);
    expect(aggregate.componentTimings.graphqlAttemptMs).toEqual({
      totalMs: 0,
      eventCount: 1,
      coveredRuns: 1,
      meanMs: 0,
    });
    expect(aggregate.componentTimings.claudeProcessLifetimeMs.meanMs).toBe(50);
    expect(aggregate.retryCoveredRuns).toBe(1);
    expect(aggregate.meanRetries).toBe(0);
    const markdown = renderMarkdownReport([], aggregate);
    const csv = renderCsvReport(aggregate);
    expect(markdown).toContain("graphqlAttemptMs | 0 | 0 | 1/2 | 1");
    expect(csv).toContain("graphql_attempt_ms_covered_runs");
    expect(markdown).not.toContain("secret dynamic answer");
    expect(csv).not.toContain("secret dynamic answer");
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

  it("validates condition × contract × task × repeat cohort cells", () => {
    const contracts = ["compact", "canonical"] as const;
    const conditions = ["axi", "mcp"] as const;
    const cohort = conditions.flatMap((condition) =>
      contracts.map((answerContract) => result({
        resultId: `${condition}-${answerContract}`,
        matrixRunId: "contract-cohort",
        condition,
        answerContract,
        expectedConditions: [...conditions],
        expectedAnswerContracts: [...contracts],
        expectedTaskIds: ["issue-lookup"],
        judgeEnabled: false,
      })),
    );
    expect(validateCohort(cohort).results).toHaveLength(4);
    expect(() => validateCohort(cohort.slice(0, -1))).toThrow(/missing expected cell/u);
    expect(() => validateCohort([...cohort.slice(0, -1), cohort[0]!])).toThrow(/duplicate/u);
    expect(() => validateCohort(cohort.map((item, index) => index === 0
      ? { ...item, expectedAnswerContracts: ["compact"] }
      : item))).toThrow(/mixed expected cohort metadata/u);
  });

  it("keeps uncovered answer-size metrics absent and aligns every CSV row", () => {
    const uncovered = result({
      outputTokensCovered: false,
      terminalAnswerCharacters: undefined,
      terminalAnswerBytes: undefined,
    });
    const aggregate = aggregateResults([uncovered]);
    expect(aggregate.meanOutputTokens).toBeUndefined();
    expect(aggregate.meanTerminalAnswerCharacters).toBeUndefined();
    expect(aggregate.meanTerminalAnswerBytes).toBeUndefined();
    const markdown = renderMarkdownReport([uncovered], aggregate);
    expect(markdown).toContain("n/a (0/1)");
    const [header, ...rows] = renderCsvReport(aggregate).trim().split("\n");
    const headerCells = header!.split(",");
    expect(headerCells.filter((cell) => cell === "answer_contract")).toHaveLength(1);
    for (const row of rows) {
      expect(row.split(",")).toHaveLength(headerCells.length);
      expect(row.split(",")[headerCells.indexOf("answer_contract")]).toBe("compact");
      expect(row.split(",")[headerCells.indexOf("condition")]).toBe("axi");
      expect(row.split(",")[headerCells.indexOf("mean_output_tokens")]).toBe("");
    }
  });

  it("preserves established CSV columns before appending contract metrics", () => {
    const [header] = renderCsvReport(aggregateResults([result()])).trim().split("\n");
    const columns = header!.split(",");
    const established = "task_id,category,condition,runs,passes,pass_rate,deterministic_passes,llm_passes,llm_considered,judge_agreement,judge_agreement_considered,judge_agreement_rate,safety_violations,unsafe_runs,safety_rate,hard_safety_incidents,hard_safety_runs,hard_safety_rate,policy_incidents,policy_incident_runs,policy_incident_rate,command_errors,command_error_runs,command_error_rate,api_errors,api_error_runs,api_error_rate,other_tool_errors,other_tool_error_runs,other_tool_error_rate,infrastructure_errors,infrastructure_error_runs,infrastructure_error_rate,expected_errors,expected_error_runs,expected_error_rate,errors,error_runs,error_rate,mean_input_tokens,mean_cache_read_input_tokens,mean_cache_creation_input_tokens,mean_output_tokens,mean_reported_cost_usd,reported_cost_samples,missing_cost_count,mean_wall_time_ms,p50_wall_time_ms,p95_wall_time_ms,mean_turns,mean_tool_calls,p50_tool_calls,p95_tool_calls".split(",");
    expect(columns.slice(0, established.length)).toEqual(established);
    expect(columns.indexOf("answer_contract")).toBeGreaterThan(
      columns.indexOf("retry_covered_runs"),
    );
  });

  it("rejects legacy cohorts cleanly instead of migrating missing contracts", () => {
    const legacy = {
      ...result(),
      expectedAnswerContracts: undefined,
    } as unknown as ReturnType<typeof result>;
    expect(assessCanonicalAdoption([legacy])).toMatchObject({
      status: "not_evaluable",
    });
    expect(() => validateCohort([legacy])).toThrow(
      /invalid expected answer contracts/u,
    );
  });

  it("adopts on complete pairs with character reduction despite missing token coverage", () => {
    const results = adoptionCohort(
      { outputTokensCovered: false },
      { outputTokensCovered: false },
    );
    expect(assessCanonicalAdoption(results)).toMatchObject({
      status: "adopt",
      terminalCharacterReduction: 0.2,
    });
  });

  it("retains when complete data misses target or regresses quality and operations", () => {
    expect(assessCanonicalAdoption(adoptionCohort(
      { terminalAnswerCharacters: 100, outputTokens: 100 },
      { terminalAnswerCharacters: 90, outputTokens: 90 },
    ))).toMatchObject({ status: "retain" });
    const regressed = assessCanonicalAdoption(adoptionCohort({}, {
      turns: 3,
      toolCalls: 2,
      policyIncidentCount: 1,
      infrastructureErrorCount: 1,
      deterministicGrade: {
        ...result().deterministicGrade,
        passed: false,
        factChecks: [{ label: "issue title", passed: false, grounded: false }],
      },
      llmGrade: { status: "passed", model: "judge" },
    }));
    expect(regressed.status).toBe("retain");
    expect(regressed.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("grounding"),
      expect.stringContaining("judge agreement"),
      expect.stringContaining("turns"),
      expect.stringContaining("tool calls"),
      expect.stringContaining("policy incidents"),
      expect.stringContaining("infrastructure failures"),
    ]));
  });
  it("retains when canonical quality regresses in MCP", () => {
    const axi = adoptionCohort().map((item) => ({
      ...item,
      expectedConditions: ["axi", "mcp"] as const,
    }));
    const mcp = adoptionCohort().map((item) => ({
      ...item,
      resultId: `mcp-${item.answerContract}`,
      condition: "mcp" as const,
      expectedConditions: ["axi", "mcp"] as const,
      bashToolCalls: 0,
      mcpToolCalls: 1,
      ...(item.answerContract === "canonical"
        ? {
            deterministicGrade: {
              ...item.deterministicGrade,
              passed: false,
              formatPassed: false,
              factChecks: [{ label: "fact", passed: false, grounded: false }],
            },
            llmGrade: { status: "failed" as const, model: "judge" },
          }
        : {}),
    }));
    const assessment = assessCanonicalAdoption([...axi, ...mcp]);
    expect(assessment.status).toBe("retain");
    expect(assessment.reasons).toContain(
      "canonical deterministic grading or grounding is not fully passing",
    );
  });

  it("supports token-only adoption at exactly 15% and isolates incident gates", () => {
    const tokenOnly = adoptionCohort(
      { terminalAnswerCharacters: undefined, outputTokens: 100 },
      { terminalAnswerCharacters: undefined, outputTokens: 85 },
    );
    expect(assessCanonicalAdoption(tokenOnly)).toMatchObject({
      status: "adopt",
      outputTokenReduction: 0.15,
    });

    const unavailableAlternative = adoptionCohort(
      { outputTokensCovered: false, terminalAnswerCharacters: 100 },
      { outputTokensCovered: false, terminalAnswerCharacters: 90 },
    );
    expect(assessCanonicalAdoption(unavailableAlternative).status)
      .toBe("not_evaluable");

    for (const [field, reason] of [
      ["safetyViolationCount", "hard safety incidents"],
      ["commandErrorCount", "command errors"],
      ["apiErrorCount", "API errors"],
      ["toolErrorCount", "other tool errors"],
    ] as const) {
      const assessment = assessCanonicalAdoption(
        adoptionCohort({}, { [field]: 1 }),
      );
      expect(assessment.status, field).toBe("retain");
      expect(assessment.reasons, field).toContain(`${reason} increased`);
    }
  });


  it("marks missing pairs, judges, or both size metrics not evaluable", () => {
    expect(assessCanonicalAdoption(adoptionCohort().slice(0, 1)).status)
      .toBe("not_evaluable");
    expect(assessCanonicalAdoption(adoptionCohort({}, {
      llmGrade: { status: "skipped", model: "judge" },
    })).status).toBe("not_evaluable");
    const noSize = adoptionCohort(
      { outputTokensCovered: false, terminalAnswerCharacters: undefined },
      { outputTokensCovered: false, terminalAnswerCharacters: undefined },
    );
    expect(assessCanonicalAdoption(noSize).status).toBe("not_evaluable");
  });

  it("renders adoption and covered size metrics without answer content", () => {
    const results = adoptionCohort({}, {
      finalAnswer: "sensitive-final-answer",
      deterministicGrade: {
        ...result().deterministicGrade,
        reason: "sensitive-deterministic-reason",
      },
      llmGrade: {
        status: "passed",
        model: "judge",
        rationale: "sensitive-judge-rationale",
        output: "sensitive-judge-output",
      },
    });
    const assessment = assessCanonicalAdoption(results);
    const markdown = renderMarkdownReport(results);
    const csv = renderCsvReport(aggregateResults(results), assessment);
    expect(markdown).toContain("Canonical adoption assessment: adopt");
    expect(markdown).toContain("Terminal character reduction: 20.0%");
    expect(csv).toContain("canonical_adoption_status");
    expect(csv).toContain(",adopt,");
    expect(markdown).not.toContain("secret dynamic answer");
    expect(csv).not.toContain("secret dynamic answer");
    for (const sensitive of [
      "sensitive-final-answer",
      "sensitive-deterministic-reason",
      "sensitive-judge-rationale",
      "sensitive-judge-output",
    ]) {
      expect(markdown).not.toContain(sensitive);
      expect(csv).not.toContain(sensitive);
    }
  });

  it("writes filtered rows while assessing adoption from the complete cohort", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-filtered-report-test-"));
    temporaryDirectories.push(directory);
    const cohort = adoptionCohort();
    const selected = filterResults(cohort, { answerContracts: ["canonical"] });
    const markdownPath = join(directory, "report.md");
    const csvPath = join(directory, "report.csv");
    await writeReports(
      markdownPath,
      csvPath,
      selected,
      "adoption-run",
      cohort,
    );
    const markdown = await readFile(markdownPath, "utf8");
    const csv = await readFile(csvPath, "utf8");
    expect(markdown).toContain("Canonical adoption assessment: adopt");
    expect(markdown).toContain("axi/canonical");
    expect(markdown).not.toContain("axi/compact");
    expect(csv).toContain("canonical");
    expect(csv).not.toContain(",compact,");
    expect(csv).toContain(",adopt,");
  });
  it("keeps Markdown aggregate table columns aligned", () => {
    const lines = renderMarkdownReport(adoptionCohort()).split("\n");
    for (const heading of [
      "## Summary by condition (per-run means)",
      "## Per task and condition (per-run means)",
    ]) {
      const index = lines.indexOf(heading);
      const table = lines.slice(index + 2, index + 5);
      expect(table).toHaveLength(3);
      expect(new Set(table.map((line) => line.split("|").length)).size).toBe(1);
    }
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
