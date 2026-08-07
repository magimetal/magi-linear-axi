import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "./claude.js";
import { defaultPaths, withPathOverrides } from "./paths.js";
import { createMatrixSchedule, defaultSeed } from "./random.js";
import {
	assertSnapshotFresh,
	captureSnapshot,
	DEFAULT_SNAPSHOT_LIMIT,
	snapshotHash,
	stableJson,
	writeSnapshot,
} from "./snapshot.js";
import { assertLiveReadOnlyContract } from "./safety.js";
import { validatePreflightResults } from "./preflight.js";
import { generateTasks, attachSnapshotHash } from "./tasks.js";
import {
	aggregateResults,
	filterResults,
	metadataFromResults,
	readResults,
	selectCohort,
	validateCohort,
	writeReports,
} from "./report.js";
import {
	getBenchmarkFingerprints,
	getHarnessCommit,
	loadBenchmarkInputs,
	resolveAxiBinary,
	runBenchmarkCase,
} from "./runner.js";
import {
	ANSWER_CONTRACTS,
	CONDITIONS,
	TASK_CATEGORIES,
	type AnswerContract,
	type BenchmarkPaths,
	type BenchmarkTask,
	type Condition,
	type ResultFilters,
	type TaskCategory,
} from "./types.js";

export type CliCommand =
	| "snapshot"
	| "list"
	| "run"
	| "matrix"
	| "preflight"
	| "report"
	| "help";

export interface CliOptions {
	command: CliCommand;
	positionals: string[];
	confirmReadOnly: boolean;
	noJudge: boolean;
	answerContracts?: AnswerContract[];
	conditions?: Condition[];
	taskIds?: string[];
	categories?: TaskCategory[];
	repeat: number;
	seed?: string;
	model: string;
	judgeModel: string;
	claudeBin?: string;
	axiBin?: string;
	timeoutMs?: number;
	limit: number;
	maxSnapshotAgeMinutes: number;
	runId?: string;
	snapshotFile?: string;
	tasksFile?: string;
	resultsDir?: string;
}

const COMMANDS = new Set<CliCommand>([
	"snapshot",
	"list",
	"run",
	"matrix",
	"preflight",
	"report",
	"help",
]);

function valueAfter(
	args: readonly string[],
	index: number,
	flag: string,
): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function splitValues(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function conditions(value: string): Condition[] {
	const values = splitValues(value);
	if (values.length === 0) {
		throw new Error("condition filter cannot be empty");
	}
	if (values.includes("all")) {
		return [...CONDITIONS];
	}
	for (const candidate of values) {
		if (!(CONDITIONS as readonly string[]).includes(candidate)) {
			throw new Error(`unknown condition '${candidate}'; expected axi or mcp`);
		}
	}
	return values as Condition[];
}
function answerContracts(value: string): AnswerContract[] {
	const values = splitValues(value);
	if (values.length === 0) {
		throw new Error("answer contract filter cannot be empty");
	}
	if (values.includes("all")) {
		if (values.length !== 1) {
			throw new Error("answer contract 'all' cannot be combined with other values");
		}
		return [...ANSWER_CONTRACTS];
	}
	if (
		values.some(
			(candidate) =>
				!(ANSWER_CONTRACTS as readonly string[]).includes(candidate),
		)
	) {
		throw new Error("answer contract must be compact, canonical, or all");
	}
	if (new Set(values).size !== values.length) {
		throw new Error("answer contract values must not be duplicated");
	}
	return values as AnswerContract[];
}

function categories(value: string): TaskCategory[] {
	const values = splitValues(value);
	if (values.length === 0) {
		throw new Error("category filter cannot be empty");
	}
	for (const candidate of values) {
		if (!(TASK_CATEGORIES as readonly string[]).includes(candidate)) {
			throw new Error(`unknown category '${candidate}'`);
		}
	}
	return values as TaskCategory[];
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

function positiveNumber(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive number`);
	}
	return parsed;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
	const [first, ...rest] = argv;
	let command: CliCommand = "help";
	if (first !== undefined && first !== "--help" && first !== "-h") {
		command = first as CliCommand;
	}
	if (!COMMANDS.has(command)) {
		throw new Error(`unknown command '${first}'; use --help`);
	}
	const options: CliOptions = {
		command,
		positionals: [],
		confirmReadOnly: false,
		noJudge: false,
		repeat: 1,
		model: DEFAULT_MODEL,
		judgeModel: DEFAULT_MODEL,
		limit: DEFAULT_SNAPSHOT_LIMIT,
		maxSnapshotAgeMinutes: 30,
	};
	for (let index = 0; index < rest.length; index += 1) {
		const argument = rest[index];
		if (argument === "--help" || argument === "-h") {
			options.command = "help";
			continue;
		}
		if (argument === "--confirm-read-only") {
			options.confirmReadOnly = true;
			continue;
		}
		if (argument === "--no-judge") {
			options.noJudge = true;
			continue;
		}
		if (argument === "--answer-contract") {
			options.answerContracts = answerContracts(valueAfter(rest, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--condition" || argument === "--conditions") {
			options.conditions = conditions(valueAfter(rest, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--task" || argument === "--task-id") {
			options.taskIds = [
				...(options.taskIds ?? []),
				...splitValues(valueAfter(rest, index, argument)),
			];
			index += 1;
			continue;
		}
		if (argument === "--category") {
			options.categories = [
				...(options.categories ?? []),
				...categories(valueAfter(rest, index, argument)),
			];
			index += 1;
			continue;
		}
		if (argument === "--repeat") {
			options.repeat = positiveInteger(
				valueAfter(rest, index, argument),
				argument,
			);
			index += 1;
			continue;
		}
		if (argument === "--seed") {
			options.seed = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--model") {
			options.model = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--judge-model") {
			options.judgeModel = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--claude-bin") {
			options.claudeBin = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--axi-bin") {
			options.axiBin = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--timeout-ms") {
			options.timeoutMs = positiveInteger(
				valueAfter(rest, index, argument),
				argument,
			);
			index += 1;
			continue;
		}
		if (argument === "--max-snapshot-age-minutes") {
			options.maxSnapshotAgeMinutes = positiveNumber(
				valueAfter(rest, index, argument),
				argument,
			);
			index += 1;
			continue;
		}
		if (argument === "--run-id") {
			options.runId = valueAfter(rest, index, argument);
			index += 1;
			continue;
		}
		if (argument === "--limit") {
			options.limit = positiveInteger(
				valueAfter(rest, index, argument),
				argument,
			);
			index += 1;
			continue;
		}
		if (argument === "--snapshot-file") {
			options.snapshotFile = resolve(valueAfter(rest, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--tasks-file") {
			options.tasksFile = resolve(valueAfter(rest, index, argument));
			index += 1;
			continue;
		}
		if (argument === "--results-dir") {
			options.resultsDir = resolve(valueAfter(rest, index, argument));
			index += 1;
			continue;
		}
		if (argument.startsWith("--")) {
			throw new Error(`unknown option '${argument}'`);
		}
		options.positionals.push(argument);
	}
	return options;
}

function usage(): string {
	return `Usage: npm run <snapshot|list|run|matrix|preflight|report> -- [options]

Live safety contract (required for snapshot/run/matrix):
  LINEAR_API_KEY=<read-only key> LINEAR_BENCHMARK_READ_ONLY=1 \\
    npm run snapshot -- --confirm-read-only

Commands:
  snapshot   Capture a bounded read-only oracle and generate dynamic tasks.
  list       List the generated task IDs and categories without network access.
  run        Run one condition/task, e.g. run --condition axi --task issue-lookup.
  matrix     Run filtered task x condition cases in seeded randomized order.
  preflight  Run one no-judge reachability cohort and fail on hard safety/infrastructure/tool absence.
  report     Aggregate appended results into report.md and report.csv.

Common options:
  --answer-contract compact|canonical|all
                           Select answer encoding (matrix/preflight default to both; run requires one).
  --condition axi|mcp|all   Filter conditions (matrix defaults to both).
  --task <id>               Repeatable task filter.
  --category <name>         Repeatable category filter.
  --repeat <n>              Number of attempts per matrix case (default 1).
  --seed <value>            Recorded deterministic matrix shuffle seed.
  --run-id <value>          Set an explicit matrix/run cohort ID; do not reuse it for a separate or partial invocation.
  --model <name>            Claude model (default claude-sonnet-4-6).
  --judge-model <name>      Optional judge model (default claude-sonnet-4-6).
  --no-judge                Skip the optional Claude judge and report deterministic grading.
  --max-snapshot-age-minutes <n>  Reject snapshots older than 30 minutes by default.
  --confirm-read-only       Required with the environment contract for live commands.
  --snapshot-file, --tasks-file, --results-dir  Override local artifact paths.
`;
}

function pathsFor(options: CliOptions): BenchmarkPaths {
	return withPathOverrides(defaultPaths(), {
		...(options.snapshotFile ? { snapshotFile: options.snapshotFile } : {}),
		...(options.tasksFile ? { tasksFile: options.tasksFile } : {}),
		...(options.resultsDir ? { resultsDir: options.resultsDir } : {}),
	});
}

function filteredTasks(
	tasks: readonly BenchmarkTask[],
	options: CliOptions,
): BenchmarkTask[] {
	return tasks.filter((task) => {
		if (options.taskIds && !options.taskIds.includes(task.id)) {
			return false;
		}
		if (options.categories && !options.categories.includes(task.category)) {
			return false;
		}
		return true;
	});
}

function printResultSummary(result: {
	resultId: string;
	matrixRunId: string;
	condition: string;
	taskId: string;
	overallPassed: boolean;
	safetyViolationCount: number;
	gradingMode: string;
}): void {
	console.log(
		JSON.stringify({
			resultId: result.resultId,
			matrixRunId: result.matrixRunId,
			condition: result.condition,
			taskId: result.taskId,
			passed: result.overallPassed,
			safetyViolations: result.safetyViolationCount,
			gradingMode: result.gradingMode,
		}),
	);
}

async function snapshotCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const apiKey = assertLiveReadOnlyContract(options.confirmReadOnly);
	const snapshot = await captureSnapshot({ apiKey, first: options.limit });
	const hash = snapshotHash(snapshot);
	const stamp = snapshot.generatedAt.replace(/[^0-9A-Za-z]/gu, "").slice(0, 24);
	const archiveSnapshot = join(
		dirname(paths.snapshotFile),
		`snapshot-${stamp}-${hash.slice(0, 12)}.json`,
	);
	await writeSnapshot(snapshot, archiveSnapshot);
	await writeSnapshot(snapshot, paths.snapshotFile);
	const generated = attachSnapshotHash(generateTasks(snapshot), hash);
	const serializedTasks = stableJson(generated);
	const taskManifestHash = createHash("sha256")
		.update(serializedTasks)
		.digest("hex");
	await mkdir(dirname(paths.tasksFile), { recursive: true });
	await writeFile(paths.tasksFile, serializedTasks, { mode: 0o600 });
	const archiveTasks = join(
		dirname(paths.tasksFile),
		`tasks-${stamp}-${hash.slice(0, 12)}.json`,
	);
	await writeFile(archiveTasks, serializedTasks, { mode: 0o600 });
	console.log(
		JSON.stringify(
			{
				snapshotGeneratedAt: snapshot.generatedAt,
				snapshotHash: hash,
				taskManifestHash,
				teams: snapshot.teams.length,
				issues: snapshot.issues.length,
				projects: snapshot.projects.length,
				searchIssueIdentifier: snapshot.searchIssueIdentifier ?? null,
				confirmedAbsentIssueIdentifier: snapshot.confirmedAbsentIssueIdentifier,
				tasks: generated.tasks.length,
				warnings: generated.warnings,
				snapshotLimit: DEFAULT_SNAPSHOT_LIMIT,
				issueDetailLimit: 10,
				commentDetailLimit: 10,
				relationDetailLimit: 10,
				snapshotFile: paths.snapshotFile,
				tasksFile: paths.tasksFile,
			},
			null,
			2,
		),
	);
}

async function listCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const inputs = await loadBenchmarkInputs(paths);
	const tasks = filteredTasks(inputs.tasks, options);
	console.log("task_id\tcategory\ttitle");
	for (const task of tasks) {
		console.log(`${task.id}\t${task.category}\t${task.title}`);
	}
	if (inputs.warnings.length > 0) {
		console.error(`Warnings: ${inputs.warnings.join(" | ")}`);
	}
}

function oneCondition(
	options: CliOptions,
	defaultCondition?: Condition,
): Condition {
	if (options.conditions && options.conditions.length !== 1) {
		throw new Error("this command requires exactly one condition (axi or mcp)");
	}
	const positional = options.positionals[0];
	if (positional && (CONDITIONS as readonly string[]).includes(positional)) {
		return positional as Condition;
	}
	return options.conditions?.[0] ?? defaultCondition ?? "axi";
}

function oneTask(options: CliOptions): string {
	const positionalTask = options.positionals.find(
		(value) => !(CONDITIONS as readonly string[]).includes(value),
	);
	const selected = options.taskIds ?? (positionalTask ? [positionalTask] : []);
	if (selected.length !== 1) {
		throw new Error("run requires exactly one task ID (use --task <id>)");
	}
	return selected[0];
}

async function runCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const apiKey = assertLiveReadOnlyContract(options.confirmReadOnly);
	const inputs = await loadBenchmarkInputs(paths);
	assertSnapshotFresh(
		inputs.snapshotGeneratedAt,
		options.maxSnapshotAgeMinutes,
	);
	const condition = oneCondition(options);
	const taskId = oneTask(options);
	const task = inputs.tasks.find((candidate) => candidate.id === taskId);
	if (!task) {
		throw new Error(`task '${taskId}' was not found in ${paths.tasksFile}`);
	}
	if (options.categories && !options.categories.includes(task.category)) {
		throw new Error(
			`task '${taskId}' does not match the requested category filter`,
		);
	}
	const answerContract = options.answerContracts?.length === 1 ? options.answerContracts[0] : undefined;
	if (!answerContract) throw new Error("run requires exactly one answer contract (compact or canonical)");
	const axiBin =
		condition === "axi"
			? await resolveAxiBinary(paths.repoRoot, options.axiBin)
			: (options.axiBin ??
				join(paths.repoRoot, "target", "release", "magi-linear-axi"));
	const seed = options.seed ?? defaultSeed();
	const matrixRunId = options.runId ?? randomUUID();
	const commit = getHarnessCommit(paths);
	const fingerprints = await getBenchmarkFingerprints(paths, {
		...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
		...(condition === "axi" ? { axiBin } : {}),
	});
	for (let repeatIndex = 1; repeatIndex <= options.repeat; repeatIndex += 1) {
		const result = await runBenchmarkCase({
			paths,
			inputs,
			task,
			answerContract,
			condition,
			repeatIndex,
			benchmarkSeed: seed,
			matrixRunId,
			cohort: {
				expectedConditions: [condition],
				expectedAnswerContracts: [answerContract],
				expectedTaskIds: [task.id],
				expectedRepeatCount: options.repeat,
				judgeEnabled: !options.noJudge,
				taskManifestHash: inputs.taskManifestHash,
			},
			model: options.model,
			judgeModel: options.judgeModel,
			useJudge: !options.noJudge,
			...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
			axiBin,
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: {}),
			apiKey,
			...(commit ? { harnessCommit: commit } : {}),
			harnessSourceHash: fingerprints.harnessSourceHash,
			...(fingerprints.axiBinaryHash
				? { axiBinaryHash: fingerprints.axiBinaryHash }
				: {}),
			claudeVersion: fingerprints.claudeVersion,
		});
		printResultSummary(result);
	}
}

async function matrixCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const apiKey = assertLiveReadOnlyContract(options.confirmReadOnly);
	const inputs = await loadBenchmarkInputs(paths);
	assertSnapshotFresh(
		inputs.snapshotGeneratedAt,
		options.maxSnapshotAgeMinutes,
	);
	const tasks = filteredTasks(inputs.tasks, options);
	if (tasks.length === 0) {
		throw new Error("matrix filters selected no tasks");
	}
	const selectedConditions = options.conditions ?? [...CONDITIONS];
	const selectedAnswerContracts = options.answerContracts ?? [...ANSWER_CONTRACTS];
	const seed = options.seed ?? defaultSeed();
	const schedule = createMatrixSchedule(tasks, selectedConditions, selectedAnswerContracts, options.repeat, seed);
	const matrixRunId = options.runId ?? randomUUID();
	const needsAxi = schedule.some((item) => item.condition === "axi");
	const axiBin = needsAxi ? await resolveAxiBinary(paths.repoRoot, options.axiBin) : (options.axiBin ?? join(paths.repoRoot, "target", "release", "magi-linear-axi"));
	const commit = getHarnessCommit(paths);
	const fingerprints = await getBenchmarkFingerprints(paths, {
		...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
		...(needsAxi ? { axiBin } : {}),
	});
	console.error(
		`Running ${schedule.length} cases with seed ${seed} and matrix run ${matrixRunId} (results append to ${paths.resultsFile})`,
	);
	for (const item of schedule) {
		const result = await runBenchmarkCase({
			paths,
			inputs,
			task: item.task,
			condition: item.condition,
			repeatIndex: item.repeatIndex,
			benchmarkSeed: seed,
			matrixRunId,
			cohort: {
				expectedConditions: [...selectedConditions],
				expectedAnswerContracts: [...selectedAnswerContracts],
				expectedTaskIds: tasks.map((selectedTask) => selectedTask.id),
				expectedRepeatCount: options.repeat,
				judgeEnabled: !options.noJudge,
				taskManifestHash: inputs.taskManifestHash,
			},
			model: options.model,
			answerContract: item.answerContract,
			judgeModel: options.judgeModel,
			useJudge: !options.noJudge,
			...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
			axiBin,
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: {}),
			apiKey,
			...(commit ? { harnessCommit: commit } : {}),
			harnessSourceHash: fingerprints.harnessSourceHash,
			...(fingerprints.axiBinaryHash
				? { axiBinaryHash: fingerprints.axiBinaryHash }
				: {}),
			claudeVersion: fingerprints.claudeVersion,
		});
		printResultSummary(result);
	}
}

async function preflightCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const apiKey = assertLiveReadOnlyContract(options.confirmReadOnly);
	const inputs = await loadBenchmarkInputs(paths);
	assertSnapshotFresh(
		inputs.snapshotGeneratedAt,
		options.maxSnapshotAgeMinutes,
	);
	const tasks = filteredTasks(inputs.tasks, options);
	if (tasks.length === 0) {
		throw new Error("preflight filters selected no tasks");
	}
	const selectedConditions = options.conditions ?? [...CONDITIONS];
	const selectedAnswerContracts = options.answerContracts ?? [...ANSWER_CONTRACTS];
	const seed = options.seed ?? defaultSeed();
	const schedule = createMatrixSchedule(tasks, selectedConditions, selectedAnswerContracts, 1, seed);
	const matrixRunId = options.runId ?? randomUUID();
	const existingResults = await readResults(paths.resultsFile);
	if (existingResults.some((result) => result.matrixRunId === matrixRunId)) {
		throw new Error("preflight requires a distinct matrixRunId; the selected ID already exists");
	}
	const needsAxi = schedule.some((item) => item.condition === "axi");
	const axiBin = needsAxi ? await resolveAxiBinary(paths.repoRoot, options.axiBin) : (options.axiBin ?? join(paths.repoRoot, "target", "release", "magi-linear-axi"));
	const commit = getHarnessCommit(paths);
	const fingerprints = await getBenchmarkFingerprints(paths, {
		...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
		...(needsAxi ? { axiBin } : {}),
	});
	const results = [] as Awaited<ReturnType<typeof runBenchmarkCase>>[];
	for (const item of schedule) {
		results.push(
			await runBenchmarkCase({
				paths,
				inputs,
				task: item.task,
				condition: item.condition,
				repeatIndex: 1,
				benchmarkSeed: seed,
				matrixRunId,
				cohort: {
					expectedConditions: [...selectedConditions],
					expectedTaskIds: tasks.map((task) => task.id),
					expectedRepeatCount: 1,
					judgeEnabled: false,
					taskManifestHash: inputs.taskManifestHash,
					expectedAnswerContracts: [...selectedAnswerContracts],
				},
				model: options.model,
				judgeModel: options.judgeModel,
				answerContract: item.answerContract,
				useJudge: false,
				...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
				axiBin,
				...(options.timeoutMs !== undefined
					? { timeoutMs: options.timeoutMs }
					: {}),
				apiKey,
				...(commit ? { harnessCommit: commit } : {}),
				harnessSourceHash: fingerprints.harnessSourceHash,
				...(fingerprints.axiBinaryHash
					? { axiBinaryHash: fingerprints.axiBinaryHash }
					: {}),
				claudeVersion: fingerprints.claudeVersion,
			}),
		);
	}
	validateCohort(results);
	const validation = validatePreflightResults(results);
	const aggregate = aggregateResults(results);
	console.log(
		JSON.stringify(
			{
				matrixRunId,
				runs: aggregate.runs,
				hardSafety: {
					incidents: aggregate.hardSafetyIncidents,
					affectedRuns: aggregate.hardSafetyRuns,
				},
				policyIncidents: {
					incidents: aggregate.policyIncidents,
					affectedRuns: aggregate.policyIncidentRuns,
				},
				commandErrors: {
					incidents: aggregate.commandErrors,
					affectedRuns: aggregate.commandErrorRuns,
				},
				apiErrors: {
					incidents: aggregate.apiErrors,
					affectedRuns: aggregate.apiErrorRuns,
				},
				otherToolErrors: {
					incidents: aggregate.otherToolErrors,
					affectedRuns: aggregate.otherToolErrorRuns,
				},
				infrastructureErrors: {
					incidents: aggregate.infrastructureErrors,
					affectedRuns: aggregate.infrastructureErrorRuns,
				},
				expectedErrors: {
					incidents: aggregate.expectedErrors,
					affectedRuns: aggregate.expectedErrorRuns,
				},
			},
			null,
			2,
		),
	);
	if (!validation.passed) {
		throw new Error("preflight failed primitive reachability checks");
	}
}

async function reportCommand(
	options: CliOptions,
	paths: BenchmarkPaths,
): Promise<void> {
	const results = await readResults(paths.resultsFile);
	const cohort = selectCohort(results, options.runId);
	const filters: ResultFilters = {
		...(options.taskIds ? { taskIds: options.taskIds } : {}),
		...(options.categories ? { categories: options.categories } : {}),
		...(options.conditions ? { conditions: options.conditions } : {}),
		...(options.answerContracts ? { answerContracts: options.answerContracts } : {}),
	};
	const selected = filterResults(cohort.results, filters);
	await writeReports(
		paths.reportMarkdownFile,
		paths.reportCsvFile,
		selected,
		cohort.matrixRunId,
		cohort.results,
	);
	console.log(
		JSON.stringify(
			{
				results: selected.length,
				matrixRunId: cohort.matrixRunId,
				taskManifestHashes: metadataFromResults(selected).taskManifestHashes,
				reportMarkdown: paths.reportMarkdownFile,
				reportCsv: paths.reportCsvFile,
			},
			null,
			2,
		),
	);
}

export async function main(
	argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
	try {
		const options = parseCliArgs(argv);
		if (options.command === "help") {
			console.log(usage());
			return 0;
		}
		const paths = pathsFor(options);
		if (options.command === "snapshot") {
			await snapshotCommand(options, paths);
		} else if (options.command === "list") {
			await listCommand(options, paths);
		} else if (options.command === "run") {
			await runCommand(options, paths);
		} else if (options.command === "matrix") {
			await matrixCommand(options, paths);
		} else if (options.command === "preflight") {
			await preflightCommand(options, paths);
		} else {
			await reportCommand(options, paths);
		}
		return 0;
	} catch (error: unknown) {
		const message =
			error instanceof Error ? error.message : "benchmark command failed";
		console.error(`benchmark error: ${message}`);
		return 1;
	}
}

const invokedPath = process.argv[1];
if (
	invokedPath &&
	resolve(invokedPath) === resolve(fileURLToPath(import.meta.url))
) {
	const exitCode = await main();
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
}
