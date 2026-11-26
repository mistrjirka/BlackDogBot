/**
 * Replace isolated UTF-16 surrogates in model-visible text. Valid pairs and
 * UTF-16 length stay unchanged, so stored values and offsets need no rewrite.
 */
export function toWellFormedText(text: string): string {
  // Unicode mode treats a valid pair as one code point outside this range.
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}
