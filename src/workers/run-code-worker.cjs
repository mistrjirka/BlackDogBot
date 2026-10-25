"use strict";
// Isolated pure-data worker. No bot tool registry, file API, network API or module
// loader is provided to evaluated code. The host enforces time and memory limits.
const vm = require("node:vm");
const MAX_PRINT_CHARS = 1000;
const MAX_DISPLAY_CHARS = 8000;
const MAX_RETURN_BYTES = 1024 * 1024;

process.once("message", ({ code, variables }) => {
  let display = "";
  let truncated = false;
  const print = (value) => {
    let rendered;
    try {
      if (typeof value === "string") rendered = value;
      else if (Array.isArray(value)) rendered = JSON.stringify(value.slice(0, 3)) + (value.length > 3 ? ` …(+${value.length - 3} more)` : "");
      else rendered = JSON.stringify(value);
    } catch { rendered = String(value); }
    rendered ??= "undefined";
    if (rendered.length > MAX_PRINT_CHARS) {
      rendered = `${rendered.slice(0, MAX_PRINT_CHARS)}… [print truncated]`;
      truncated = true;
    }
    const available = Math.max(0, MAX_DISPLAY_CHARS - display.length);
    if (rendered.length + 1 > available) truncated = true;
    display += (display ? "\n" : "") + rendered.slice(0, Math.max(0, available - (display ? 1 : 0)));
    if (display.length > MAX_DISPLAY_CHARS) display = display.slice(0, MAX_DISPLAY_CHARS);
  };
  try {
    const sandbox = Object.create(null);
    for (const [name, value] of Object.entries(variables)) {
      Object.defineProperty(sandbox, name, { value, enumerable: true, configurable: false, writable: false });
    }
    Object.defineProperty(sandbox, "print", { value: print, writable: false });
    Object.defineProperty(sandbox, "console", { value: Object.freeze({log: print}), writable: false });
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const script = new vm.Script(`(function(){\n${code}\n})()`, { filename: "blackdog-run-code.js" });
    const value = script.runInContext(context, { timeout: 4500 });
    if (value && typeof value.then === "function") {
      process.send({ ok: false, category: "validation", message: "Async returns are not supported." });
      return;
    }
    if (value === undefined) {
      process.send({ ok: true, returned: false, display, truncated });
      return;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      process.send({ ok: false, category: "validation", message: "Return a JSON-serializable value." });
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_RETURN_BYTES) {
      process.send({ ok: false, category: "validation", message: "Return value exceeds 1 MiB. Filter or slice the data before returning." });
      return;
    }
    process.send({ ok: true, returned: true, value: JSON.parse(serialized), display, truncated });
  } catch (e) {
    process.send({ ok: false, category: /Script execution timed out/.test(String(e)) ? "timeout" : "validation", message: String(e.message || e).slice(0, 300) });
  }
});
