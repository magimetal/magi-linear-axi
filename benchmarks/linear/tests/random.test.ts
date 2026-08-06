import { describe, expect, it } from "vitest";
import { createMatrixSchedule, shuffleWithSeed } from "../src/random.js";
import { richSnapshot } from "./fixtures.js";
import { generateTasks } from "../src/tasks.js";

describe("seeded paired matrix schedule", () => {
	it("randomizes task/repeat blocks and condition order while keeping pairs adjacent", () => {
		const tasks = generateTasks(richSnapshot()).tasks.slice(0, 2);
		const first = createMatrixSchedule(tasks, ["axi", "mcp"], 2, "seed-1");
		const second = createMatrixSchedule(tasks, ["axi", "mcp"], 2, "seed-1");
		expect(first).toEqual(second);
		expect(first).toHaveLength(8);
		for (let index = 0; index < first.length; index += 2) {
			expect(first[index]?.task.id).toBe(first[index + 1]?.task.id);
			expect(first[index]?.repeatIndex).toBe(first[index + 1]?.repeatIndex);
			expect(
				new Set([first[index]?.condition, first[index + 1]?.condition]),
			).toEqual(new Set(["axi", "mcp"]));
		}
		expect(
			createMatrixSchedule(tasks, ["axi", "mcp"], 2, "seed-2"),
		).not.toEqual(first);
	});

	it("does not mutate the input array", () => {
		const values = [1, 2, 3, 4];
		const shuffled = shuffleWithSeed(values, "seed");
		expect(values).toEqual([1, 2, 3, 4]);
		expect(shuffled).toHaveLength(values.length);
	});
});
