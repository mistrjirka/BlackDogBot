import { marked } from "marked";
import { transform as tghtml } from "@adriangalilea/tghtml";

const THINK_TAG_PATTERN = /<(think|thinking|reasoning|reflection|details)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const SELF_CLOSING_THINK = /<(think|thinking|reasoning)\/>/gi;
const MD_THINK_PATTERN = /\[think\]([\s\S]*?)\[\/think\]/gi;

const spoilerExtension = {
  name: "spoiler",
  level: "inline" as const,
  start(src: string): number | undefined {
    return src.match(/\|\|/)?.index;
  },
  tokenizer(src: string): { type: string; raw: string; text: string } | undefined {
    const match = /^\|\|(.+?)\|\|/.exec(src);
    if (match) {
      return { type: "spoiler", raw: match[0], text: match[1] };
    }
    return undefined;
  },
  renderer(token: { text: string }): string {
    return `<tg-spoiler>${token.text}</tg-spoiler>`;
  },
};

marked.use({ extensions: [spoilerExtension] });

export function preprocessThinkTags(text: string): string {
  return text
    .replace(SELF_CLOSING_THINK, "\n> *Thinking...*\n")
    .replace(THINK_TAG_PATTERN, "\n> $3\n")
    .replace(MD_THINK_PATTERN, "\n> $1\n");
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown || markdown.trim() === "") {
    return "";
  }
  const withThinkBlocks = preprocessThinkTags(markdown);
  const html = marked.parse(withThinkBlocks, { gfm: true, breaks: true }) as string;
  return tghtml(html);
}

export function stripAllHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}
