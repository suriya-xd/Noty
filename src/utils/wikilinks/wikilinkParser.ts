import { WikiLinkToken } from "./types";

/**
 * Obsidian wikilink regex:
 * Captures:
 * 1. Target path/filename: [^#|\]\r\n]+?
 * 2. Optional heading anchor: (?:#([^|\]\r\n]+?))?
 * 3. Optional alias / pipe: (?:\|([^\]\r\n]+?))?
 */
export const WIKILINK_REGEX =
  /\[\[([^[\]#|\r\n]+?)(?:#([^[\]|\r\n]+?))?(?:\|([^[\]\r\n]+?))?\]\]/g;

/**
 * Parses a single raw wikilink string into a structured token
 * Example: parseWikiLink("[[My Note#Heading|Alias]]")
 */
export function parseWikiLink(raw: string): WikiLinkToken | null {
  const match = raw.match(
    /^\[\[([^[\]#|\r\n]+?)(?:#([^[\]|\r\n]+?))?(?:\|([^[\]\r\n]+?))?\]\]$/
  );
  if (!match) return null;

  const target = match[1].trim();
  const header = match[2]?.trim();
  const alias = match[3]?.trim();

  let displayText = alias;
  if (!displayText) {
    displayText = header ? `${target} > ${header}` : target;
  }

  return { raw, target, header, alias, displayText };
}

/**
 * Extracts all wikilinks from Markdown content, skipping code blocks and inline code
 */
export function extractWikiLinks(markdown: string): WikiLinkToken[] {
  // Mask code blocks (```...```) and inline code (`...`) to prevent false positives
  const masked = markdown
    .replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*?`/g, (span) => " ".repeat(span.length));

  const tokens: WikiLinkToken[] = [];
  let match: RegExpExecArray | null;

  WIKILINK_REGEX.lastIndex = 0;
  while ((match = WIKILINK_REGEX.exec(masked)) !== null) {
    const raw = markdown.slice(match.index, match.index + match[0].length);
    const parsed = parseWikiLink(raw);
    if (parsed) {
      tokens.push({
        ...parsed,
        index: match.index,
      });
    }
  }

  return tokens;
}

/**
 * Pre-processes Markdown before feeding to standard parsers (e.g. react-markdown).
 * Converts [[Filename#Header|Alias]] into custom URI scheme: [Alias](wikilink:Filename?header=Header)
 */
export function transformWikiLinksToMarkdown(content: string): string {
  // Avoid replacing inside code blocks
  return content.replace(
    /(```[\s\S]*?```|`[^`\n]*?`)|(\[\[([^[\]#|\r\n]+?)(?:#([^[\]|\r\n]+?))?(?:\|([^[\]\r\n]+?))?\]\])/g,
    (_fullMatch, codeBlock, _rawLink, target, header, alias) => {
      if (codeBlock) return codeBlock; // Keep code blocks untouched

      const trimmedTarget = target.trim();
      const trimmedHeader = header ? header.trim() : "";
      const trimmedAlias = alias ? alias.trim() : "";

      const displayText = trimmedAlias || (trimmedHeader ? `${trimmedTarget} > ${trimmedHeader}` : trimmedTarget);
      
      const queryParams = new URLSearchParams();
      if (trimmedHeader) queryParams.set("header", trimmedHeader);
      const queryStr = queryParams.toString() ? `?${queryParams.toString()}` : "";

      // Encode target to handle spaces safely in Markdown link syntax
      const encodedTarget = encodeURIComponent(trimmedTarget);
      return `[${displayText}](wikilink:${encodedTarget}${queryStr})`;
    }
  );
}
