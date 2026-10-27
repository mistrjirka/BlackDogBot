"use strict";
// Isolated pure-data worker. No bot tool registry, file API, network API or module
// loader is provided to evaluated code. The host enforces time and memory limits.
const vm = require("node:vm");
const MAX_DISPLAY_CHARS = 16_000;
const MAX_BUFFER_CHARS = 64_000;
const DEFAULT_DISPLAY_CHARS = 3000;
const MAX_RETURN_BYTES = 1024 * 1024;

process.once("message", ({ code, variables, maxOutputChars, maxBufferedChars }) => {
  const displayLimit = Number.isSafeInteger(maxOutputChars)
    ? Math.max(500, Math.min(MAX_DISPLAY_CHARS, maxOutputChars)) : DEFAULT_DISPLAY_CHARS;
  const bufferLimit = Number.isSafeInteger(maxBufferedChars)
    ? Math.max(displayLimit, Math.min(MAX_BUFFER_CHARS, maxBufferedChars)) : MAX_BUFFER_CHARS;
  const parts = [];
  let producedChars = 0;
  let bufferedChars = 0;
  let printCalls = 0;

  // No data is silently omitted by rendering an array: only the global output
  // budgets trim prints. Render values before counting UTF-16 string characters.
  const render = (value) => {
    try {
      if (typeof value === "string") return value;
      return JSON.stringify(value) ?? "undefined";
    } catch { return String(value); }
  };
  const print = (...values) => {
    const chunk = (printCalls++ ? "\n" : "") + values.map(render).join(" ");
    producedChars += chunk.length;
    if (bufferedChars < bufferLimit) {
      const prefix = chunk.slice(0, bufferLimit - bufferedChars);
      parts.push(prefix);
      bufferedChars += prefix.length;
    }
  };
  const finishPrints = () => {
    const bufferedOutput = parts.join("");
    const display = bufferedOutput.slice(0, displayLimit);
    const shownChars = display.length;
    return {
      display,
      truncated: shownChars < producedChars,
      output: {
        producedChars,
        shownChars,
        omittedChars: producedChars - shownChars,
        bufferedChars,
        unbufferedChars: producedChars - bufferedChars,
      },
      // Only transfer the bounded full printed stream when a continuation is
      // necessary; never put this private payload directly into model context.
      ...(shownChars < producedChars ? { bufferedOutput } : {}),
    };
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
      process.send({ ok: true, returned: false, ...finishPrints() });
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
    process.send({ ok: true, returned: true, value: JSON.parse(serialized), ...finishPrints() });
  } catch (e) {
    process.send({ ok: false, category: /Script execution timed out/.test(String(e)) ? "timeout" : "validation", message: String(e.message || e).slice(0, 300) });
  }
});
