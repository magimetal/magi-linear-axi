import { describe, expect, it } from "vitest";
import {
	answerContractPrompt,
	canonicalAnswerPassed,
	expectedCanonicalAnswer,
	fieldKey,
	serializeCanonicalRecords,
} from "../src/answer-contract.js";
import type { BenchmarkTask } from "../src/types.js";

function task(
	requiredFacts: BenchmarkTask["requiredFacts"],
	canonicalAnswer?: BenchmarkTask["canonicalAnswer"],
): BenchmarkTask {
	return {
		id: "lookup",
		category: "single_step",
		title: "Lookup",
		prompt: "Read issue.",
		minimumToolCalls: 1,
		requiredOperations: [],
		requiredFacts,
		gradingHints: [],
		...(canonicalAnswer ? { canonicalAnswer } : {}),
	};
}

describe("canonical answer contract", () => {
	it("serializes one record as an object and multiple records as an ordered array", () => {
		expect(serializeCanonicalRecords([{ a: "1" }])).toBe('{"a":"1"}');
		expect(
			serializeCanonicalRecords([{ a: "1" }, { a: "2" }]),
		).toBe('[{"a":"1"},{"a":"2"}]');
	});

	it("preserves Unicode and applies normal JSON escaping to exact string values", () => {
		const candidate = task(
			[
				{ label: "empty", kind: "contains", value: "" },
				{
					label: "text",
					kind: "contains",
					value: '🙂 | = , : "quote" \\ slash\nsecond line',
				},
			],
			[
				{
					fields: [
						{ key: "empty", factLabel: "empty" },
						{ key: "text", factLabel: "text" },
					],
				},
			],
		);
		const expected =
			'{"empty":"","text":"🙂 | = , : \\"quote\\" \\\\ slash\\nsecond line"}';
		expect(expectedCanonicalAnswer(candidate)).toBe(expected);
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
	});

	it("supports ordered multiple records with repeated keys", () => {
		const candidate = task(
			[
				{ label: "first identifier", kind: "contains", value: "ENG-1" },
				{ label: "first title", kind: "contains", value: "One" },
				{ label: "second identifier", kind: "contains", value: "ENG-2" },
				{ label: "second title", kind: "contains", value: "Two" },
			],
			[
				{
					fields: [
						{ key: "identifier", factLabel: "first identifier" },
						{ key: "title", factLabel: "first title" },
					],
				},
				{
					fields: [
						{ key: "identifier", factLabel: "second identifier" },
						{ key: "title", factLabel: "second title" },
					],
				},
			],
		);
		const expected =
			'[{"identifier":"ENG-1","title":"One"},{"identifier":"ENG-2","title":"Two"}]';
		expect(expectedCanonicalAnswer(candidate)).toBe(expected);
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
		expect(
			canonicalAnswerPassed(
				candidate,
				'[{"identifier":"ENG-2","title":"Two"},{"identifier":"ENG-1","title":"One"}]',
			),
		).toBe(false);
	});

	it("uses exact issue-scoped error serialization", () => {
		const candidate = task(
			[
				{
					label: "invalid issue is explicitly absent",
					kind: "not_found",
					value: "ENG-404",
				},
			],
			[
				{
					fields: [
						{
							key: "error",
							factLabel: "invalid issue is explicitly absent",
						},
					],
				},
			],
		);
		expect(expectedCanonicalAnswer(candidate)).toBe(
			'{"error":"issue ENG-404 not found"}',
		);
		expect(
			canonicalAnswerPassed(
				candidate,
				'{"error":"issue ENG-404 not found"}',
			),
		).toBe(true);
		expect(
			canonicalAnswerPassed(candidate, '{"error":"ENG-404 not found"}'),
		).toBe(false);
	});

	it("rejects whitespace, prose, fences, escaped Unicode, schema drift, and non-string values", () => {
		const candidate = task([
			{ label: "issue identifier", kind: "contains", value: "ENG-1" },
			{ label: "issue title", kind: "contains", value: "Fix 🙂" },
		]);
		const expected = '{"issue_identifier":"ENG-1","issue_title":"Fix 🙂"}';
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
		for (const invalid of [
			'{ "issue_identifier":"ENG-1","issue_title":"Fix 🙂"}',
			`${expected}\n`,
			`Answer: ${expected}`,
			`\`\`\`json\n${expected}\n\`\`\``,
			'{"issue_title":"Fix 🙂","issue_identifier":"ENG-1"}',
			'{"issue_identifier":"ENG-1","issue_title":"Fix \\ud83d\\ude42"}',
			'{"issue_identifier":"ENG-1","issue_title":"Fix 🙂","extra":"x"}',
			'{"issue_identifier":"ENG-1"}',
			'{"issue_identifier":1,"issue_title":"Fix 🙂"}',
			'{"issue_identifier":"ENG-1","issue_title":"Wrong"}',
		]) {
			expect(canonicalAnswerPassed(candidate, invalid), invalid).toBe(false);
		}
	});

	it("includes byte-identical grammar and task schema in canonical prompts", () => {
		const candidate = task([
			{ label: "issue identifier", kind: "contains", value: "ENG-1" },
			{ label: "issue title", kind: "contains", value: "Fix" },
		]);
		const prompt = answerContractPrompt("canonical", candidate);
		expect(prompt).toContain(
			'Schema key order: [["issue_identifier","issue_title"]]',
		);
		expect(prompt).toContain("normal JSON escaping");
		expect(prompt).toContain("exactly `issue IDENTIFIER not found`");
		expect(answerContractPrompt("compact")).toContain(
			"Return only requested fields",
		);
	});

	it("derives stable ASCII keys for generic fact labels", () => {
		expect(fieldKey("  Project URL / Status  ")).toBe("project_url_status");
	});
});
