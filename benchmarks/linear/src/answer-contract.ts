import type {
	AnswerContract,
	BenchmarkTask,
	CanonicalAnswerRecord,
	RequiredFact,
} from "./types.js";

export const CANONICAL_ANSWER_CONTRACT = [
	"Canonical answer contract:",
	"Return exactly one minified JSON object for one record, or one minified JSON array for multiple ordered records.",
	"Use exact schema key order, literal Unicode, and normal JSON escaping for quotes, backslashes, control characters, and multiline values.",
	"Every field value must be a string. Emit no whitespace outside string values, prose, code fences, or extra fields.",
	"For an invalid issue, the error value must be exactly `issue IDENTIFIER not found`, replacing IDENTIFIER with the requested issue identifier.",
].join("\n");

export function fieldKey(label: string): string {
	return label
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/gu, "_")
		.replace(/^_|_$/gu, "");
}

function factForLabel(
	task: BenchmarkTask,
	label: string,
): RequiredFact | undefined {
	return task.requiredFacts.find((fact) => fact.label === label);
}

export function canonicalAnswerSchema(
	task: BenchmarkTask,
): CanonicalAnswerRecord[] {
	return task.canonicalAnswer ?? [
		{
			fields: task.requiredFacts.map((fact) => ({
				key: fieldKey(fact.label),
				factLabel: fact.label,
			})),
		},
	];
}

export function serializeCanonicalRecords(
	records: readonly Readonly<Record<string, string>>[],
): string {
	return JSON.stringify(records.length === 1 ? records[0] : records);
}

export function expectedCanonicalAnswer(task: BenchmarkTask): string {
	const records = canonicalAnswerSchema(task).map((record) => {
		const value: Record<string, string> = {};
		for (const field of record.fields) {
			const fact = factForLabel(task, field.factLabel);
			value[field.key] =
				fact?.kind === "not_found"
					? `issue ${fact.value ?? ""} not found`
					: (fact?.value ?? "");
		}
		return value;
	});
	return serializeCanonicalRecords(records);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.values(value as Record<string, unknown>).every(
				(item) => typeof item === "string",
			),
	);
}

export function canonicalAnswerPassed(
	task: BenchmarkTask,
	answer: string,
): boolean {
	if (answer !== expectedCanonicalAnswer(task)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer) as unknown;
	} catch {
		return false;
	}
	const expected = canonicalAnswerSchema(task);
	const records = Array.isArray(parsed) ? parsed : [parsed];
	return (
		records.length === expected.length &&
		records.every((record, index) => {
			if (!isStringRecord(record)) return false;
			const keys = Object.keys(record);
			return (
				keys.length === expected[index]!.fields.length &&
				keys.every(
					(key, fieldIndex) =>
						key === expected[index]!.fields[fieldIndex]!.key,
				)
			);
		})
	);
}

export function answerContractPrompt(
	contract: AnswerContract,
	task?: BenchmarkTask,
): string {
	if (contract !== "canonical") {
		return "Return only requested fields. Do not add a preamble, restate the task, or add tables, counts, or commentary unless requested.\nWhen a requested issue does not exist, explicitly state that the issue was not found; do not use generic absence wording.";
	}
	const schema = task
		? canonicalAnswerSchema(task).map((record) =>
				record.fields.map((field) => field.key),
			)
		: [];
	return `${CANONICAL_ANSWER_CONTRACT}\nSchema key order: ${JSON.stringify(schema)}`;
}
