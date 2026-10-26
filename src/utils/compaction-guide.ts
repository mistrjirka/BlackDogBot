import type { ModelMessage } from "ai";

const GUIDE_START = "[[BLACKDOGBOT_RUN_VARIABLES_BEGIN]]";
const GUIDE_END = "[[BLACKDOGBOT_RUN_VARIABLES_END]]";

function wrapGuide(guide: string): string {
  return `\n\n${GUIDE_START}\n${guide}\n${GUIDE_END}`;
}

/**
 * Include a snapshot of live blackboard names exactly once after compaction,
 * at the end of the retained tool cycle. Never modify system instructions.
 * Subsequent captures have their own variable stubs and do not rewrite this.
 */
export function attachCompactionGuide(messages: ModelMessage[], guide: string | null): ModelMessage[] {
  if (!guide || messages.length === 0) return messages;

  const note = wrapGuide(guide);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;

    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part.type !== "tool-result") continue;
      const output = part.output;

      if (output.type === "text" || output.type === "content") {
        const annotated = output.type === "text"
          ? { ...output, value: output.value + note }
          : { ...output, value: [...output.value, { type: "text" as const, text: note }] };
        const content = [...message.content];
        content[j] = { ...part, output: annotated };
        const next = [...messages];
        next[i] = { ...message, content };
        return next;
      }
    }
  }

  // A checkpoint with no retained text tool result: append to its user summary
  // rather than putting changing content in the system prompt.
  const index = messages.findIndex((message) => message.role === "user");
  if (index < 0) return messages;
  const message = messages[index];
  if (message.role !== "user") return messages;
  const content = typeof message.content === "string"
    ? message.content + note
    : [...message.content, { type: "text" as const, text: note }];
  const next = [...messages];
  next[index] = { ...message, content };
  return next;
}

function removeGuide(value: string): string {
  let result = value;
  for (;;) {
    const start = result.indexOf("\n\n" + GUIDE_START);
    if (start < 0) return result;
    const end = result.indexOf(GUIDE_END, start);
    if (end < 0) return result;
    result = result.slice(0, start) + result.slice(end + GUIDE_END.length);
  }
}

/** Drop run-local names before they enter persistent conversation history. */
export function stripCompactionGuides(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-result") return part;
          const output = part.output;
          if (output.type === "text") return { ...part, output: { ...output, value: removeGuide(output.value) } };
          if (output.type === "content") {
            return {
              ...part,
              output: {
                ...output,
                value: output.value
                  .filter((item) => !(item.type === "text" && item.text.includes(GUIDE_START)))
                  .map((item) => item.type === "text" ? { ...item, text: removeGuide(item.text) } : item),
              },
            };
          }
          return part;
        }),
      };
    }
    if (message.role === "user") {
      const content = message.content;
      return {
        ...message,
        content: typeof content === "string"
          ? removeGuide(content)
          : content
            .filter((part) => !(part.type === "text" && part.text.includes(GUIDE_START)))
            .map((part) => part.type === "text" ? { ...part, text: removeGuide(part.text) } : part),
      };
    }
    return message;
  });
}
