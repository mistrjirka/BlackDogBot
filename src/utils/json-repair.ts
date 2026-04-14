export function parseJsonWithCommonRepairs(rawText: string): unknown {
  const directText: string = rawText.trim();
  const directResult: unknown = _tryParse(directText);
  if (directResult !== null) {
    return directResult;
  }

  const extractedCandidate: string = _extractJsonCandidate(directText);
  const extractedResult: unknown = _tryParse(extractedCandidate);
  if (extractedResult !== null) {
    return extractedResult;
  }

  const withoutTrailingCommas: string = extractedCandidate.replace(/,\s*([}\]])/g, "$1");
  const noTrailingCommasResult: unknown = _tryParse(withoutTrailingCommas);
  if (noTrailingCommasResult !== null) {
    return noTrailingCommasResult;
  }

  const withoutDanglingQuotes: string = _removeDanglingStringQuotes(withoutTrailingCommas);
  const noDanglingQuotesResult: unknown = _tryParse(withoutDanglingQuotes);
  if (noDanglingQuotesResult !== null) {
    return noDanglingQuotesResult;
  }

  const normalizedQuotes: string = _normalizeSingleQuotedStrings(withoutDanglingQuotes);
  const normalizedQuotesResult: unknown = _tryParse(normalizedQuotes);
  if (normalizedQuotesResult !== null) {
    return normalizedQuotesResult;
  }

  const balancedCandidate: string = _appendMissingClosers(normalizedQuotes);
  const balancedResult: unknown = _tryParse(balancedCandidate);
  if (balancedResult !== null) {
    return balancedResult;
  }

  throw new Error("Unable to parse JSON even after repair attempts.");
}

function _removeDanglingStringQuotes(input: string): string {
  return input.replace(/\]\s*"\s*}/g, "]}").replace(/}\s*"\s*]/g, "}]");
}

function _normalizeSingleQuotedStrings(input: string): string {
  let output: string = "";
  let inDoubleString: boolean = false;
  let inSingleString: boolean = false;
  let isEscaped: boolean = false;

  for (let i: number = 0; i < input.length; i++) {
    const ch: string = input[i];

    if (isEscaped) {
      output += ch;
      isEscaped = false;
      continue;
    }

    if (ch === "\\") {
      output += ch;
      isEscaped = true;
      continue;
    }

    if (!inSingleString && ch === '"') {
      inDoubleString = !inDoubleString;
      output += ch;
      continue;
    }

    if (!inDoubleString && ch === "'") {
      inSingleString = !inSingleString;
      output += '"';
      continue;
    }

    output += ch;
  }

  return output;
}

function _tryParse(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function _extractJsonCandidate(rawText: string): string {
  const fencedMatch: RegExpMatchArray | null = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch !== null) {
    return fencedMatch[1].trim();
  }

  const startIndex: number = rawText.indexOf("{");
  const endIndex: number = rawText.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    return rawText.slice(startIndex, endIndex + 1);
  }

  return rawText;
}

function _appendMissingClosers(input: string): string {
  const stack: string[] = [];
  let inString: boolean = false;
  let isEscaped: boolean = false;

  for (let i: number = 0; i < input.length; i++) {
    const ch: string = input[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (ch === "\\") {
        isEscaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}") {
      if (stack[stack.length - 1] === "{") {
        stack.pop();
      }
      continue;
    }

    if (ch === "]") {
      if (stack[stack.length - 1] === "[") {
        stack.pop();
      }
      continue;
    }
  }

  const closers: string[] = [];
  for (let i: number = stack.length - 1; i >= 0; i--) {
    closers.push(stack[i] === "{" ? "}" : "]");
  }

  return input + closers.join("");
}
