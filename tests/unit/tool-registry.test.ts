import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistryService } from "../../src/services/tool-registry.service.js";

describe("ToolRegistryService", () => {
  let registry: ToolRegistryService;

  beforeEach(() => {
    registry = ToolRegistryService.getInstance();
  });

  describe("isToolAllowed", () => {
    it("should block all tools for 'ignore' permission", () => {
      expect(registry.isToolAllowed("think", "ignore", {})).toBe(false);
      expect(registry.isToolAllowed("send_message", "ignore", {})).toBe(false);
      expect(registry.isToolAllowed("run_cmd", "ignore", {})).toBe(false);
    });

    it("should allow all non-blocked tools for 'full' permission", () => {
      expect(registry.isToolAllowed("think", "full", {})).toBe(true);
      expect(registry.isToolAllowed("send_message", "full", {})).toBe(true);
      expect(registry.isToolAllowed("get_cron", "full", {})).toBe(true);
    });

    it("should block destructive tools for 'read_only' permission", () => {
      expect(registry.isToolAllowed("run_cmd", "read_only", {})).toBe(false);
      expect(registry.isToolAllowed("write_file", "read_only", {})).toBe(false);
      expect(registry.isToolAllowed("edit_file", "read_only", {})).toBe(false);
      expect(registry.isToolAllowed("add_cron", "read_only", {})).toBe(false);
      expect(registry.isToolAllowed("remove_cron", "read_only", {})).toBe(false);
      expect(registry.isToolAllowed("create_database", "read_only", {})).toBe(false);
    });

    it("should allow safe tools for 'read_only' permission", () => {
      expect(registry.isToolAllowed("think", "read_only", {})).toBe(true);
      expect(registry.isToolAllowed("send_message", "read_only", {})).toBe(true);
      expect(registry.isToolAllowed("get_cron", "read_only", {})).toBe(true);
      expect(registry.isToolAllowed("read_file", "read_only", {})).toBe(true);
      expect(registry.isToolAllowed("list_files", "read_only", {})).toBe(true);
    });

    it("should block job creation tools when jobCreationEnabled is false", () => {
      expect(
        registry.isToolAllowed("start_job_creation", "full", { jobCreationEnabled: false })
      ).toBe(false);
      expect(
        registry.isToolAllowed("add_agent_node", "full", { jobCreationEnabled: false })
      ).toBe(false);
      expect(
        registry.isToolAllowed("add_python_code_node", "full", { jobCreationEnabled: false })
      ).toBe(false);
    });

    it("should allow job creation tools when jobCreationEnabled is true", () => {
      expect(
        registry.isToolAllowed("start_job_creation", "full", { jobCreationEnabled: true })
      ).toBe(true);
      expect(
        registry.isToolAllowed("add_agent_node", "full", { jobCreationEnabled: true })
      ).toBe(true);
      expect(
        registry.isToolAllowed("run_node_test", "full", { jobCreationEnabled: true })
      ).toBe(true);
    });

    it("should allow skill tools when skill is in skillNames", () => {
      expect(
        registry.isToolAllowed("my_skill", "full", { skillNames: ["my_skill", "other_skill"] })
      ).toBe(true);
      expect(
        registry.isToolAllowed("other_skill", "full", { skillNames: ["my_skill", "other_skill"] })
      ).toBe(true);
    });

    it("should fall through for unknown tools (handled by core tools check)", () => {
      // Unknown tools not in skillNames fall through to the final return true
      expect(registry.isToolAllowed("unknown_skill", "full", { skillNames: ["my_skill"] })).toBe(
        true
      );
    });

    it("should block read_only destructive tools even when jobCreationEnabled is true", () => {
      expect(
        registry.isToolAllowed("run_cmd", "read_only", { jobCreationEnabled: true })
      ).toBe(false);
      expect(
        registry.isToolAllowed("write_file", "read_only", { jobCreationEnabled: true })
      ).toBe(false);
    });
  });

  describe("getAllowedToolNames", () => {
    it("should return empty array for 'ignore' permission", () => {
      const allowed = registry.getAllowedToolNames("ignore", {});
      expect(allowed).toEqual([]);
    });

    it("should return all core tools for 'full' permission", () => {
      const allowed = registry.getAllowedToolNames("full", { jobCreationEnabled: false });
      expect(allowed).toContain("think");
      expect(allowed).toContain("send_message");
      expect(allowed).toContain("get_cron");
      expect(allowed).not.toContain("start_job_creation");
    });

    it("should include job creation tools when enabled", () => {
      const allowed = registry.getAllowedToolNames("full", { jobCreationEnabled: true });
      expect(allowed).toContain("start_job_creation");
      expect(allowed).toContain("add_agent_node");
    });

    it("should exclude destructive tools for 'read_only' permission", () => {
      const allowed = registry.getAllowedToolNames("read_only", {});
      expect(allowed).toContain("think");
      expect(allowed).toContain("get_cron");
      expect(allowed).not.toContain("run_cmd");
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("add_cron");
    });

    it("should include skills when provided", () => {
      const allowed = registry.getAllowedToolNames("full", { skillNames: ["skill_a", "skill_b"] });
      expect(allowed).toContain("skill_a");
      expect(allowed).toContain("skill_b");
    });
  });

  describe("getBlockedToolNamesForReadOnly", () => {
    it("should return list of tools blocked in read_only mode", () => {
      const blocked = registry.getBlockedToolNamesForReadOnly();
      expect(blocked).toContain("run_cmd");
      expect(blocked).toContain("write_file");
      expect(blocked).toContain("add_cron");
      expect(blocked).toContain("remove_cron");
      expect(blocked).toContain("create_database");
      expect(blocked.length).toBeGreaterThan(30);
    });
  });

  describe("getJobCreationToolNames", () => {
    it("should return job creation tools", () => {
      const tools = registry.getJobCreationToolNames();
      expect(tools).toContain("start_job_creation");
      expect(tools).toContain("finish_job_creation");
      expect(tools).toContain("add_agent_node");
      expect(tools).toContain("add_python_code_node");
      expect(tools).toContain("run_node_test");
    });
  });
});
