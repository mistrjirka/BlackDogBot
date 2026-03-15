export function splitMessageByLength(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining: string = text;

  while (remaining.length > 0) {
    let splitIndex: number = maxLength;

    const lastNewline: number = remaining.lastIndexOf("\n", maxLength);
    const lastSpace: number = remaining.lastIndexOf(" ", maxLength);

    if (lastNewline > maxLength * 0.5) {
      splitIndex = lastNewline + 1;
    } else if (lastSpace > maxLength * 0.5) {
      splitIndex = lastSpace + 1;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex);
  }

  return chunks;
}
