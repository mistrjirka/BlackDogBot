import { transform as tghtml } from "@adriangalilea/tghtml";

const THINK_TAG_PATTERN = /<(think|thinking|reasoning|reflection|details)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const SELF_CLOSING_THINK_PATTERN = /<(think|thinking|reasoning)\/>/gi;

export function preprocessThinkTags(text: string): string {
  let result: string = text.replace(
    SELF_CLOSING_THINK_PATTERN,
    "<blockquote>Thinking...</blockquote>"
  );
  result = result.replace(THINK_TAG_PATTERN, "<blockquote>$3</blockquote>");
  return result;
}

export function sanitizeTelegramHtml(text: string): string {
  const preprocessed: string = preprocessThinkTags(text);
  return tghtml(preprocessed);
}

export function stripAllHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}
