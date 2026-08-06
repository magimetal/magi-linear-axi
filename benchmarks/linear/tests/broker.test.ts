import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAxiBroker, validateAxiBrokerArgv } from "../src/broker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

function runExecutable(
	filePath: string,
	args: string[],
	): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(filePath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.once("error", (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
		child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

describe("pre-execution AXI credential broker", () => {
	it("rejects unsafe and unknown argv before a child can start", () => {
		expect(() => validateAxiBrokerArgv(["issue", "view", "ENG-1"])).not.toThrow();
		expect(() => validateAxiBrokerArgv(["issue", "query", "--search=latency"])).not.toThrow();
		expect(() => validateAxiBrokerArgv(["issue", "query", "--search=-leading title"])).not.toThrow();
		expect(() => validateAxiBrokerArgv(["issue", "query", "--search", "latency"])).toThrow(/unambiguous|search/u);
		expect(() => validateAxiBrokerArgv(["team", "id", "team-1"])).toThrow(/unknown|disallowed|malformed/u);
		expect(() => validateAxiBrokerArgv(["issue", "view", "ENG-1", "--endpoint", "https://api.linear.app/graphql"])).toThrow(/pinned endpoint/u);
		expect(() => validateAxiBrokerArgv(["issue", "create", "--title", "no"])).toThrow(/disallowed|unknown|malformed/u);
		expect(() => validateAxiBrokerArgv(["api", "query { viewer { id } }"])).toThrow(/raw AXI API/u);
		expect(() => validateAxiBrokerArgv(["unknown", "read", "ENG-1"])).toThrow(/unknown|disallowed/u);
		expect(() => validateAxiBrokerArgv(["issue", "view", "ENG-1", "--output", "file"])).toThrow(/unknown|malformed/u);
		expect(() => validateAxiBrokerArgv(["issue", "view", "x".repeat(5000)])).toThrow(/oversized/u);
		expect(() => validateAxiBrokerArgv(["issue", "view", "--help"])).not.toThrow();
		expect(() => validateAxiBrokerArgv(["issue", "comment", "list", "--help"])).not.toThrow();
	});

	it("injects only broker-held credentials into a valid fake child and cleans up", async () => {
		if (process.platform === "win32") {
			return;
		}
		const directory = await mkdtemp(join(tmpdir(), "linear-broker-test-"));
		temporaryDirectories.push(directory);
		const observed = join(directory, "observed.txt");
		const fake = join(directory, "fake-axi");
		const xdg = join(directory, "xdg");
		const cwd = join(directory, "workspace");
		await mkdir(xdg, { recursive: true, mode: 0o700 });
		await mkdir(cwd, { recursive: true, mode: 0o700 });
		await writeFile(
			fake,
			`#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$LINEAR_API_KEY" "$LINEAR_API_URL" "$PWD" > ${JSON.stringify(observed)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(observed)}\nprintf 'bounded fake output\\n'\nexit 7\n`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const broker = await createAxiBroker({
			apiKey: "fake-key-not-for-wrapper",
			axiBin: fake,
			endpoint: "https://api.linear.app/graphql",
			xdgConfigHome: xdg,
			cwd,
			environment: { PATH: "/bin:/usr/bin", LINEAR_API_KEY: "inherited-wrong-key" },
		});
		try {
			const wrapperSource = await readFile(broker.wrapperPath, "utf8");
			expect(wrapperSource).not.toContain("fake-key-not-for-wrapper");
			expect((await stat(broker.directory)).mode & 0o777).toBe(0o700);
			expect((await stat(broker.wrapperPath)).mode & 0o777).toBe(0o700);
			const valid = await runExecutable(broker.wrapperPath, ["issue", "view", "ENG-1", "--format", "json"]);
			expect(valid.code).toBe(7);
			expect(valid.stdout).toContain("bounded fake output");
			const observedText = await readFile(observed, "utf8");
			expect(observedText).toContain("fake-key-not-for-wrapper");
			expect(observedText).toContain("https://api.linear.app/graphql");
			expect(observedText).toContain(cwd);
			expect(observedText).toContain("issue\nview\nENG-1\n--format\njson");

			await writeFile(observed, "");
			const leadingDashSearch = await runExecutable(
				broker.wrapperPath,
				["issue", "query", "--search=-leading title"],
			);
			expect(leadingDashSearch.code).toBe(7);
			expect(await readFile(observed, "utf8")).toContain(
				"--search=-leading title",
			);
			await writeFile(observed, "");
			for (const unsafe of [
				["issue", "view", "ENG-1", "--endpoint", "https://evil.example/graphql"],
				["issue", "delete", "ENG-1"],
				["api", "mutation { issueDelete { success } }"],
				["issue", "get", "ENG-1"],
				["issue", "view", "x".repeat(20_000)],
			]) {
				const rejected = await runExecutable(broker.wrapperPath, unsafe);
				expect(rejected.code).toBe(2);
				expect(rejected.stderr).toMatch(/AXI|endpoint|raw|unknown|disallowed/u);
			}
			expect(await readFile(observed, "utf8")).toBe("");
		} finally {
			await broker.cleanup();
		}
		expect((await stat(broker.directory).catch(() => undefined))).toBeUndefined();
	});
});
