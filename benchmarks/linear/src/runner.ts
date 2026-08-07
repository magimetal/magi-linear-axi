import { randomUUID, createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createEmptyMcpConfig, createMcpConfig, DEFAULT_CLAUDE_BIN, executeClaude, type ClaudeExecution } from "./claude.js";
import { createAxiBroker, type AxiBrokerHandle } from "./broker.js";
import { LINEAR_GRAPHQL_ENDPOINT } from "./graphql.js";
import { boundedToolEvidence, classifyErrors, gradeDeterministically, linkedToolEvidenceCount, runJudge, toolUseCounts } from "./grader.js";
import { appendResult } from "./report.js";
import { redactSecrets, scanAudit } from "./safety.js";
import { parseSnapshot } from "./snapshot.js";
import {
	answerContractPrompt,
	canonicalAnswerJsonSchema,
} from "./answer-contract.js";
import { generateTasks, parseTaskManifest } from "./tasks.js";
import { MAX_COMPONENT_EVENT_COUNT, MAX_COMPONENT_TIMING_MS } from "./types.js";
import type {
	AnswerContract,
	BenchmarkPaths,
	BenchmarkResult,
	BenchmarkTask,
	CohortMetadata,
	Condition,
	LlmGrade,
	ParsedClaudeStream,
	TaskManifest,
	ComponentTiming,
	TimingMetric,
} from "./types.js";

export interface BenchmarkInputs {
  snapshotGeneratedAt: string;
  snapshotHash: string;
  /** Exact SHA-256 of the task manifest content loaded from disk. */
  taskManifestHash: string;
  tasks: BenchmarkTask[];
  warnings: string[];
}

export interface RunCaseOptions {
  paths: BenchmarkPaths;
  inputs: BenchmarkInputs;
  task: BenchmarkTask;
  condition: Condition;
	answerContract: AnswerContract;
  repeatIndex: number;
  benchmarkSeed: string;
  /** Shared by all cases in one run or matrix invocation. */
  matrixRunId?: string;
  /** Expected cells and judge intent shared by every result in the cohort. */
  cohort?: CohortMetadata;
  model: string;
  judgeModel: string;
  useJudge: boolean;
  claudeBin?: string;
  axiBin?: string;
  timeoutMs?: number;
  apiKey: string;
  /** Loopback HTTP is accepted only for hermetic benchmark tests. */
  endpoint?: string;
  harnessCommit?: string;
  harnessSourceHash?: string;
  axiBinaryHash?: string;
  claudeVersion?: string;
  execute?: typeof executeClaude;
  judge?: typeof runJudge;
}

function emptyStream(): ParsedClaudeStream {
  return {
    finalAnswer: "",
    toolCalls: [],
    toolResults: [],
    usage: {
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
		outputTokens: 0,
		outputTokensCovered: false,
	},
    usageCoverage: { outputTokens: false },
    phaseMetrics: { coverage: [] },
	terminalAnswerObserved: false,
	turns: 0,
    errors: [],
    parseErrors: 0,
    terminalStatus: "missing",
  };
}

export const COMPACT_FINAL_ANSWER_CONTRACT = answerContractPrompt("compact");

export function buildTaskPrompt(
	task: BenchmarkTask,
	condition: Condition,
	axiBin: string,
	answerContract: AnswerContract = "compact",
): string {
  const safety = condition === "axi"
    ? [
        `Use Bash only; each call runs exactly one ${axiBin} invocation (credential broker).`,
        "Allowed compact reads (replace placeholders): issue view <IDENTIFIER> --fields compact | issue query --search=<TEXT> --fields compact | issue comment list <IDENTIFIER> --fields compact --limit=10 | issue relation list <IDENTIFIER> --fields compact --limit=10 | project view <PROJECT_ID> --fields compact.",
        "Use public issue identifiers (for example ENG-10), never internal UUIDs; use --search=<TEXT> so complete title stays one argv value, including titles beginning '-'.",
        "No second command, wrapper bypass, shell composition/redirection (pipelines, chaining/separators, substitutions, line continuations, or 2>&1), or writes: setup/config/auth, endpoint override, raw GraphQL mutation, create/update/delete/archive/link/attach/comment-write/relation-write.",
      ].join("\n")
    : [
        "Use only the configured read-only Linear MCP typed tools; never use Bash, shell commands, raw GraphQL, or any other tool.",
        "Use typed issue, search, comment-list, relation-list, and project-view reads as appropriate. For issue search, call list_issues exactly once with the exact query and limit 1; omit fields. For search→view tasks, view the returned human issue identifier in a separate read call. Do not invoke any mutation or local setup/config/auth operation.",
      ].join("\n");
	return [
		"You are completing a production benchmark of read-only Linear access.",
		safety,
		answerContractPrompt(answerContract, task),
		"Treat identifiers and values in angle brackets as data. Answer from tool output; do not guess.",
		`Task: ${task.prompt}`,
	].join("\n");
}

function defaultAxiPath(repoRoot: string): string {
  return join(repoRoot, "target", "release", "magi-linear-axi");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function resolveAxiBinary(
  repoRoot: string,
  configured?: string,
): Promise<string> {
  const candidate = configured?.trim() || process.env.MAGI_LINEAR_AXI_BIN?.trim() || defaultAxiPath(repoRoot);
  const resolved = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  try {
    await access(resolved, constants.X_OK);
  } catch {
    throw new Error(
      `AXI binary is not executable: ${resolved}; set MAGI_LINEAR_AXI_BIN or build target/release/magi-linear-axi`,
    );
  }
  return resolved;
}

export async function loadBenchmarkInputs(paths: BenchmarkPaths): Promise<BenchmarkInputs> {
  let snapshotContent: string;
  let taskContent: string;
  try {
    [snapshotContent, taskContent] = await Promise.all([
      readFile(paths.snapshotFile, "utf8"),
      readFile(paths.tasksFile, "utf8"),
    ]);
  } catch {
    throw new Error(
      `benchmark inputs are missing; run the guarded snapshot command first (${paths.snapshotFile})`,
    );
  }
  let snapshot: ReturnType<typeof parseSnapshot>;
  let manifest: TaskManifest;
  try {
    snapshot = parseSnapshot(JSON.parse(snapshotContent) as unknown);
    manifest = parseTaskManifest(JSON.parse(taskContent) as unknown);
  } catch (error: unknown) {
    throw new Error(
      `benchmark input JSON is invalid: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
  }
  const actualSnapshotHash = createHash("sha256").update(snapshotContent).digest("hex");
  const normalizedHash = createHash("sha256")
    .update(`${JSON.stringify(snapshot, null, 2)}\n`)
    .digest("hex");
  if (manifest.snapshotGeneratedAt !== snapshot.generatedAt ||
      (manifest.snapshotHash !== actualSnapshotHash && manifest.snapshotHash !== normalizedHash)) {
    throw new Error("snapshot and generated task manifest do not match; run snapshot again");
  }
  const regenerated = generateTasks(snapshot);
  const comparableManifest = canonicalJson({
    tasks: manifest.tasks,
    warnings: manifest.warnings,
  });
  const comparableRegenerated = canonicalJson({
    tasks: regenerated.tasks,
    warnings: regenerated.warnings,
  });
  if (comparableManifest !== comparableRegenerated) {
    throw new Error(
      "task manifest definitions do not match the parsed snapshot; regenerate tasks from the guarded snapshot",
    );
  }
  return {
    snapshotGeneratedAt: snapshot.generatedAt,
    snapshotHash: manifest.snapshotHash,
    taskManifestHash: createHash("sha256").update(taskContent).digest("hex"),
    tasks: manifest.tasks,
    warnings: [...new Set([...snapshot.warnings, ...manifest.warnings])],
  };
}

const HELPER_METADATA_MAX_LENGTH = 200;
const HELPER_MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * Fingerprint helpers do not need credentials, home-directory config, or proxy
 * settings. Keep this environment smaller than the Claude runtime allowlist.
 */
export function buildHelperSubprocessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
  };
}

function boundedHelperMetadata(output: string): string | undefined {
  const firstLine = String(output).split(/\r?\n/u)[0]?.trim();
  return firstLine ? firstLine.slice(0, HELPER_METADATA_MAX_LENGTH) : undefined;
}

function harnessCommit(repoRoot: string): string | undefined {
  try {
    const output = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: buildHelperSubprocessEnvironment(),
      maxBuffer: HELPER_MAX_OUTPUT_BYTES,
      // Never inherit or expose helper stderr in a benchmark diagnostic.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return boundedHelperMetadata(output);
  } catch {
    return undefined;
  }
}

function resultPath(paths: BenchmarkPaths, resultId: string): string {
  return join(paths.resultsDir, "raw", `${resultId}.jsonl`);
}

function judgeResultPath(paths: BenchmarkPaths, resultId: string): string {
  return join(paths.resultsDir, "raw", `${resultId}.judge.jsonl`);
}

function emptyJudge(model: string, status: LlmGrade["status"] = "skipped"): LlmGrade {
  return { status, model };
}

function defaultCohort(options: RunCaseOptions): CohortMetadata {
  return {
    expectedConditions: [options.condition],
    expectedAnswerContracts: [options.answerContract],
    expectedTaskIds: [options.task.id],
    expectedRepeatCount: options.repeatIndex,
    judgeEnabled: options.useJudge,
    taskManifestHash: options.inputs.taskManifestHash,
  };
}

const SOURCE_HASH_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "results",
  "generated",
  "snapshots",
]);

async function benchmarkSourceFiles(
  packageRoot: string,
  directory?: string,
): Promise<string[]> {
  const currentDirectory = directory ?? packageRoot;
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SOURCE_HASH_EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const filePath = join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await benchmarkSourceFiles(packageRoot, filePath);
      files.push(...nestedFiles);
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

/** Hashes benchmark source/config/docs in stable path order, excluding live artifacts. */
export async function hashBenchmarkSources(packageRoot: string): Promise<string> {
  const files = await benchmarkSourceFiles(packageRoot);
  files.sort((left, right) =>
    relative(packageRoot, left).localeCompare(relative(packageRoot, right)),
  );
  const hash = createHash("sha256");
  for (const filePath of files) {
    const pathName = relative(packageRoot, filePath).replaceAll("\\", "/");
    hash.update(pathName);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function getClaudeVersion(claudeBin = DEFAULT_CLAUDE_BIN): string {
  try {
    const output = execFileSync(claudeBin, ["--version"], {
      encoding: "utf8",
      env: buildHelperSubprocessEnvironment(),
      maxBuffer: HELPER_MAX_OUTPUT_BYTES,
      timeout: 10_000,
      // Version helpers do not need stderr. Ignoring it prevents child output
      // from being copied into an error or diagnostic.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const version = boundedHelperMetadata(output);
    if (!version) {
      throw new Error("Claude --version returned no output");
    }
    return version;
  } catch {
    throw new Error("could not capture Claude --version");
  }
}

export interface BenchmarkFingerprints {
  harnessSourceHash: string;
  axiBinaryHash?: string;
  claudeVersion: string;
}

export async function getBenchmarkFingerprints(
  paths: BenchmarkPaths,
  options: { claudeBin?: string; axiBin?: string } = {},
): Promise<BenchmarkFingerprints> {
  const fingerprints: BenchmarkFingerprints = {
    harnessSourceHash: await hashBenchmarkSources(paths.packageRoot),
    claudeVersion: getClaudeVersion(options.claudeBin),
  };
  if (options.axiBin) {
    fingerprints.axiBinaryHash = await hashFile(options.axiBin);
  }
  return fingerprints;
}

function measured(totalMs: number, count: number): TimingMetric | undefined {
  return Number.isInteger(count) && count > 0 && count <= MAX_COMPONENT_EVENT_COUNT &&
      Number.isFinite(totalMs) && totalMs >= 0 && totalMs <= MAX_COMPONENT_TIMING_MS
    ? { totalMs, count }
    : undefined;
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= MAX_COMPONENT_TIMING_MS;
}

export async function runBenchmarkCase(options: RunCaseOptions): Promise<BenchmarkResult> {
  const orchestrationStart = performance.now();
  const startedAtDate = new Date();
  const resultId = randomUUID();
  const matrixRunId = options.matrixRunId ?? randomUUID();
  const answerContract = options.answerContract ?? "compact";
  const jsonSchema = answerContract === "canonical"
    ? canonicalAnswerJsonSchema(options.task)
    : undefined;
  const cohort = options.cohort ?? { ...defaultCohort({ ...options, answerContract }) };
  if (cohort.expectedAnswerContracts && !cohort.expectedAnswerContracts.includes(answerContract)) throw new Error("answer contract is not part of cohort");
  if (!options.inputs.taskManifestHash) {
    throw new Error("benchmark inputs are missing the exact task manifest hash");
  }
  if (cohort.taskManifestHash && cohort.taskManifestHash !== options.inputs.taskManifestHash) {
    throw new Error("cohort task manifest hash does not match the loaded task manifest");
  }
  const axiCandidate = options.axiBin ?? defaultAxiPath(options.paths.repoRoot);
  const axiBin = isAbsolute(axiCandidate) ? axiCandidate : resolve(options.paths.repoRoot, axiCandidate);
  const harnessSourceHash = options.harnessSourceHash ??
    await hashBenchmarkSources(options.paths.packageRoot);
  let axiBinaryHash = options.axiBinaryHash;
  if (!axiBinaryHash && options.condition === "axi") {
    try {
      axiBinaryHash = await hashFile(axiBin);
    } catch {
      // Injected test executors may use a virtual AXI path; live CLI paths are hashed before execution.
    }
  }
  const execute = options.execute ?? executeClaude;
  const judge = options.judge ?? runJudge;
  const workspace = await mkdtemp(join(tmpdir(), "linear-benchmark-case-"));
  const xdgConfigHome = join(workspace, "xdg-config");
  const timingFile = join(workspace, "timing.jsonl");
  const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
  const benchmarkStart = performance.now();
  let benchmarkWallTimeMs = 0;
  let brokerSetupMs: number | undefined;
  let judgeWallTimeMs: number | undefined;
  let mcpConfig: Awaited<ReturnType<typeof createMcpConfig>> | undefined;
  let axiBroker: AxiBrokerHandle | undefined;
  let exposedAxiBin = axiBin;
  try {
    let execution: ClaudeExecution = {
      stdout: "",
      stderr: "",
      parsed: emptyStream(),
    };
    try {
      await mkdir(xdgConfigHome, { recursive: true, mode: 0o700 });
      const brokerStarted = performance.now();
      if (options.condition === "axi") {
        axiBroker = await createAxiBroker({
          apiKey: options.apiKey,
          axiBin,
          endpoint,
          xdgConfigHome,
          cwd: workspace,
          environment: process.env,
          timingFile,
        });
        brokerSetupMs = performance.now() - brokerStarted;
        exposedAxiBin = axiBroker.wrapperPath;
      }
      mcpConfig = options.condition === "mcp"
        ? await createMcpConfig()
        : await createEmptyMcpConfig();
      execution = await execute({
		mcpConfigPath: mcpConfig?.filePath,
		axiBin: exposedAxiBin,
		condition: options.condition,
		model: options.model,
		prompt: buildTaskPrompt(options.task, options.condition, exposedAxiBin, answerContract),
		...(jsonSchema !== undefined ? { jsonSchema } : {}),
		claudeBin: options.claudeBin ?? DEFAULT_CLAUDE_BIN,
        cwd: workspace,
        environment: {
          ...(options.condition === "mcp" ? { LINEAR_API_KEY: options.apiKey } : {}),
          LINEAR_API_URL: endpoint,
          XDG_CONFIG_HOME: xdgConfigHome,
          ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
        },
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        redactionSecrets: [options.apiKey],
      });
      if (execution.commandError && !execution.parsed.errors.includes(execution.commandError)) {
        execution.parsed.errors.push(execution.commandError);
      }
    } catch (error: unknown) {
      execution = {
        stdout: "",
        stderr: "",
        parsed: emptyStream(),
        commandError: error instanceof Error ? error.message : "Claude Code execution failed",
      };
      execution.parsed.errors.push(execution.commandError ?? "Claude Code execution failed");
    } finally {
      await mcpConfig?.cleanup();
      mcpConfig = undefined;
    }
    benchmarkWallTimeMs = Math.round(performance.now() - benchmarkStart);
    let graphqlAttemptMs = 0;
    let graphqlAttemptCount = 0;
    let renderMs = 0;
    let renderCount = 0;
    let retries = 0;
    let retryCovered = false;
    try {
      const events = (await readFile(timingFile, "utf8")).split("\n").filter(Boolean);
      for (const line of events) {
        try {
          const event = JSON.parse(line) as { component?: unknown; durationMs?: unknown };
          if (!validDuration(event.durationMs)) continue;
          if (event.component === "graphqlAttempt") {
            graphqlAttemptMs += event.durationMs;
            graphqlAttemptCount += 1;
            retryCovered = true;
          } else if (event.component === "graphqlRetry") {
            retries += 1;
            retryCovered = true;
          } else if (event.component === "render") {
            renderMs += event.durationMs;
            renderCount += 1;
          }
        } catch { /* Ignore malformed optional telemetry lines. */ }
      }
    } catch { /* Missing telemetry remains uncovered, never zero-filled. */ }
    const audit = scanAudit(options.condition, execution.parsed.toolCalls, exposedAxiBin);
    const deterministicGrade = gradeDeterministically(
      options.task,
      execution.parsed.finalAnswer,
      options.condition,
		execution.parsed,
		audit.safetyViolations,
		exposedAxiBin,
		answerContract,
    );
    let llmGrade = emptyJudge(options.judgeModel);
    let judgeRawPath: string | undefined;
    let gradingMode: BenchmarkResult["gradingMode"] = "deterministic";
    if (options.useJudge && audit.safetyViolations.length === 0) {
      const judgeStart = performance.now();
      const judged = await judge({
        task: options.task,
        condition: options.condition,
		answerContract,
        answer: redactSecrets(execution.parsed.finalAnswer, [options.apiKey]),
        deterministic: deterministicGrade,
        toolCounts: toolUseCounts(execution.parsed),
        toolEvidence: boundedToolEvidence(execution.parsed, [options.apiKey]),
        model: options.judgeModel,
        ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
        cwd: workspace,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        redactionSecrets: [options.apiKey],
      });
      judgeWallTimeMs = Math.round(performance.now() - judgeStart);
      llmGrade = judged.grade;
      gradingMode = llmGrade.status === "error" ? "deterministic+llm-error" : "deterministic+llm";
      judgeRawPath = judgeResultPath(options.paths, resultId);
      await mkdir(join(options.paths.resultsDir, "raw"), { recursive: true });
      await writeFile(judgeRawPath, redactSecrets(judged.raw, [options.apiKey]), { mode: 0o600 });
    }

    const counts = toolUseCounts(execution.parsed);
    const errors = classifyErrors(execution.parsed, options.task);
    const overallPassed = audit.safetyViolations.length === 0 && deterministicGrade.passed &&
      (!options.useJudge || llmGrade.status === "passed");
    const rawFile = resultPath(options.paths, resultId);
    await mkdir(join(options.paths.resultsDir, "raw"), { recursive: true });
    await writeFile(rawFile, redactSecrets(execution.stdout, [options.apiKey]), { mode: 0o600 });
    const completedAtDate = new Date();
    const orchestrationWallTimeMs = Math.round(performance.now() - orchestrationStart);
    const orchestrationOutsidePrimaryMs = Math.max(
      0,
      orchestrationWallTimeMs - benchmarkWallTimeMs - (judgeWallTimeMs ?? 0),
    );
    const coverage: ComponentTiming["coverage"] = [];
    const componentTiming: ComponentTiming = { coverage };
    const add = (
      key: Exclude<keyof ComponentTiming, "coverage" | "retries">,
      metric: TimingMetric | undefined,
    ): void => {
      if (!metric) return;
      (componentTiming as unknown as Record<string, unknown>)[key] = metric;
      coverage.push(key);
    };
    add("claudeReportedDurationMs", measured(execution.parsed.durationMs ?? 0, execution.parsed.durationMs === undefined ? 0 : 1));
    add("claudeProcessLifetimeMs", measured(execution.claudeProcessLifetimeMs ?? 0, execution.claudeProcessLifetimeMs === undefined ? 0 : 1));
    add("brokerSetupMs", measured(brokerSetupMs ?? 0, brokerSetupMs === undefined ? 0 : 1));
    add("wrapperRoundTripMs", measured(axiBroker?.timing.wrapperRoundTripMs ?? 0, axiBroker?.timing.wrapperRoundTripCount ?? 0));
    add("axiChildLifetimeMs", measured(axiBroker?.timing.axiChildMs ?? 0, axiBroker?.timing.axiChildCount ?? 0));
    add("graphqlAttemptMs", measured(graphqlAttemptMs, graphqlAttemptCount));
    add("renderMs", measured(renderMs, renderCount));
    add("streamParseMs", measured(execution.streamParseMs ?? 0, execution.streamParseMs === undefined ? 0 : 1));
    add("orchestrationOutsidePrimaryMs", measured(orchestrationOutsidePrimaryMs, 1));
    if (retryCovered) {
      componentTiming.retries = retries;
      coverage.push("retries");
    }
    const result: BenchmarkResult = {
      resultId,
      matrixRunId,
      condition: options.condition,
      answerContract,
      taskId: options.task.id,
      category: options.task.category,
      repeatIndex: options.repeatIndex,
      model: options.model,
      judgeModel: options.judgeModel,
		expectedConditions: [...cohort.expectedConditions],
      expectedAnswerContracts: [...(cohort.expectedAnswerContracts ?? [answerContract])],
      expectedTaskIds: [...cohort.expectedTaskIds],
      expectedRepeatCount: cohort.expectedRepeatCount,
      judgeEnabled: cohort.judgeEnabled,
      timestamp: startedAtDate.toISOString(),
      startedAt: startedAtDate.toISOString(),
      componentTiming,
      completedAt: completedAtDate.toISOString(),
      wallTimeMs: benchmarkWallTimeMs,
      ...(judgeWallTimeMs !== undefined ? { judgeWallTimeMs } : {}),
      orchestrationWallTimeMs,
      benchmarkSeed: options.benchmarkSeed,
      snapshotTimestamp: options.inputs.snapshotGeneratedAt,
      snapshotHash: options.inputs.snapshotHash,
      taskManifestHash: options.inputs.taskManifestHash,
      ...(options.harnessCommit ? { harnessCommit: options.harnessCommit } : {}),
      harnessSourceHash,
      ...(axiBinaryHash ? { axiBinaryHash } : {}),
      ...(options.claudeVersion ? { claudeVersion: options.claudeVersion } : {}),
		outputTokensCovered: execution.parsed.usage.outputTokensCovered,
		...(execution.parsed.terminalAnswerObserved ? { terminalAnswerCharacters: Array.from(execution.parsed.finalAnswer).length, terminalAnswerBytes: Buffer.byteLength(execution.parsed.finalAnswer, "utf8") } : {}),
      inputTokens: execution.parsed.usage.inputTokens,
      cacheReadInputTokens: execution.parsed.usage.cacheReadInputTokens,
      cacheCreationInputTokens: execution.parsed.usage.cacheCreationInputTokens,
      outputTokens: execution.parsed.usage.outputTokens,
      ...(execution.parsed.usage.reportedCostUsd !== undefined
        ? { reportedCostUsd: execution.parsed.usage.reportedCostUsd }
        : {}),
      phaseMetrics: execution.parsed.phaseMetrics,
      turns: execution.parsed.turns,
      toolCalls: counts.total,
      bashToolCalls: counts.bash,
      mcpToolCalls: counts.mcp,
      errorCount: errors.commandErrorCount + errors.apiErrorCount +
        errors.toolErrorCount + errors.infrastructureErrorCount,
      expectedErrorCount: errors.expectedErrorCount,
      commandErrorCount: errors.commandErrorCount,
      apiErrorCount: errors.apiErrorCount,
      toolErrorCount: errors.toolErrorCount,
      infrastructureErrorCount: errors.infrastructureErrorCount,
      linkedToolEvidenceCount: linkedToolEvidenceCount(execution.parsed),
      safetyViolationCount: audit.safetyViolations.length,
      safetyViolations: audit.safetyViolations,
      policyIncidentCount: audit.policyIncidents.length,
      policyIncidents: audit.policyIncidents,
      finalAnswer: redactSecrets(execution.parsed.finalAnswer, [options.apiKey]),
      deterministicGrade,
      llmGrade,
      overallPassed,
      gradingMode,
      rawPath: relative(options.paths.packageRoot, rawFile),
      ...(judgeRawPath ? { judgeRawPath: relative(options.paths.packageRoot, judgeRawPath) } : {}),
    };
    await appendResult(options.paths.resultsFile, result);
    return result;
  } finally {
    await mcpConfig?.cleanup();
    await axiBroker?.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
}

export function getHarnessCommit(paths: BenchmarkPaths): string | undefined {
  return harnessCommit(paths.repoRoot);
}
