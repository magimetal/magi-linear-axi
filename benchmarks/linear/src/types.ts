export const CONDITIONS = ["axi", "mcp"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const TASK_CATEGORIES = [
  "single_step",
  "multi_step",
  "investigation",
  "error_recovery",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Interface-neutral operation kinds used by deterministic task grading. */
export type BenchmarkOperationKind = "issue_search" | "issue_view";
export type ObservedOperationKind = BenchmarkOperationKind | "help" | "other";

/**
 * The only operation failure that a task may intentionally require.
 *
 * All other required operations must have a linked, non-error result. Keeping
 * this as a closed type prevents an invalid-issue task from becoming a
 * general-purpose escape hatch for errored operations.
 */
export type RequiredOperationError = "issue_not_found";

export interface RequiredOperation {
  /** Operations are matched in the array order supplied by the task. */
  kind: BenchmarkOperationKind;
  /**
   * Exact human operand: search text for issue_search, identifier for
   * issue_view. Comparison trims only and is case-sensitive.
   */
  operand?: string;
  /**
   * Values that must occur in one linked, non-error result for this operation.
   * These are operation evidence, not facts that can be supplied by another
   * operation's result.
   */
  requiredResultValues?: readonly string[];
  /**
   * Explicitly permits only the expected issue-scoped not-found error. This is
   * used solely by the intentional invalid-issue operation.
   */
  expectedError?: RequiredOperationError;
}

export interface ViewerSnapshot {
  id: string;
}

export interface TeamSnapshot {
  id: string;
  key: string;
  name: string;
}

export interface CommentSnapshot {
  id: string;
  body?: string;
}

export interface RelationSnapshot {
  type: string;
  relatedIdentifier: string;
  relatedTitle?: string;
}

export interface IssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  url?: string;
  stateName?: string;
  team?: TeamSnapshot;
  comments: CommentSnapshot[];
  relations: RelationSnapshot[];
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  url?: string;
  statusName?: string;
}

export interface LinearSnapshot {
  version: 1;
  generatedAt: string;
  viewer: ViewerSnapshot;
  teams: TeamSnapshot[];
  issues: IssueSnapshot[];
  projects: ProjectSnapshot[];
  /** Identifier of the issue proven unique by the bounded workspace search probe. */
  searchIssueIdentifier?: string;
  /** Human identifier confirmed absent by a direct query-only lookup probe. */
  confirmedAbsentIssueIdentifier: string;
  warnings: string[];
}

export interface RequiredFact {
  label: string;
  kind: "contains" | "not_found";
  /** Expected text, or the attempted identifier for a not_found fact. */
  value?: string;
  /** Operation whose successful linked result is the only valid provenance. */
  source?: BenchmarkOperationKind;
}

export interface BenchmarkTask {
  id: string;
  category: TaskCategory;
  title: string;
  prompt: string;
  minimumToolCalls: number;
  requiredOperations: RequiredOperation[];
  requiredFacts: RequiredFact[];
  gradingHints: string[];
}

export interface TaskManifest {
  version: 1;
  generatedAt: string;
  snapshotGeneratedAt: string;
  snapshotHash: string;
  warnings: string[];
  tasks: BenchmarkTask[];
}

export interface ParsedToolCall {
  /** Claude tool-use ID; results link through ParsedToolResult.toolUseId. */
  id?: string;
  name: string;
  input: unknown;
  kind: "bash" | "mcp" | "other";
}

export interface ParsedToolResult {
  /** ID of the originating ParsedToolCall. */
  toolUseId: string;
  text: string;
  isError: boolean;
}

export interface ClaudeUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reportedCostUsd?: number;
}

export const MAX_COMPONENT_TIMING_MS = 60 * 60 * 1000;
export const MAX_COMPONENT_EVENT_COUNT = 10_000;

export interface TimingMetric {
  totalMs: number;
  count: number;
}

export const COMPONENT_TIMING_METRIC_KEYS = [
  "claudeReportedDurationMs",
  "claudeProcessLifetimeMs",
  "brokerSetupMs",
  "wrapperRoundTripMs",
  "axiChildLifetimeMs",
  "graphqlAttemptMs",
  "renderMs",
  "streamParseMs",
  "orchestrationOutsidePrimaryMs",
] as const;
export type ComponentTimingMetricKey = (typeof COMPONENT_TIMING_METRIC_KEYS)[number];
export type ComponentTimingKey = ComponentTimingMetricKey | "retries";
export interface ComponentTiming {
  claudeReportedDurationMs?: TimingMetric;
  claudeProcessLifetimeMs?: TimingMetric;
  brokerSetupMs?: TimingMetric;
  wrapperRoundTripMs?: TimingMetric;
  axiChildLifetimeMs?: TimingMetric;
  graphqlAttemptMs?: TimingMetric;
  renderMs?: TimingMetric;
  streamParseMs?: TimingMetric;
  retries?: number;
  coverage: ComponentTimingKey[];
  orchestrationOutsidePrimaryMs?: TimingMetric;
}
export type TerminalResultStatus = "success" | "non_success" | "missing";

export interface ParsedClaudeStream {
  finalAnswer: string;
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  usage: ClaudeUsage;
  turns: number;
  durationMs?: number;
  errors: string[];
  parseErrors: number;
  terminalStatus: TerminalResultStatus;
  exitCode?: number;
  signal?: string;
}

export interface SafetyViolation {
  source: "axi-bash" | "mcp-tool" | "tool-policy";
  operation: string;
  message: string;
}

/** A local trajectory-policy finding that is reported separately from hard safety. */
export interface PolicyIncident {
  source: "axi-bash" | "mcp-tool" | "tool-policy";
  operation: string;
  message: string;
}

export interface FactCheck {
  label: string;
  passed: boolean;
  grounded: boolean;
}

export interface DeterministicGrade {
  passed: boolean;
  score: number;
  reason: string;
  factChecks: FactCheck[];
  /** Full classified operation trace, including rejected help/other calls. */
  operationTrace?: ObservedOperationKind[];
  /** Includes exact order/count, operands, and linked result semantics. */
  operationChecksPassed?: boolean;
  toolUseRequired: boolean;
  toolUseObserved: boolean;
  minimumToolCalls: number;
  observedToolCalls: number;
  infrastructureFailure: boolean;
}

export interface LlmGrade {
  status: "passed" | "failed" | "error" | "skipped";
  model: string;
  score?: number;
  rationale?: string;
  output?: string;
}

export interface CohortMetadata {
  expectedConditions: Condition[];
  expectedTaskIds: string[];
  expectedRepeatCount: number;
  /** Whether this cohort intends to run the optional judge. */
  judgeEnabled: boolean;
  /** Exact hash of the loaded task manifest content. */
  taskManifestHash?: string;
}

export interface BenchmarkResult {
  resultId: string;
  matrixRunId: string;
  condition: Condition;
  taskId: string;
  category: TaskCategory;
  repeatIndex: number;
  model: string;
  judgeModel: string;
  expectedConditions: Condition[];
  expectedTaskIds: string[];
  expectedRepeatCount: number;
  judgeEnabled: boolean;
  timestamp: string;
  startedAt: string;
  completedAt: string;
  /** Agent/interface execution time; judge execution and judge artifact writes are excluded. */
  wallTimeMs: number;
  judgeWallTimeMs?: number;
  /** Bounded component timings; no prompts, answers, workspace facts, or credentials. */
  componentTiming?: ComponentTiming;
  orchestrationWallTimeMs?: number;
  benchmarkSeed: string;
  snapshotTimestamp: string;
  snapshotHash: string;
  /** Exact SHA-256 of the task manifest content used for this result. */
  taskManifestHash: string;
  harnessCommit?: string;
  /** Deterministic hash of benchmark source/config/documentation inputs. */
  harnessSourceHash?: string;
  /** SHA-256 of the resolved AXI executable when the cohort includes AXI. */
  axiBinaryHash?: string;
  /** Bounded output of the exact Claude executable's --version command. */
  claudeVersion?: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reportedCostUsd?: number;
  turns: number;
  toolCalls: number;
  bashToolCalls: number;
  mcpToolCalls: number;
  /** Backward-compatible aggregate of unexpected command/API/tool/infrastructure errors. */
  errorCount: number;
  expectedErrorCount?: number;
  commandErrorCount?: number;
  apiErrorCount?: number;
  toolErrorCount?: number;
  infrastructureErrorCount?: number;
  /** Number of linked tool results, including error results. */
  linkedToolEvidenceCount?: number;
  safetyViolationCount: number;
  safetyViolations: SafetyViolation[];
  policyIncidentCount?: number;
  policyIncidents?: PolicyIncident[];
  finalAnswer: string;
  deterministicGrade: DeterministicGrade;
  llmGrade: LlmGrade;
  overallPassed: boolean;
  gradingMode: "deterministic" | "deterministic+llm" | "deterministic+llm-error";
  rawPath: string;
  judgeRawPath?: string;
}

export interface BenchmarkPaths {
  packageRoot: string;
  repoRoot: string;
  snapshotFile: string;
  tasksFile: string;
  resultsDir: string;
  resultsFile: string;
  reportMarkdownFile: string;
  reportCsvFile: string;
}

export interface ResultFilters {
  taskIds?: string[];
  categories?: TaskCategory[];
  conditions?: Condition[];
  matrixRunId?: string;
  matrixRunIds?: string[];
}
