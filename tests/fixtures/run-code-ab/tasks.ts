/**
 * Phase 2 A/B harness — task definitions (plan §2.2/§2.3).
 *
 * The 4 prompts are VERBATIM from the plan (D11.1 neutral: goal + table names
 * only — no tool names, no ref-shape coaching, no re-emit steering). Do NOT
 * modify them: they are plan-contract.
 */

import {
  buildContactRow,
  buildOrderRow,
  buildRssRow,
  type IContactRow,
  type IOrderRow,
  type IRssRow,
} from "./seed.js";

export interface ITaskDef {
  /** 1-based task number. */
  task: number;
  /** Verbatim neutral prompt dispatched to the agent. */
  prompt: string;
  /** Source table(s) the model must read. */
  sourceTables: string[];
  /** Target table whose final state is asserted. */
  targetTable: string;
  /** Tables the model is allowed to mutate (plan §2.3). */
  allowedWriteTables: string[];
  /** Expected final rows of the target table (pure transform of the seed). */
  expectedTargetRowsAsync(): Promise<Record<string, unknown>[]>;
}

function toRecords<T>(rows: T[]): Record<string, unknown>[] {
  return rows as unknown as Record<string, unknown>[];
}

export const TASKS: ITaskDef[] = [
  {
    task: 1,
    prompt:
      "Copy all rows from the rss_inbox table into the news table, so that news contains exactly the same rows with all column values unchanged.",
    sourceTables: ["rss_inbox"],
    targetTable: "news",
    allowedWriteTables: ["news"],
    expectedTargetRowsAsync: async (): Promise<Record<string, unknown>[]> => {
      const rows: IRssRow[] = [];
      for (let i: number = 1; i <= 15; i++) {
        rows.push(buildRssRow(i));
      }
      return toRecords(rows);
    },
  },
  {
    task: 2,
    prompt:
      "Copy the rows from the rss_inbox table whose title contains the text QUANTUM into the news_filtered table, keeping all column values unchanged.",
    sourceTables: ["rss_inbox"],
    targetTable: "news_filtered",
    allowedWriteTables: ["news_filtered"],
    expectedTargetRowsAsync: async (): Promise<Record<string, unknown>[]> => {
      const rows: IRssRow[] = [];
      for (let i: number = 1; i <= 15; i++) {
        const row: IRssRow = buildRssRow(i);
        if (row.title.includes("QUANTUM")) {
          rows.push(row);
        }
      }
      return toRecords(rows);
    },
  },
  {
    task: 3,
    prompt:
      "In the crm_contacts table, change every row so that its discount value is increased by 10 and its status value is converted to uppercase. When finished, crm_contacts must contain exactly the 30 updated rows, keeping the same ids and all other column values unchanged.",
    sourceTables: ["crm_contacts"],
    targetTable: "crm_contacts",
    allowedWriteTables: ["crm_contacts"],
    expectedTargetRowsAsync: async (): Promise<Record<string, unknown>[]> => {
      const rows: IContactRow[] = [];
      for (let i: number = 1; i <= 30; i++) {
        const row: IContactRow = buildContactRow(i);
        rows.push({
          ...row,
          discount: row.discount + 10,
          status: row.status.toUpperCase(),
        });
      }
      return toRecords(rows);
    },
  },
  {
    task: 4,
    prompt:
      "Copy all rows from the legacy_orders table into the orders_v2 table, so that orders_v2 contains exactly the same rows with all column values unchanged.",
    sourceTables: ["legacy_orders"],
    targetTable: "orders_v2",
    allowedWriteTables: ["orders_v2"],
    expectedTargetRowsAsync: async (): Promise<Record<string, unknown>[]> => {
      const rows: IOrderRow[] = [];
      for (let i: number = 1; i <= 40; i++) {
        rows.push(buildOrderRow(i));
      }
      return toRecords(rows);
    },
  },
];

export function getTaskDef(task: number): ITaskDef {
  const def: ITaskDef | undefined = TASKS.find((t) => t.task === task);
  if (!def) {
    throw new Error(`getTaskDef: unknown task ${task}`);
  }
  return def;
}
