import { describe, expect, it } from "vitest";

import { CRON_TOOL_DESCRIPTIONS } from "../../../src/shared/constants/cron-descriptions.js";

describe("CRON_TOOL_DESCRIPTIONS quality", () => {
  it("includes a list_tables description", () => {
    expect(CRON_TOOL_DESCRIPTIONS).toHaveProperty("list_tables");
    expect(CRON_TOOL_DESCRIPTIONS.list_tables.toLowerCase()).toContain("list all");
    expect(CRON_TOOL_DESCRIPTIONS.list_tables.toLowerCase()).toContain("table");
  });

  it("documents get_table_schema as read-only", () => {
    expect(CRON_TOOL_DESCRIPTIONS.get_table_schema.toLowerCase()).toContain("read-only");
  });

  it("warns that drop_table is irreversible", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.drop_table.toLowerCase();
    expect(description).toContain("cannot be undone");
    expect(description).toContain("permanent");
  });

  it("documents create_table behavior when table already exists", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.create_table.toLowerCase();
    expect(description).toContain("already exists");
    expect(description).toContain("fails");
  });

  it("clarifies update_table naming pattern", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS["update_table_<tableName>"].toLowerCase();
    expect(description).toContain("actual tool name");
    expect(description).toContain("update_table_users");
  });

  it("documents list_timed output fields", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.list_timed.toLowerCase();
    expect(description).toContain("returns");
    expect(description).toContain("taskid");
    expect(description).toContain("schedule");
  });

  it("documents get_previous_message lookup scope", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.get_previous_message.toLowerCase();
    expect(description).toContain("top 10");
    expect(description).toContain("no fixed time window");
  });

  it("documents read_from_database as read-only", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.read_from_database.toLowerCase();
    expect(description).toContain("read-only");
  });

  it("documents read_from_database pagination controls", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.read_from_database.toLowerCase();
    expect(description).toContain("offset");
    expect(description).toContain("default 20");
    expect(description).toContain("max 50");
    expect(description).toContain("remaining");
  });

  it("documents update_table as permanent mutation", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS["update_table_<tableName>"].toLowerCase();
    expect(description).toContain("permanently modifies");
  });

  it("documents delete_from_database as permanent deletion", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.delete_from_database.toLowerCase();
    expect(description).toContain("permanently deletes");
  });

  it("documents send_message novelty rejection behavior", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.send_message.toLowerCase();
    expect(description).toContain("suppressedreason='novelty'");
    expect(description).toContain("sent=false");
  });

  it("documents send_message dispatch policy criteria", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.send_message.toLowerCase();
    expect(description).toContain("required deliverables");
    expect(description).toContain("operational chatter");
  });

  it("documents send_message novelty scope", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.send_message.toLowerCase();
    expect(description).toContain("same-task stored message history");
    expect(description).toContain("no fixed time window");
  });
});
