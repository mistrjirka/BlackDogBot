import TurndownService from "turndown";
import { preprocessThinkTags } from "./telegram-format.js";

const turndown: TurndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

turndown.addRule("blockquote", {
  filter: "blockquote",
  replacement: (content: string): string => {
    const trimmed: string = content.trim();
    if (!trimmed) return "";
    const lines: string[] = trimmed.split("\n");
    return lines.map((line: string) => `> ${line}`).join("\n") + "\n\n";
  },
});

turndown.addRule("tg-spoiler", {
  filter: (node: unknown): boolean => typeof node === "object" && node !== null && "nodeName" in node && (node as { nodeName: string }).nodeName === "TG-SPOILER",
  replacement: (content: string): string => `||${content}||`,
});

turndown.addRule("u", {
  filter: "u",
  replacement: (content: string): string => `__${content}__`,
});

export function htmlToMarkdown(html: string): string {
  const preprocessed: string = preprocessThinkTags(html);
  return turndown.turndown(preprocessed);
}
