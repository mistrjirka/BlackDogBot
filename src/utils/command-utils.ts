export function isCancelCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/cancel";
}
