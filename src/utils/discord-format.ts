import { preprocessThinkTags } from "./telegram-format.js";

export function formatMarkdownForDiscord(markdown: string): string {
  if (!markdown || markdown.trim() === "") {
    return "";
  }
  return preprocessThinkTags(markdown);
}
