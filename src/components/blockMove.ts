/**
 * Pure block logic behind drag-to-reorder in the editor. No CodeMirror imports, so it can be
 * tested on its own (scripts/test-block-move.ts).
 *
 * A "block" is the unit that moves as one when you drag its handle. All indices are 0-based line
 * indices and ranges are inclusive:
 *  - a fenced code block (including its fences and any blank lines inside) is one block,
 *  - a list item (bullet, number or task) is one block together with everything indented under it,
 *  - a run of table rows is one block,
 *  - any other non-blank line is a block of its own,
 *  - blank lines are not blocks.
 */

export interface BlockRange {
  from: number;
  to: number;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s/;

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/** Indent width in columns; a tab counts as four. */
function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

/**
 * Fence ranges, found the same way the live preview styles them: any line starting with ``` (after
 * trimming) toggles a code block, and an unclosed fence runs to the end of the note.
 */
export function findFences(lines: readonly string[]): BlockRange[] {
  const fences: BlockRange[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("```")) continue;
    if (open < 0) {
      open = i;
    } else {
      fences.push({ from: open, to: i });
      open = -1;
    }
  }
  if (open >= 0) fences.push({ from: open, to: lines.length - 1 });
  return fences;
}

/** The block containing line `index`, or null for blank lines and out-of-range indices. */
export function findBlock(lines: readonly string[], index: number): BlockRange | null {
  if (index < 0 || index >= lines.length) return null;

  const fences = findFences(lines);
  const insideFence = fences.find((f) => index >= f.from && index <= f.to);
  if (insideFence) return insideFence;

  const text = lines[index];
  if (isBlank(text)) return null;

  const item = LIST_ITEM.exec(text);
  if (item) {
    const itemIndent = indentOf(text);
    let to = index;
    let j = index + 1;
    while (j < lines.length) {
      const nested = fences.find((f) => f.from === j);
      if (nested) {
        if (indentOf(lines[nested.from]) <= itemIndent) break;
        to = nested.to;
        j = nested.to + 1;
        continue;
      }
      if (isBlank(lines[j]) || indentOf(lines[j]) <= itemIndent) break;
      to = j;
      j++;
    }
    return { from: index, to };
  }

  if (text.trim().startsWith("|")) {
    let from = index;
    let to = index;
    while (from > 0 && lines[from - 1].trim().startsWith("|")) from--;
    while (to + 1 < lines.length && lines[to + 1].trim().startsWith("|")) to++;
    return { from, to };
  }

  return { from: index, to: index };
}

type LineKind = "blank" | "plain" | "list" | "quote" | "table" | "fence" | "other";

function kindOf(line: string): LineKind {
  const t = line.trim();
  if (t === "") return "blank";
  if (LIST_ITEM.test(line)) return "list";
  if (t.startsWith(">")) return "quote";
  if (t.startsWith("|")) return "table";
  if (t.startsWith("```")) return "fence";
  if (/^#{1,6}\s/.test(t) || /^(---|\*\*\*|___)$/.test(t)) return "other";
  return "plain";
}

/**
 * Whether `above` and `below`, about to sit on neighbouring lines, want a blank line between them
 * in a spaced-out note. Different kinds of block get one (this also stops a plain line being
 * swallowed as a lazy continuation of the list item, quote or table above it). Neighbours of the
 * same kind stay tight, so a list item dropped into a list does not split it, but two plain lines
 * or two fences would fuse or crowd each other, so those are separated.
 */
function needsGap(above: string | undefined, below: string | undefined): boolean {
  if (above === undefined || below === undefined) return false;
  const a = kindOf(above);
  const b = kindOf(below);
  if (a === "blank" || b === "blank") return false;
  if (a !== b) return true;
  return a === "plain" || a === "fence";
}

export interface MoveResult {
  lines: string[];
  /** Index, in the new lines, of the first line of the moved block. */
  movedStart: number;
}

/**
 * Moves `block` so that it sits before line `insertBefore` (0..lines.length; lines.length means
 * the end of the note). Returns null when the move would change nothing.
 *
 * Blank lines are kept tidy: closing the gap never leaves two blank lines in a row, and when the
 * block came from a spaced-out (blank-line separated) part of the note it is given blank lines
 * where it lands, so paragraphs don't fuse. Notes written with one line per row are left alone.
 */
export function moveBlock(
  lines: readonly string[],
  block: BlockRange,
  insertBefore: number
): MoveResult | null {
  if (insertBefore >= block.from && insertBefore <= block.to + 1) return null;
  if (insertBefore < 0 || insertBefore > lines.length) return null;

  const moved = lines.slice(block.from, block.to + 1);
  const spaced =
    (block.from > 0 && isBlank(lines[block.from - 1])) ||
    (block.to + 1 < lines.length && isBlank(lines[block.to + 1]));

  const rest = [...lines.slice(0, block.from), ...lines.slice(block.to + 1)];
  let at = insertBefore > block.to ? insertBefore - moved.length : insertBefore;

  // Close the gap: if the block sat between blank lines (or a blank line and an edge of the note),
  // drop one of them.
  const gap = block.from;
  const before = gap > 0 ? rest[gap - 1] : null;
  const after = gap < rest.length ? rest[gap] : null;
  const edgeOrBlank = (l: string | null) => l === null || l.trim() === "";
  if (edgeOrBlank(before) && edgeOrBlank(after)) {
    if (after !== null && after.trim() === "") {
      rest.splice(gap, 1);
      if (gap < at) at--;
    } else if (before !== null && before.trim() === "") {
      rest.splice(gap - 1, 1);
      if (gap - 1 < at) at--;
    }
  }

  const insertion = [...moved];
  let movedStart = at;
  if (spaced) {
    if (needsGap(rest[at - 1], moved[0])) {
      insertion.unshift("");
      movedStart++;
    }
    if (needsGap(moved[moved.length - 1], rest[at])) insertion.push("");
  }

  const result = [...rest.slice(0, at), ...insertion, ...rest.slice(at)];
  return { lines: result, movedStart };
}
