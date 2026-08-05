import { createHash } from "node:crypto";
import type { BenchmarkTask, Condition } from "./types.js";

export interface MatrixCase {
	task: BenchmarkTask;
	condition: Condition;
	repeatIndex: number;
}

interface MatrixBlock {
	task: BenchmarkTask;
	repeatIndex: number;
}

function seedNumber(seed: string): number {
	const digest = createHash("sha256").update(seed).digest();
	return digest.readUInt32BE(0) || 1;
}

function nextRandom(state: { value: number }): number {
	state.value |= 0;
	state.value = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
	state.value +=
		Math.imul(state.value ^ (state.value >>> 7), 61 | state.value) ^
		state.value;
	return ((state.value ^ (state.value >>> 14)) >>> 0) / 4_294_967_296;
}

export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
	const result = [...items];
	const state = { value: seedNumber(seed) };
	for (let index = result.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(nextRandom(state) * (index + 1));
		[result[index], result[swapIndex]] = [result[swapIndex], result[index]];
	}
	return result;
}

/**
 * Randomizes task/repeat blocks, then randomizes condition order inside each
 * block. The two condition cases remain adjacent for paired live comparison.
 */
export function createMatrixSchedule(
	tasks: readonly BenchmarkTask[],
	conditions: readonly Condition[],
	repeat: number,
	seed: string,
): MatrixCase[] {
	if (repeat < 1 || !Number.isInteger(repeat)) {
		throw new Error("repeat must be a positive integer");
	}
	if (conditions.length === 0) {
		throw new Error("at least one condition is required");
	}
	const blocks: MatrixBlock[] = [];
	for (let repeatIndex = 1; repeatIndex <= repeat; repeatIndex += 1) {
		for (const task of tasks) {
			blocks.push({ task, repeatIndex });
		}
	}
	const randomizedBlocks = shuffleWithSeed(blocks, `${seed}:blocks`);
	const cases: MatrixCase[] = [];
	randomizedBlocks.forEach((block, blockIndex) => {
		const conditionOrder = shuffleWithSeed(
			conditions,
			`${seed}:conditions:${blockIndex}`,
		);
		for (const condition of conditionOrder) {
			cases.push({
				task: block.task,
				condition,
				repeatIndex: block.repeatIndex,
			});
		}
	});
	return cases;
}

export function defaultSeed(now = new Date()): string {
	return `${now.toISOString()}-${process.pid}`;
}
