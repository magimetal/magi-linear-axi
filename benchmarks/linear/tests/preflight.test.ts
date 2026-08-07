import { describe, expect, it } from "vitest";
import { validatePreflightResults } from "../src/preflight.js";
import { result } from "./fixtures.js";

describe("preflight primitive reachability validation", () => {
	it("accepts a compact operation trace with grounded evidence", () => {
		const base = result();
		const validation = validatePreflightResults([{
			...base,
			deterministicGrade: {
				...base.deterministicGrade,
				operationTrace: ["issue_view"],
				operationChecksPassed: true,
				factChecks: [{ label: "fact", passed: true, grounded: true }],
			},
		}]);
		expect(validation).toEqual({ passed: true, failures: [] });
	});

	it("rejects legacy or malformed AXI operation traces", () => {
		const base = result();
		const validation = validatePreflightResults([{
			...base,
			deterministicGrade: {
				...base.deterministicGrade,
				operationTrace: ["other"],
				operationChecksPassed: false,
				factChecks: [{ label: "fact", passed: true, grounded: true }],
			},
		}]);
		expect(validation.passed).toBe(false);
		expect(validation.failures).toContain(
			`${base.resultId}: required operation semantics or linked results failed`,
		);
	});

	it("does not require factual correctness and permits policy/ordinary errors", () => {
		const candidate = result({
			overallPassed: false,
			policyIncidentCount: 2,
			commandErrorCount: 1,
			errorCount: 1,
			deterministicGrade: {
				...result().deterministicGrade,
				passed: false,
				factChecks: [{ label: "fact", passed: false, grounded: true }],
			},
		});
		expect(validatePreflightResults([candidate])).toEqual({
			passed: true,
			failures: [],
		});
	});

	it("rejects non-empty tool output that does not ground required facts", () => {
		const base = result();
		const validation = validatePreflightResults([
			{
				...base,
				linkedToolEvidenceCount: 1,
				deterministicGrade: {
					...base.deterministicGrade,
					factChecks: [{ label: "fact", passed: false, grounded: false }],
				},
			},
		]);
		expect(validation.passed).toBe(false);
		expect(validation.failures).toHaveLength(1);
	});

	it("rejects failed required operation semantics even when facts are grounded", () => {
		const base = result();
		const validation = validatePreflightResults([
			{
				...base,
				linkedToolEvidenceCount: 1,
				deterministicGrade: {
					...base.deterministicGrade,
					operationChecksPassed: false,
					factChecks: [{ label: "fact", passed: true, grounded: true }],
				},
			},
		]);
		expect(validation.passed).toBe(false);
		expect(validation.failures).toContain(
			`${base.resultId}: required operation semantics or linked results failed`,
		);
	});

	it("does not treat a generic API/schema error as grounded absence evidence", () => {
		const base = result({
			taskId: "invalid-issue",
			category: "error_recovery",
			apiErrorCount: 1,
			linkedToolEvidenceCount: 1,
			deterministicGrade: {
				...result().deterministicGrade,
				passed: false,
				factChecks: [{ label: "not found", passed: false, grounded: false }],
			},
		});
		const validation = validatePreflightResults([base]);
		expect(validation.passed).toBe(false);
		expect(validation.failures).toContain(`${base.resultId}: required facts lacked linked tool evidence`);
		expect(validation.failures).not.toContain(`${base.resultId}: infrastructure failure`);
	});

	it("fails hard safety, true infrastructure, missing tool use, and empty evidence", () => {
		const base = result();
		const validation = validatePreflightResults([
			{ ...base, resultId: "safety", safetyViolationCount: 1 },
			{
				...base,
				resultId: "infra",
				infrastructureErrorCount: 1,
				deterministicGrade: { ...base.deterministicGrade, infrastructureFailure: true },
			},
			{
				...base,
				resultId: "tool",
				deterministicGrade: { ...base.deterministicGrade, toolUseObserved: false },
			},
			{
				...base,
				resultId: "evidence",
				linkedToolEvidenceCount: 0,
				deterministicGrade: {
					...base.deterministicGrade,
					factChecks: [{ label: "fact", passed: false, grounded: false }],
				},
			},
		]);
		expect(validation.passed).toBe(false);
		expect(validation.failures).toHaveLength(4);
	});
});
