import { describe, expect, it } from "vitest";
import { createMatrixSchedule, shuffleWithSeed } from "../src/random.js";
import { richSnapshot } from "./fixtures.js";
import { generateTasks } from "../src/tasks.js";

describe("seeded paired matrix schedule", () => {
	it("randomizes task/repeat blocks and condition order while keeping pairs adjacent", () => {
		const tasks = generateTasks(richSnapshot()).tasks.slice(0, 2);
		const first = createMatrixSchedule(tasks, ["axi", "mcp"], ["compact", "canonical"], 2, "seed-1");
		const second = createMatrixSchedule(tasks, ["axi", "mcp"], ["compact", "canonical"], 2, "seed-1");
		expect(first).toEqual(second);
		expect(first).toHaveLength(16);
		for (let index = 0; index < first.length; index += 4) {
			expect(first.slice(index, index + 4).every((item) => item.task.id === first[index]?.task.id)).toBe(true);
			expect(first.slice(index, index + 4).every((item) => item.repeatIndex === first[index]?.repeatIndex)).toBe(true);
			expect(new Set(first.slice(index, index + 4).map((item) => `${item.condition}:${item.answerContract}`))).toEqual(
			new Set(["axi:compact", "axi:canonical", "mcp:compact", "mcp:canonical"]),
		);
		}
		expect(
			createMatrixSchedule(tasks, ["axi", "mcp"], ["compact", "canonical"], 2, "seed-2"),
		).not.toEqual(first);
	});

	it("does not mutate the input array", () => {
		const values = [1, 2, 3, 4];
		const shuffled = shuffleWithSeed(values, "seed");
		expect(values).toEqual([1, 2, 3, 4]);
		expect(shuffled).toHaveLength(values.length);
	});
});
