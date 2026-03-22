import { describe, it, expect } from "vitest";
import * as toolRegistry from "../../src/helpers/tool-registry.js";

describe("tool-registry", () => {
  describe("isToolAllowed", () => {
    it("should block all tools for 'ignore' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "ignore", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("send_message", "ignore", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("run_cmd", "ignore", {})).toBe(false);
    });

    it("should allow all non-blocked tools for 'full' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "full", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("send_message", "full", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("get_cron", "full", {})).toBe(true);
    });

    it("should block destructive tools for 'read_only' permission", () => {
      expect(toolRegistry.isToolAllowed("run_cmd", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("write_file", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("edit_file", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("wait_for_cmd", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("add_cron", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("remove_cron", "read_only", {})).toBe(false);
      expect(toolRegistry.isToolAllowed("create_database", "read_only", {})).toBe(false);
    });

    it("should allow safe tools for 'read_only' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "read_only", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("send_message", "read_only", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("get_cron", "read_only", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("read_file", "read_only", {})).toBe(true);
      expect(toolRegistry.isToolAllowed("list_files", "read_only", {})).toBe(true);
    });

    it("should block job creation tools when jobCreationEnabled is false", () => {
      expect(
        toolRegistry.isToolAllowed("start_job_creation", "full", { jobCreationEnabled: false })
      ).toBe(false);
      expect(
        toolRegistry.isToolAllowed("add_agent_node", "full", { jobCreationEnabled: false })
      ).toBe(false);
      expect(
        toolRegistry.isToolAllowed("add_python_code_node", "full", { jobCreationEnabled: false })
      ).toBe(false);
    });

    it("should allow job creation tools when jobCreationEnabled is true", () => {
      expect(
        toolRegistry.isToolAllowed("start_job_creation", "full", { jobCreationEnabled: true })
      ).toBe(true);
      expect(
        toolRegistry.isToolAllowed("add_agent_node", "full", { jobCreationEnabled: true })
      ).toBe(true);
      expect(
        toolRegistry.isToolAllowed("run_node_test", "full", { jobCreationEnabled: true })
      ).toBe(true);
    });

    it("should allow skill tools when skill is in skillNames", () => {
      expect(
        toolRegistry.isToolAllowed("my_skill", "full", { skillNames: ["my_skill", "other_skill"] })
      ).toBe(true);
      expect(
        toolRegistry.isToolAllowed("other_skill", "full", { skillNames: ["my_skill", "other_skill"] })
      ).toBe(true);
    });

    it("should fall through for unknown tools (handled by core tools check)", () => {
      expect(toolRegistry.isToolAllowed("unknown_skill", "full", { skillNames: ["my_skill"] })).toBe(
        true
      );
    });

    it("should block read_only destructive tools even when jobCreationEnabled is true", () => {
      expect(
        toolRegistry.isToolAllowed("run_cmd", "read_only", { jobCreationEnabled: true })
      ).toBe(false);
      expect(
        toolRegistry.isToolAllowed("write_file", "read_only", { jobCreationEnabled: true })
      ).toBe(false);
    });
  });

  describe("getAllowedToolNames", () => {
    it("should return empty array for 'ignore' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("ignore", {});
      expect(allowed).toEqual([]);
    });

    it("should return all core tools for 'full' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("full", { jobCreationEnabled: false });
      expect(allowed).toContain("think");
      expect(allowed).toContain("send_message");
      expect(allowed).toContain("get_cron");
      expect(allowed).toContain("wait_for_cmd");
      expect(allowed).not.toContain("start_job_creation");
    });

    it("should include job creation tools when enabled", () => {
      const allowed = toolRegistry.getAllowedToolNames("full", { jobCreationEnabled: true });
      expect(allowed).toContain("start_job_creation");
      expect(allowed).toContain("add_agent_node");
    });

    it("should exclude destructive tools for 'read_only' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("read_only", {});
      expect(allowed).toContain("think");
      expect(allowed).toContain("get_cron");
      expect(allowed).not.toContain("run_cmd");
      expect(allowed).not.toContain("wait_for_cmd");
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("add_cron");
    });

    it("should include skills when provided", () => {
      const allowed = toolRegistry.getAllowedToolNames("full", { skillNames: ["skill_a", "skill_b"] });
      expect(allowed).toContain("skill_a");
      expect(allowed).toContain("skill_b");
    });
  });

  describe("getBlockedToolNamesForReadOnly", () => {
    it("should return list of tools blocked in read_only mode", () => {
      const blocked = toolRegistry.getBlockedToolNamesForReadOnly();
      expect(blocked).toContain("run_cmd");
      expect(blocked).toContain("wait_for_cmd");
      expect(blocked).toContain("write_file");
      expect(blocked).toContain("add_cron");
      expect(blocked).toContain("remove_cron");
      expect(blocked).toContain("create_database");
      expect(blocked.length).toBeGreaterThan(30);
    });
  });

  describe("getJobCreationToolNames", () => {
    it("should return job creation tools", () => {
      const tools = toolRegistry.getJobCreationToolNames();
      expect(tools).toContain("start_job_creation");
      expect(tools).toContain("finish_job_creation");
      expect(tools).toContain("add_agent_node");
      expect(tools).toContain("add_python_code_node");
      expect(tools).toContain("run_node_test");
    });
  });
});
