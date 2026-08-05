import type { BenchmarkResult } from "./types.js";

export interface PreflightValidation {
	passed: boolean;
	failures: string[];
}

function infrastructureCount(result: BenchmarkResult): number {
	return (
		result.infrastructureErrorCount ??
		(result.deterministicGrade.infrastructureFailure ? 1 : 0)
	);
}

function linkedEvidenceCount(result: BenchmarkResult): number {
	return (
		result.linkedToolEvidenceCount ??
		(result.deterministicGrade.factChecks.some((fact) => fact.grounded) ? 1 : 0)
	);
}

/**
 * Checks condition tool reachability and the operation/evidence contract for a
 * complete no-judge preflight. Final-answer fact correctness is intentionally
 * not part of this validation, but required operation semantics are.
 */
export function validatePreflightResults(
	results: readonly BenchmarkResult[],
): PreflightValidation {
	const failures: string[] = [];
	if (results.length === 0) {
		return { passed: false, failures: ["preflight produced no results"] };
	}
	for (const result of results) {
		const hardSafetyCount = Math.max(
			result.safetyViolationCount ?? 0,
			result.safetyViolations?.length ?? 0,
		);
		if (hardSafetyCount > 0) {
			failures.push(`${result.resultId}: hard safety violation`);
		}
		if (infrastructureCount(result) > 0) {
			failures.push(`${result.resultId}: infrastructure failure`);
		}
		if (!result.deterministicGrade.toolUseObserved) {
			failures.push(
				`${result.resultId}: condition-appropriate tool use was missing`,
			);
		}
		const hasOperationTrace =
			result.deterministicGrade.operationTrace !== undefined;
		if (
			result.deterministicGrade.operationChecksPassed === false ||
			(hasOperationTrace &&
				result.deterministicGrade.operationChecksPassed !== true)
		) {
			failures.push(
				`${result.resultId}: required operation semantics or linked results failed`,
			);
		}
		const factsGrounded = result.deterministicGrade.factChecks.every(
			(check) => check.grounded,
		);
		if (linkedEvidenceCount(result) === 0 || !factsGrounded) {
			failures.push(
				`${result.resultId}: required facts lacked linked tool evidence`,
			);
		}
	}
	return { passed: failures.length === 0, failures };
}
