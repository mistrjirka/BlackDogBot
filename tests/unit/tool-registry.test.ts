import { describe, it, expect } from "vitest";
import * as toolRegistry from "../../src/helpers/tool-registry.js";

describe("tool-registry", () => {
  describe("isToolAllowed", () => {
    it("should block all tools for 'ignore' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "ignore")).toBe(false);
      expect(toolRegistry.isToolAllowed("send_message", "ignore")).toBe(false);
      expect(toolRegistry.isToolAllowed("run_cmd", "ignore")).toBe(false);
    });

    it("should allow all non-blocked tools for 'full' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "full")).toBe(true);
      expect(toolRegistry.isToolAllowed("send_message", "full")).toBe(true);
      expect(toolRegistry.isToolAllowed("get_cron", "full")).toBe(true);
    });

    it("should block destructive tools for 'read_only' permission", () => {
      expect(toolRegistry.isToolAllowed("run_cmd", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("write_file", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("edit_file", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("wait_for_cmd", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("read_image", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("add_once", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("remove_timed", "read_only")).toBe(false);
    });

    it("should allow safe tools for 'read_only' permission", () => {
      expect(toolRegistry.isToolAllowed("think", "read_only")).toBe(true);
      expect(toolRegistry.isToolAllowed("send_message", "read_only")).toBe(true);
      expect(toolRegistry.isToolAllowed("get_timed", "read_only")).toBe(true);
      expect(toolRegistry.isToolAllowed("read_file", "read_only")).toBe(true);
      expect(toolRegistry.isToolAllowed("list_files", "read_only")).toBe(true);
    });

    it("should allow unknown tools by default", () => {
      expect(toolRegistry.isToolAllowed("unknown_skill", "full")).toBe(true);
    });

    it("should block read_only destructive tools", () => {
      expect(toolRegistry.isToolAllowed("run_cmd", "read_only")).toBe(false);
      expect(toolRegistry.isToolAllowed("write_file", "read_only")).toBe(false);
    });
  });

  describe("getAllowedToolNames", () => {
    it("should return empty array for 'ignore' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("ignore");
      expect(allowed).toEqual([]);
    });

    it("should return all core tools for 'full' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("full");
      expect(allowed).toContain("think");
      expect(allowed).toContain("send_message");
      expect(allowed).toContain("get_timed");
      expect(allowed).toContain("wait_for_cmd");
      expect(allowed).toContain("load_skill");
      expect(allowed).toContain("list_skills");
      expect(allowed).toContain("delegate_agent");
      expect(allowed).not.toContain("call_skill");
      expect(allowed).toContain("read_image");
      expect(allowed).not.toContain("start_job_creation");
      expect(allowed).not.toContain("add_job");
      expect(allowed).not.toContain("run_job");
      expect(allowed).not.toContain("set_job_schedule");
    });

    it("should exclude destructive tools for 'read_only' permission", () => {
      const allowed = toolRegistry.getAllowedToolNames("read_only");
      expect(allowed).toContain("think");
      expect(allowed).toContain("get_timed");
      expect(allowed).not.toContain("run_cmd");
      expect(allowed).not.toContain("wait_for_cmd");
      expect(allowed).not.toContain("read_image");
      expect(allowed).not.toContain("write_file");
      expect(allowed).not.toContain("add_once");
    });

  });

  describe("getBlockedToolNamesForReadOnly", () => {
    it("should return list of tools blocked in read_only mode", () => {
      const blocked = toolRegistry.getBlockedToolNamesForReadOnly();
      expect(blocked).toContain("run_cmd");
      expect(blocked).toContain("wait_for_cmd");
      expect(blocked).toContain("read_image");
      expect(blocked).toContain("write_file");
      expect(blocked).toContain("add_once");
      expect(blocked).toContain("remove_timed");
      expect(blocked.length).toBe(18);
    });
  });
});
