import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkPaths } from "./types.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, "..");

export function defaultPaths(): BenchmarkPaths {
	const resultsDir = join(packageRoot, "results");
	return {
		packageRoot,
		repoRoot: resolve(packageRoot, "../.."),
		snapshotFile: join(packageRoot, "snapshots", "latest.json"),
		tasksFile: join(packageRoot, "generated", "latest.json"),
		resultsDir,
		resultsFile: join(resultsDir, "results.jsonl"),
		reportMarkdownFile: join(resultsDir, "report.md"),
		reportCsvFile: join(resultsDir, "report.csv"),
	};
}

export function withPathOverrides(
	paths: BenchmarkPaths,
	overrides: Partial<
		Pick<BenchmarkPaths, "snapshotFile" | "tasksFile" | "resultsDir">
	>,
): BenchmarkPaths {
	const resultsDir = overrides.resultsDir ?? paths.resultsDir;
	return {
		...paths,
		snapshotFile: overrides.snapshotFile ?? paths.snapshotFile,
		tasksFile: overrides.tasksFile ?? paths.tasksFile,
		resultsDir,
		resultsFile: join(resultsDir, "results.jsonl"),
		reportMarkdownFile: join(resultsDir, "report.md"),
		reportCsvFile: join(resultsDir, "report.csv"),
	};
}
