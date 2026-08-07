import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { assertSnapshotFresh } from "../src/snapshot.js";

describe("benchmark CLI safety and cohort options", () => {
	it("defaults to the bounded snapshot limit and a 30-minute freshness check", () => {
		const options = parseCliArgs(["matrix"]);
		expect(options.limit).toBe(25);
		expect(options.maxSnapshotAgeMinutes).toBe(30);
	});
	it("parses compact, canonical, all, and comma-separated answer-contract filters", () => {
		expect(parseCliArgs(["matrix"]).answerContracts).toBeUndefined();
		expect(
			parseCliArgs(["matrix", "--answer-contract", "compact"])
				.answerContracts,
		).toEqual(["compact"]);
		expect(
			parseCliArgs(["matrix", "--answer-contract", "canonical"])
				.answerContracts,
		).toEqual(["canonical"]);
		expect(
			parseCliArgs(["matrix", "--answer-contract", "all"]).answerContracts,
		).toEqual(["compact", "canonical"]);
		expect(
			parseCliArgs([
				"matrix",
				"--answer-contract",
				"compact,canonical",
			]).answerContracts,
		).toEqual(["compact", "canonical"]);
	});

	it("rejects empty, unknown, duplicate, or mixed-all answer contracts", () => {
		for (const value of ["", "other", "compact,compact", "all,canonical"]) {
			expect(() =>
				parseCliArgs(["matrix", "--answer-contract", value]),
			).toThrow(/answer[- ]contract/u);
		}
	});
	it("parses explicit run IDs and snapshot age limits", () => {
		const options = parseCliArgs([
			"report",
			"--run-id",
			"cohort-7",
			"--max-snapshot-age-minutes",
			"45.5",
		]);
		expect(options.runId).toBe("cohort-7");
		expect(options.maxSnapshotAgeMinutes).toBe(45.5);
		expect(parseCliArgs(["preflight"]).command).toBe("preflight");
	});

	it("rejects stale snapshots without an implicit bypass", () => {
		expect(() =>
			assertSnapshotFresh(
				"2026-08-05T11:00:00.000Z",
				30,
				new Date("2026-08-05T12:00:01.000Z"),
			),
		).toThrow(/maximum allowed age is 30/u);
		expect(() =>
			assertSnapshotFresh(
				"2026-08-05T11:45:00.000Z",
				30,
				new Date("2026-08-05T12:00:01.000Z"),
			),
		).not.toThrow();
		expect(() =>
			parseCliArgs(["run", "--max-snapshot-age-minutes", "0"]),
		).toThrow(/positive number/u);
	});
});
