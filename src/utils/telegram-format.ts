import { marked } from "marked";
import { transform as tghtml } from "@adriangalilea/tghtml";

const THINK_TAG_PATTERN = /<(think|thinking|reasoning|reflection|details)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
const SELF_CLOSING_THINK = /<(think|thinking|reasoning)\/>/gi;
const MD_THINK_PATTERN = /\[think\]([\s\S]*?)\[\/think\]/gi;

//#region Table Parsing and Formatting

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parses markdown table lines into structured data.
 * @param lines - Array of lines that form a table (including separator line)
 * @returns ParsedTable object with headers and rows
 */
function parseMarkdownTable(lines: string[]): ParsedTable {
  const headers: string[] = [];
  const rows: string[][] = [];
  
  // Find separator line index (matches lines like |---|---|)
  let separatorIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match separator lines: | followed by groups of spaces, hyphens, colons separated by |
    if (/^\s*\|([\s\-:]+\|)+\s*$/.test(line)) {
      separatorIndex = i;
      break;
    }
  }
  
  if (separatorIndex === -1) {
    // No separator line found, treat all lines as data rows
    for (const line of lines) {
      const cells = line.split('|').filter(cell => cell.trim() !== '');
      rows.push(cells.map(cell => cell.trim()));
    }
    return { headers: [], rows };
  }
  
  // Parse header row (line before separator)
  if (separatorIndex > 0) {
    const headerLine = lines[separatorIndex - 1];
    const cells = headerLine.split('|').filter(cell => cell.trim() !== '');
    headers.push(...cells.map(cell => cell.trim()));
  }
  
  // Parse data rows (lines after separator)
  for (let i = separatorIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const cells = line.split('|').filter(cell => cell.trim() !== '');
    rows.push(cells.map(cell => cell.trim()));
  }
  
  return { headers, rows };
}

/**
 * Formats a parsed table as a compact bullet list for Telegram.
 * Uses bullet points with key-value pairs for readability.
 */
function formatTableAsBulletList(table: ParsedTable): string {
  const result: string[] = [];
  
  // If table has headers, show them as a title
  if (table.headers.length > 0) {
    result.push(`📊 Table (${table.headers.length} columns)`);
  }
  
  // Format each row
  table.rows.forEach((row) => {
    if (table.headers.length > 0) {
      // Format with headers as key-value pairs
      const pairs = table.headers.map((header, colIndex) => {
        const value = row[colIndex] || '';
        return `*${header}*: ${value}`;
      });
      result.push(`• ${pairs.join(', ')}`);
    } else {
      // No headers, just show values
      result.push(`• ${row.join(' | ')}`);
    }
  });
  
  return result.join('\n');
}

/**
 * Converts markdown tables to bullet lists for Telegram.
 * Telegram doesn't support HTML table tags, and long table rows in code blocks
 * can exceed message limits and cause splitting issues.
 * Bullet lists are more readable in messaging apps and avoid these problems.
 */
export function convertTablesToBulletLists(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;
  let insideCodeBlock = false;
  
  while (i < lines.length) {
    const line = lines[i];
    
    // Track code block boundaries
    if (line.trim().startsWith('```')) {
      insideCodeBlock = !insideCodeBlock;
      result.push(line);
      i++;
      continue;
    }
    
    // Skip table detection if we're inside a code block
    if (insideCodeBlock) {
      result.push(line);
      i++;
      continue;
    }
    
    // Check if this line looks like a table row (starts with | and has at least two |)
    // Exclude lines that are just spoiler delimiters (||)
    if (/^\s*\|.*\|.*\|/.test(line) && !/^\s*\|\|.*\|\|\s*$/.test(line)) {
      // Start of a potential table region
      const tableLines: string[] = [];
      let j = i;
      // Collect consecutive lines that look like table rows or separator lines
      while (j < lines.length) {
        const currentLine = lines[j];
        // Skip if we encounter a code block start inside the region
        if (currentLine.trim().startsWith('```')) {
          break;
        }
        // Table row: starts with | and has at least two |, but not spoiler delimiters
        const isTableRow = /^\s*\|.*\|.*\|/.test(currentLine) && !/^\s*\|\|.*\|\|\s*$/.test(currentLine);
        // Separator line: starts with |, contains only |, -, :, spaces, and optional leading/trailing spaces
        const isSeparator = /^\s*\|([\s\-:]+\|)+\s*$/.test(currentLine);
        if (isTableRow || isSeparator) {
          tableLines.push(currentLine);
          j++;
        } else {
          break;
        }
      }
      
      // Only convert if we have at least 2 lines (header + separator or header + row)
      // Also ensure we have a separator line (common in markdown tables)
      const hasSeparator = tableLines.some(line => /^\s*\|([\s\-:]+\|)+\s*$/.test(line));
      if (tableLines.length >= 2 && (hasSeparator || tableLines.length >= 3)) {
        // Parse the table and format as bullet list
        const parsedTable = parseMarkdownTable(tableLines);
        const bulletList = formatTableAsBulletList(parsedTable);
        result.push(bulletList);
        i = j; // Skip past the table lines
      } else {
        // Not a valid table, keep the line as-is
        result.push(line);
        i++;
      }
    } else {
      result.push(line);
      i++;
    }
  }
  
  return result.join('\n');
}

//#endregion Table Parsing and Formatting

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
    .replace(MD_THINK_PATTERN, "\n> $1\n")
    .replace(/<\/(think|thinking|reasoning)>/gi, "");
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown || markdown.trim() === "") {
    return "";
  }
  const withThinkBlocks = preprocessThinkTags(markdown);
  const withTablesConverted = convertTablesToBulletLists(withThinkBlocks);
  const html = marked.parse(withTablesConverted, { gfm: true, breaks: true }) as string;
  return tghtml(html);
}

export function stripAllHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}
