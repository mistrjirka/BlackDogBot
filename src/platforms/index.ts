// Re-export types
export * from "./types.js";
export * from "./registry.js";

// Import platforms to trigger registration
import "./telegram/index.js";
import "./discord/index.js";
