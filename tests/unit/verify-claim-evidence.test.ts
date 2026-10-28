import { describe, expect, it } from "vitest";
import { type ToolExecutionOptions, type ToolSet } from "ai";
import { createVerifyClaimEvidenceTool } from "../../src/tools/verify-claim-evidence.tool.js";
import { createRunCodeTool } from "../../src/tools/run-code.tool.js";
import { VariableStore, wrapToolSetWithVariables } from "../../src/utils/variable-store.js";

const noOptions = {} as ToolExecutionOptions<never>;
const url = "https://example.net/ps4-release";
const sourceText = `<main><h1>PS4 jailbreak</h1><p>A fork removes the need to press X after inserting the disc, making the jailbreak auto-run.</p><p>Users of PS5 Autoloader can copy a payload file to /data for automatic boot loading.</p><p>PS4 firmware 12.50 can use the NetControl kernel exploit.</p></main>`;

function fixture() {
  const store = new VariableStore();
  const source = store.maybeCapture("mcp.stealth.browser_read_html", sourceText, true, url) as { variable: string; sourceUrl: string };
  const verify = createVerifyClaimEvidenceTool(() => store);
  const call = (claims: Array<{ claim: string; sourceVariable: string; exactQuote: string; claimedPlatform?: "PS4" | "PS5" | "other" }>) =>
    verify.execute!({ claims }, noOptions);
  return { store, source, call };
}

describe("web research evidence verifier", () => {
  it("detects PS5 evidence misapplied to a PS4 persistent-jailbreak claim", async () => {
    const { store, source, call } = fixture();
    const result = await call([{ claim: "GoldHEN starts automatically on every PS4 power-on",
      sourceVariable: source.variable,
      exactQuote: "Users of PS5 Autoloader can copy a payload file to /data for automatic boot loading.",
      claimedPlatform: "PS4" }]) as Record<string, any>;
    expect(result.ok).toBe(true);
    expect(result.results[0]).toMatchObject({ status: "scope_mismatch", sourceUrl: url, quoteFound: true });
    expect(store.get(result.ledgerVariable)).toEqual(result.results);
  });

  it("matching words about disc auto-run still warn that semantic entailment is unverified", async () => {
    const { source, call } = fixture();
    const result = await call([{ claim: "PS4 GoldHEN survives a full shutdown",
      sourceVariable: source.variable,
      exactQuote: "A fork removes the need to press X after inserting the disc, making the jailbreak auto-run.",
      claimedPlatform: "PS4" }]) as Record<string, any>;
    expect(result.results[0].status).toBe("passage_found");
    expect(result.results[0].note).toContain("does not establish");
    expect(result.caution).toContain("logical entailment");
  });

  it("rejects a made-up quotation and a missing source", async () => {
    const { source, call } = fixture();
    const result = await call([
      { claim: "PS4 has an officially supported permanent kernel patch", sourceVariable: source.variable,
        exactQuote: "Every PS4 automatically boots GoldHEN after a cold restart." },
      { claim: "Product X supports version 99", sourceVariable: "nonexistent_123",
        exactQuote: "Product X supports version 99." },
    ]) as Record<string, any>;
    expect(result.results.map((r: {status: string}) => r.status)).toEqual(["quote_not_found", "missing_source_variable"]);
  });

  it("does not treat a search snippet as an attributed primary source", async () => {
    const { store, call } = fixture();
    const snippet = store.maybeCapture("mcp.searxng.searxng_web_search", "Some website claims firmware upgrade is safe.", true) as { variable: string };
    const result = await call([{ claim: "Firmware upgrade is safe", sourceVariable: snippet.variable,
      exactQuote: "Some website claims firmware upgrade is safe." }]) as Record<string, any>;
    expect(result.results[0]).toMatchObject({ status: "source_unattributed", sourceUrl: null });
  });

  it("checks unrelated platform facts without making false semantic claims", async () => {
    const { store, call } = fixture();
    const linuxSource = store.maybeCapture("mcp.stealth.browser_read_text",
      "Linux kernel 6.18 implements feature A. Older 6.12 builds do not include feature A.", true,
      "https://example.net/linux/releases") as {variable:string};
    const result = await call([{ claim: "Linux kernel 6.12 implements feature A", sourceVariable: linuxSource.variable,
      exactQuote: "Older 6.12 builds do not include feature A." }]) as Record<string, any>;
    expect(result.results[0].status).toBe("passage_found");
    expect(result.results[0].note).toMatch(/does not establish/);
  });

  it("rejects a synthetic quote even when run_code retains the original URL", async () => {
    const { store, source, call } = fixture();
    const run = createRunCodeTool(() => store);
    const derived = await run.execute!({code:`const x=${source.variable}; return x.replace("Users of PS5 Autoloader", "Users of PS4 Autoloader");`},noOptions) as {variable:string};
    expect(store.getSourceKind(derived.variable)).toBe("derived");
    const checked = await call([{claim:"PS4 automatically loads GoldHEN on boot", sourceVariable:derived.variable,
      exactQuote:"Users of PS4 Autoloader can copy a payload file to /data for automatic boot loading.",claimedPlatform:"PS4"}]) as Record<string,any>;
    expect(checked.results[0].status).toBe("quote_not_found");
    expect(checked.results[0].originalVariable).toBe(source.variable);
  });

  it("preserves original URL across run_code-derived output and restart snapshot", async () => {
    const { store, source } = fixture();
    const runCode = createRunCodeTool(() => store);
    const result = await runCode.execute!({ code: `const x=${source.variable}; print(x.slice(0,160)); return x.slice(10,200);` }, noOptions) as Record<string, any>;
    expect(store.getSourceUrl(result.variable)).toBe(url);
    const restored = VariableStore.fromSnapshot(JSON.parse(JSON.stringify(store.snapshot())));
    expect(restored.getSourceUrl(result.variable)).toBe(url);
    expect(restored.getSourceUrl(source.variable)).toBe(url);
  });

  it("tracks separate fetched URLs without confusing concurrent result conversions", async () => {
    const store = new VariableStore();
    const wrapped = wrapToolSetWithVariables({ "mcp.searxng.web_url_read": {
      execute: async (args: any) => ({ text: args.url.endsWith("blocked")
        ? "MCP_TOOL_FAILED (403)" : "Y".repeat(5000) }),
      toModelOutput: ({output}: any) => ({ type: "content", value: [{type:"text",text:output.text}] }),
    } } as unknown as ToolSet, () => store);
    const tool = wrapped["mcp.searxng.web_url_read"];
    const first = await tool.execute!({url:"https://docs.example.org/first"},noOptions);
    const second = await tool.execute!({url:"https://docs.example.org/second"},noOptions);
    const blocked = await tool.execute!({url:"https://docs.example.org/blocked"},noOptions);
    const converted = (output: unknown) => JSON.parse((tool.toModelOutput!({output} as any) as any).value[0].text);
    const two = converted(second);
    const one = converted(first);
    expect(one.sourceUrl).toBe("https://docs.example.org/first");
    expect(two.sourceUrl).toBe("https://docs.example.org/second");
    expect(store.getSourceUrl(one.variable)).toBe(one.sourceUrl);
    expect((tool.toModelOutput!({output:blocked} as any) as any).value[0].text).toContain("MCP_TOOL_FAILED");
  });

  it("bundled research skill parses and describes evidence verification", async () => {
    const { resolve } = await import("node:path");
    const { parseSkillFrontmatterAsync, loadSkillInstructionsAsync } = await import("../../src/skills/parser.js");
    const file = resolve("skills/web-research/SKILL.md");
    const metadata = await parseSkillFrontmatterAsync(file);
    const instructions = await loadSkillInstructionsAsync(file);
    expect(metadata.name).toBe("web-research");
    expect(instructions).toContain("abandon the explanation");
    expect(instructions).toContain("Search efficiently");
    expect(instructions).not.toContain("PS4");
  });

  it("attributes successfully navigated browser pages but never HTTP 403 pages", async () => {
    const store = new VariableStore();
    const tools = wrapToolSetWithVariables({
      "mcp.stealth.browser_navigate": { execute: async (args: any) => ({ content: [{ type: "text", text:
        args.url.includes("blocked") ? "PAGE_HTTP_ERROR (HTTP 403)" : "navigated (HTTP 200)" }] }) },
      "mcp.stealth.browser_read_html": {
        execute: async () => ({ text: "z".repeat(5000) }),
        toModelOutput: ({output}: any) => ({ type: "content", value: [{ type: "text", text: output.text }] }),
      },
    } as unknown as ToolSet, () => store);
    const navigate = (newUrl: string) => tools["mcp.stealth.browser_navigate"].execute!({url:newUrl},noOptions);
    const read = async () => {
      const output = await tools["mcp.stealth.browser_read_html"].execute!({},noOptions);
      return tools["mcp.stealth.browser_read_html"].toModelOutput!({ output } as any) as any;
    };
    await navigate(url);
    const good = await read();
    const parsed = JSON.parse(good.value[0].text);
    expect(parsed.sourceUrl).toBe(url);
    expect(store.getSourceUrl(parsed.variable)).toBe(url);
    await navigate("https://example.net/blocked");
    const bad = await read();
    const blocked = JSON.parse(bad.value[0].text);
    expect(blocked.sourceUrl).toBeUndefined();
    expect(store.getSourceUrl(blocked.variable)).toBeUndefined();
  });
});
