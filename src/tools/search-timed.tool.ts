import Fuse, { FuseResult, FuseOptionKeyObject } from "fuse.js";
import { tool } from "ai";
import { searchTimedToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SchedulerService } from "../services/scheduler.service.js";
import type { IScheduledTask } from "../shared/types/index.js";

interface ISearchMatch {
  taskId: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: IScheduledTask["schedule"];
  score: number;
  matchedFields: string[];
  preview: {
    instructions: string;
  };
}

interface ISearchResult {
  query: string;
  totalMatches: number;
  matches: ISearchMatch[];
}

const INSTRUCTIONS_TRUNCATE_LENGTH = 160;

const FUSE_WEIGHTS: FuseOptionKeyObject<IScheduledTask>[] = [
  { name: "name", weight: 0.4 },
  { name: "description", weight: 0.25 },
  { name: "instructions", weight: 0.2 },
  { name: "taskId", weight: 0.1 },
  { name: "tools", weight: 0.05 },
];

function truncateInstructions(text: string): string {
  if (text.length <= INSTRUCTIONS_TRUNCATE_LENGTH) {
    return text;
  }
  return text.slice(0, INSTRUCTIONS_TRUNCATE_LENGTH) + "...";
}

function extractMatchedFields(result: FuseResult<IScheduledTask>): string[] {
  const fields: string[] = [];
  if (result.matches) {
    for (const match of result.matches) {
      if (match.key && !fields.includes(match.key)) {
        fields.push(match.key);
      }
    }
  }
  return fields;
}

export const searchTimedTool = tool({
  description: "Search timed/scheduled tasks using fuzzy matching. Searches across task names, descriptions, instructions, task IDs, and tools.",
  inputSchema: searchTimedToolInputSchema,
  execute: async ({ query, enabledOnly = false, limit = 5, threshold = 0.4 }): Promise<ISearchResult> => {
    const scheduler: SchedulerService = SchedulerService.getInstance();

    const tasks: IScheduledTask[] = enabledOnly
      ? scheduler.getTasksByEnabled(true)
      : scheduler.getAllTasks();

    if (tasks.length === 0) {
      return { query, totalMatches: 0, matches: [] };
    }

    const fuse = new Fuse(tasks, {
      keys: FUSE_WEIGHTS,
      includeScore: true,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
      threshold,
    });

    const results: FuseResult<IScheduledTask>[] = fuse.search(query);

    const limitedResults = results.slice(0, limit);

    const matches: ISearchMatch[] = limitedResults.map((result) => {
      const task = result.item;
      const rawScore = result.score !== undefined ? 1 - result.score : 0;
      const clampedScore = Math.max(0, Math.min(1, rawScore));
      const score = Math.round(clampedScore * 10000) / 10000;

      return {
        taskId: task.taskId,
        name: task.name,
        description: task.description,
        enabled: task.enabled,
        schedule: task.schedule,
        score,
        matchedFields: extractMatchedFields(result),
        preview: {
          instructions: truncateInstructions(task.instructions),
        },
      };
    });

    return {
      query,
      totalMatches: results.length,
      matches,
    };
  },
});
