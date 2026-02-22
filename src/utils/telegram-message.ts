const TELEGRAM_MAX_LENGTH: number = 4096;

export function splitTelegramMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (!text) {
    return [''];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining: string = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at double newline
    let splitIndex: number = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex > 0) {
      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex + 2); // skip the \n\n
      continue;
    }

    // Try to split at single newline
    splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex > 0) {
      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex + 1); // skip the \n
      continue;
    }

    // Hard split
    chunks.push(remaining.substring(0, maxLength));
    remaining = remaining.substring(maxLength);
  }

  return chunks.filter((chunk: string) => chunk.length > 0);
}
