import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBenchmarkInputs } from "../src/runner.js";
import { snapshotHash, stableJson } from "../src/snapshot.js";
import { attachSnapshotHash, generateTasks, parseTaskManifest } from "../src/tasks.js";
import type { BenchmarkPaths } from "../src/types.js";
import { richSnapshot } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

function pathsFor(directory: string): BenchmarkPaths {
	const resultsDir = join(directory, "results");
	return {
		packageRoot: directory,
		repoRoot: directory,
		snapshotFile: join(directory, "snapshot.json"),
		tasksFile: join(directory, "tasks.json"),
		resultsDir,
		resultsFile: join(resultsDir, "results.jsonl"),
		reportMarkdownFile: join(resultsDir, "report.md"),
		reportCsvFile: join(resultsDir, "report.csv"),
	};
}

function parseManifest(content: string): ReturnType<typeof generateTasks> {
	try {
		return JSON.parse(content) as ReturnType<typeof generateTasks>;
	} catch (error: unknown) {
		throw new Error(`fixture manifest was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
	}
}

async function writeInputs(directory: string): Promise<BenchmarkPaths> {
	const paths = pathsFor(directory);
	const snapshot = richSnapshot();
	await writeFile(paths.snapshotFile, stableJson(snapshot));
	await writeFile(
		paths.tasksFile,
		stableJson(attachSnapshotHash(generateTasks(snapshot), snapshotHash(snapshot))),
	);
	return paths;
}

describe("task manifest integrity", () => {
	it("hashes the exact loaded content and accepts a regenerated manifest", async () => {
		const directory = await mkdtemp(join(process.cwd(), "linear-manifest-test-"));
		temporaryDirectories.push(directory);
		const paths = await writeInputs(directory);
		const inputs = await loadBenchmarkInputs(paths);
		const content = await readFile(paths.tasksFile);
		expect(inputs.taskManifestHash).toBe(
			createHash("sha256").update(content).digest("hex"),
		);
		expect(inputs.tasks).toHaveLength(8);
	});

	it.each([
		["prompt", (manifest: ReturnType<typeof generateTasks>) => {
			manifest.tasks[0]!.prompt = "tampered prompt";
		}],
		["required fact", (manifest: ReturnType<typeof generateTasks>) => {
			manifest.tasks[0]!.requiredFacts[0]!.value = "tampered fact";
		}],
		["warning", (manifest: ReturnType<typeof generateTasks>) => {
			manifest.warnings = ["tampered warning"];
		}],
	] as const)("rejects an altered %s", async (_label, alter) => {
		const directory = await mkdtemp(join(process.cwd(), "linear-manifest-tamper-"));
		temporaryDirectories.push(directory);
		const paths = await writeInputs(directory);
		const parsed = parseManifest(await readFile(paths.tasksFile, "utf8"));
		alter(parsed);
		await writeFile(paths.tasksFile, stableJson(parsed));
		await expect(loadBenchmarkInputs(paths)).rejects.toThrow(/task manifest definitions/u);
	});

	it("accepts non-canonical snapshot bytes when canonical content matches", async () => {
		const directory = await mkdtemp(join(process.cwd(), "linear-manifest-normalized-"));
		temporaryDirectories.push(directory);
		const paths = await writeInputs(directory);
		const snapshot = JSON.parse(
			await readFile(paths.snapshotFile, "utf8"),
		) as ReturnType<typeof richSnapshot>;
		await writeFile(paths.snapshotFile, JSON.stringify(snapshot));
		await expect(loadBenchmarkInputs(paths)).resolves.toMatchObject({
			snapshotHash: snapshotHash(snapshot),
		});
	});

	it("rejects manifests that would require AXI-truncated exact values", () => {
		const manifest = generateTasks(richSnapshot());
		manifest.tasks[0]!.requiredFacts[0]!.value = "🙂".repeat(241);
		expect(() => parseTaskManifest(manifest)).toThrow(/invalid or incomplete/u);

		const operationManifest = generateTasks(richSnapshot());
		operationManifest.tasks[0]!.requiredOperations = [{
			kind: "issue_view",
			operand: "ENG-10",
			requiredResultValues: ["🙂".repeat(241)],
		}];
		expect(() => parseTaskManifest(operationManifest)).toThrow(/invalid or incomplete/u);
	});

	it("rejects an altered snapshot hash even when task definitions are unchanged", async () => {
		const directory = await mkdtemp(join(process.cwd(), "linear-manifest-hash-"));
		temporaryDirectories.push(directory);
		const paths = await writeInputs(directory);
		const parsed = parseManifest(await readFile(paths.tasksFile, "utf8"));
		parsed.snapshotHash = "tampered snapshot hash";
		await writeFile(paths.tasksFile, stableJson(parsed));
		await expect(loadBenchmarkInputs(paths)).rejects.toThrow(/snapshot and generated task manifest/u);
	});
});
