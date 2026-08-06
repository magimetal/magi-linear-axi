import { chmod, access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_FINAL_ANSWER_CONTRACT,
  buildHelperSubprocessEnvironment,
  buildTaskPrompt,
  getClaudeVersion,
  getHarnessCommit,
  hashBenchmarkSources,
  runBenchmarkCase,
} from "../src/runner.js";
import type { BenchmarkPaths, BenchmarkTask, ParsedClaudeStream } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pathsFor(directory: string): BenchmarkPaths {
  const resultsDir = join(directory, "results");
  return {
    packageRoot: directory,
    repoRoot: process.cwd(),
    snapshotFile: join(directory, "snapshot.json"),
    tasksFile: join(directory, "tasks.json"),
    resultsDir,
    resultsFile: join(resultsDir, "results.jsonl"),
    reportMarkdownFile: join(resultsDir, "report.md"),
    reportCsvFile: join(resultsDir, "report.csv"),
  };
}

const task: BenchmarkTask = {
  id: "issue-lookup",
  category: "single_step",
  title: "Issue",
  prompt: "Read the issue.",
  minimumToolCalls: 1,
  requiredOperations: [],
  requiredFacts: [{ label: "identifier", kind: "contains", value: "ENG-1" }],
  gradingHints: [],
};

function parsedStream(binary = "/tmp/bin/magi-linear-axi"): ParsedClaudeStream {
  return {
    finalAnswer: "ENG-1",
    toolCalls: [{ id: "axi-1", name: "Bash", kind: "bash", input: { command: `${binary} issue view ENG-1` } }],
    toolResults: [{ toolUseId: "axi-1", text: "ENG-1", isError: false }],
    usage: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1 },
    turns: 1,
    errors: [],
    parseErrors: 0,
    terminalStatus: "success",
    exitCode: 0,
  };
}

describe("benchmark case isolation and cohorts", () => {
  it("builds the exact bounded AXI parity guide and keeps MCP typed", () => {
    const binary = "/tmp/bin/magi-linear-axi";
    const axiPrompt = buildTaskPrompt(task, "axi", binary);
    for (const read of [
      `${binary} issue view <IDENTIFIER>`,
      `${binary} issue query --search=<TEXT>`,
      `${binary} issue comment list <IDENTIFIER>`,
      `${binary} issue relation list <IDENTIFIER>`,
      `${binary} project view <PROJECT_ID>`,
      `${binary} --help`,
    ]) {
      expect(axiPrompt).toContain(read);
    }
    expect(axiPrompt).toContain("exactly one invocation");
    expect(axiPrompt).toContain("unambiguous --search=<TEXT>");
    expect(axiPrompt).not.toContain("team id <TEAM_ID>");
    expect(axiPrompt).toContain("2>&1");
    expect(axiPrompt).toContain("pipelines");
    expect(axiPrompt).toContain("substitutions");
    expect(axiPrompt).toContain("line continuations");
    expect(axiPrompt).not.toContain(`${binary} issue create`);
    const mcpPrompt = buildTaskPrompt(task, "mcp", binary);
    expect(mcpPrompt).toContain("read-only Linear MCP typed tools");
    expect(mcpPrompt).toContain("never use Bash");
  });

  it("uses the same compact answer contract for every category and condition", () => {
    const categories = ["single_step", "multi_step", "investigation", "error_recovery"] as const;
    for (const category of categories) {
      const categoryTask = { ...task, id: category, category, prompt: `Prompt for ${category}.` };
      for (const condition of ["axi", "mcp"] as const) {
        const prompt = buildTaskPrompt(categoryTask, condition, "/tmp/bin/magi-linear-axi");
        expect(prompt.split(COMPACT_FINAL_ANSWER_CONTRACT)).toHaveLength(2);
        expect(prompt).toContain(`Task: ${categoryTask.prompt}`);
        expect(prompt).toContain("explicitly state that the issue was not found");
        expect(prompt).not.toContain("\\n");
      }
    }
  });

  it("hashes source inputs deterministically while excluding live artifacts", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-fingerprint-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "src"), { recursive: true });
    await mkdir(join(directory, "results", "raw"), { recursive: true });
    await mkdir(join(directory, "generated"), { recursive: true });
    await writeFile(join(directory, "src", "task.ts"), "export const task = 1;\n");
    await writeFile(join(directory, "results", "raw", "secret.jsonl"), "one\n");
    const first = await hashBenchmarkSources(directory);
    await writeFile(join(directory, "results", "raw", "secret.jsonl"), "two\n");
    expect(await hashBenchmarkSources(directory)).toBe(first);
    await writeFile(join(directory, "src", "task.ts"), "export const task = 2;\n");
    expect(await hashBenchmarkSources(directory)).not.toBe(first);
  });

  it("captures a bounded Claude version from the selected executable", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-version-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\nprintf 'claude fixture 9.9.9\\nsecond line\\n'\n");
    await chmod(executable, 0o700);
    expect(getClaudeVersion(executable)).toBe("claude fixture 9.9.9");
  });

  it("runs git and Claude fingerprint helpers with a bounded secret-free environment", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-helper-environment-test-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    const recordFile = join(directory, "helper-env.jsonl");
    await mkdir(binDirectory, { recursive: true });
    const helperSecretNames = [
      "LINEAR_API_KEY",
      "LINEAR_API_KEY_READ_ONLY",
      "LINEAR_API_URL",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "UNRELATED_SECRET",
    ] as const;
    const helperOutput = {
      claude: `claude-${"v".repeat(500)}`,
      git: `commit-${"c".repeat(500)}`,
    };
    const recordPathForShell = recordFile.replaceAll("'", "'\\\"'\\\"'");
    const scriptFor = (output: string, helper: string): string => `#!/bin/sh
{
  printf '%s=%s\\n' 'helper' '${helper}';
  printf '%s=%s\\n' 'LINEAR_API_KEY' "\${LINEAR_API_KEY-}";
  printf '%s=%s\\n' 'LINEAR_API_KEY_READ_ONLY' "\${LINEAR_API_KEY_READ_ONLY-}";
  printf '%s=%s\\n' 'LINEAR_API_URL' "\${LINEAR_API_URL-}";
  printf '%s=%s\\n' 'ANTHROPIC_API_KEY' "\${ANTHROPIC_API_KEY-}";
  printf '%s=%s\\n' 'CLAUDE_CODE_OAUTH_TOKEN' "\${CLAUDE_CODE_OAUTH_TOKEN-}";
  printf '%s=%s\\n' 'OPENAI_API_KEY' "\${OPENAI_API_KEY-}";
  printf '%s=%s\\n' 'GITHUB_TOKEN' "\${GITHUB_TOKEN-}";
  printf '%s=%s\\n' 'HTTP_PROXY' "\${HTTP_PROXY-}";
  printf '%s=%s\\n' 'HTTPS_PROXY' "\${HTTPS_PROXY-}";
  printf '%s=%s\\n' 'ALL_PROXY' "\${ALL_PROXY-}";
  printf '%s=%s\\n' 'http_proxy' "\${http_proxy-}";
  printf '%s=%s\\n' 'https_proxy' "\${https_proxy-}";
  printf '%s=%s\\n' 'all_proxy' "\${all_proxy-}";
  printf '%s=%s\\n' 'UNRELATED_SECRET' "\${UNRELATED_SECRET-}";
} >> '${recordPathForShell}'
printf '%s\\n' '${output}'
printf '%s\\n' 'helper stderr must stay suppressed: unrelated-secret' >&2
`;
    await writeFile(join(binDirectory, "claude"), scriptFor(helperOutput.claude, "claude"));
    await writeFile(join(binDirectory, "git"), scriptFor(helperOutput.git, "git"));
    await chmod(join(binDirectory, "claude"), 0o700);
    await chmod(join(binDirectory, "git"), 0o700);

    const originalEnvironment = new Map<string, string | undefined>();
    for (const name of ["PATH", ...helperSecretNames]) {
      originalEnvironment.set(name, process.env[name]);
    }
    try {
      process.env.PATH = [binDirectory, process.env.PATH].filter(Boolean).join(":");
      for (const name of helperSecretNames) {
        process.env[name] = `fixture-secret-${name}`;
      }

      expect(buildHelperSubprocessEnvironment()).toEqual({
        PATH: process.env.PATH,
        LANG: "C",
        LC_ALL: "C",
        TERM: "dumb",
      });
      expect(getClaudeVersion()).toBe(helperOutput.claude.slice(0, 200));
      expect(getHarnessCommit({ ...pathsFor(directory), repoRoot: directory })).toBe(
        helperOutput.git.slice(0, 200),
      );

      const records = (await readFile(recordFile, "utf8"))
        .trim()
        .split("\n");
      expect(records.filter((line) => line === "helper=claude")).toHaveLength(1);
      expect(records.filter((line) => line === "helper=git")).toHaveLength(1);
      for (const name of helperSecretNames) {
        expect(records.filter((line) => line === `${name}=`)).toHaveLength(2);
      }
    } finally {
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("uses a disposable workspace and records the supplied matrix run ID", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-runner-test-"));
    temporaryDirectories.push(directory);
    const paths = pathsFor(directory);
    const longAnswer = `ENG-1\n${"α requested value ".repeat(600)}\nunique-suffix`;
    let observedCwd = "";
    const result = await runBenchmarkCase({
      paths,
      inputs: {
        snapshotGeneratedAt: "2026-08-05T12:00:00.000Z",
        snapshotHash: "snapshot-hash",
        taskManifestHash: "task-manifest-hash",
        tasks: [task],
        warnings: [],
      },
      task,
      condition: "axi",
      repeatIndex: 1,
      benchmarkSeed: "seed",
      matrixRunId: "cohort-1",
      model: "test-model",
      judgeModel: "test-judge",
      useJudge: false,
      axiBin: "/tmp/bin/magi-linear-axi",
      apiKey: "test-key",
      harnessSourceHash: "fixture-source-hash",
      axiBinaryHash: "fixture-axi-hash",
      claudeVersion: "Claude fixture 1.0.0",
      execute: async (options) => {
        observedCwd = options.cwd;
        expect(options.cwd).not.toBe(paths.repoRoot);
        expect(options.axiBin).toContain("axi-broker-");
        expect(options.axiBin).not.toBe("/tmp/bin/magi-linear-axi");
        expect(options.prompt).toContain(options.axiBin ?? "missing-wrapper");
        expect(options.environment?.LINEAR_API_URL).toBe("https://api.linear.app/graphql");
        expect(options.environment).not.toHaveProperty("LINEAR_API_KEY");
        expect(options.environment?.XDG_CONFIG_HOME).toContain(options.cwd);
        expect(options.environment?.XDG_CONFIG_HOME).not.toBe(process.env.XDG_CONFIG_HOME);
        expect(options.environment?.HOME).toBe(process.env.HOME);
        const parsed = parsedStream(options.axiBin);
        parsed.finalAnswer = longAnswer;
        parsed.usage.outputTokens = 9_876;
        return { stdout: "", stderr: "", parsed };
      },
    });
    expect(result.matrixRunId).toBe("cohort-1");
    expect(await pathExists(observedCwd)).toBe(false);
    const persistedText = await readFile(paths.resultsFile, "utf8");
    let persisted: Record<string, unknown>;
    try {
      persisted = JSON.parse(persistedText) as Record<string, unknown>;
    } catch (error: unknown) {
      throw new Error(`fixture result was not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    expect(persisted.matrixRunId).toBe("cohort-1");
    expect(persisted.expectedConditions).toEqual(["axi"]);
    expect(persisted.expectedTaskIds).toEqual(["issue-lookup"]);
    expect(persisted.expectedRepeatCount).toBe(1);
    expect(persisted.judgeEnabled).toBe(false);
    expect(persisted.harnessSourceHash).toBe("fixture-source-hash");
    expect(persisted.taskManifestHash).toBe("task-manifest-hash");
    expect(persisted.axiBinaryHash).toBe("fixture-axi-hash");
    expect(persisted.claudeVersion).toBe("Claude fixture 1.0.0");
    expect(result.finalAnswer).toBe(longAnswer);
    expect(result.outputTokens).toBe(9_876);
    expect(persisted.finalAnswer).toBe(longAnswer);
    expect(persisted.outputTokens).toBe(9_876);
  });

  it("measures agent wall time separately from judge and orchestration time", async () => {
    const directory = await mkdtemp(join(process.cwd(), "linear-runner-timing-test-"));
    temporaryDirectories.push(directory);
    const paths = pathsFor(directory);
    const result = await runBenchmarkCase({
      paths,
      inputs: {
        snapshotGeneratedAt: "2026-08-05T12:00:00.000Z",
        snapshotHash: "snapshot-hash",
        taskManifestHash: "task-manifest-hash",
        tasks: [task],
        warnings: [],
      },
      task,
      condition: "axi",
      repeatIndex: 1,
      benchmarkSeed: "seed",
      matrixRunId: "timing-cohort",
      cohort: {
        expectedConditions: ["axi"],
        expectedTaskIds: [task.id],
        expectedRepeatCount: 1,
        judgeEnabled: true,
      },
      model: "test-model",
      judgeModel: "test-judge",
      useJudge: true,
      axiBin: "/tmp/bin/magi-linear-axi",
      apiKey: "test-key",
      harnessSourceHash: "fixture-source-hash",
      axiBinaryHash: "fixture-axi-hash",
      claudeVersion: "Claude fixture 1.0.0",
      execute: async (options) => ({ stdout: "", stderr: "", parsed: parsedStream(options.axiBin) }),
      judge: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          grade: { status: "passed", model: "test-judge", score: 1 },
          raw: "judge output",
          parsed: parsedStream(),
        };
      },
    });
    expect(result.judgeWallTimeMs).toBeGreaterThanOrEqual(30);
    expect(result.orchestrationWallTimeMs).toBeGreaterThan(result.wallTimeMs);
    expect((result.orchestrationWallTimeMs ?? 0) - result.wallTimeMs).toBeGreaterThanOrEqual(20);
  });
});
