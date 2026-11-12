import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * Markdown formatting commands shared by the desktop toolbar, the mobile toolbar and the
 * keyboard shortcuts. Every command is a toggle and leaves the cursor where typing continues
 * naturally: inside a freshly inserted pair, after a new line prefix, or on the same characters
 * it was on before the surrounding markers changed.
 */
export type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "heading"
  | "bullet"
  | "numbered"
  | "task"
  | "quote"
  | "wikilink"
  | "link";

const INLINE_MARKERS: Partial<Record<FormatKind, string>> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

type BlockKind = "heading" | "bullet" | "numbered" | "task" | "quote";

/** Leading whitespace, then an optional block marker (heading, quote, task, bullet or number). */
const BLOCK_PREFIX = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

function blockKindOf(marker: string): BlockKind | null {
  if (!marker) return null;
  if (marker.startsWith("#")) return "heading";
  if (marker.startsWith(">")) return "quote";
  if (/^\d/.test(marker)) return "numbered";
  if (marker.includes("[")) return "task";
  return "bullet";
}

function countRun(text: string, char: string, fromEnd: boolean): number {
  let n = 0;
  if (fromEnd) {
    for (let i = text.length - 1; i >= 0 && text[i] === char; i--) n++;
  } else {
    for (let i = 0; i < text.length && text[i] === char; i++) n++;
  }
  return n;
}

/**
 * Is [from, to) directly wrapped in `marker`? Asterisks need care because `*` (italic) and `**`
 * (bold) share a character: a run of 2 is bold only, 1 is italic only, 3 is both.
 */
function isWrapped(view: EditorView, from: number, to: number, marker: string): boolean {
  const doc = view.state.doc;
  if (marker === "*" || marker === "**") {
    const before = countRun(doc.sliceString(Math.max(0, from - 3), from), "*", true);
    const after = countRun(doc.sliceString(to, Math.min(doc.length, to + 3)), "*", false);
    const has = (n: number) => (marker === "**" ? n >= 2 : n % 2 === 1);
    return has(before) && has(after);
  }
  const len = marker.length;
  return (
    from >= len &&
    doc.sliceString(from - len, from) === marker &&
    doc.sliceString(to, to + len) === marker
  );
}

function toggleInline(view: EditorView, marker: string): void {
  const { state } = view;
  const len = marker.length;

  const tr = state.changeByRange((range): { changes: ChangeSpec; range: SelectionRange } => {
    let { from, to } = range;
    const wasEmpty = range.empty;

    if (wasEmpty) {
      // Cursor inside an empty pair (e.g. just pressed Bold, then Bold again): remove the pair.
      if (isWrapped(view, from, from, marker)) {
        return {
          changes: [
            { from: from - len, to: from },
            { from, to: from + len },
          ],
          range: EditorSelection.cursor(from - len),
        };
      }
      // Cursor in a word: format that word. Otherwise open a pair and wait for typing.
      const word = state.wordAt(from);
      if (word && word.from < word.to) {
        from = word.from;
        to = word.to;
      } else {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + len),
        };
      }
    }

    if (isWrapped(view, from, to, marker)) {
      return {
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        range: wasEmpty
          ? EditorSelection.cursor(range.head - len)
          : EditorSelection.range(from - len, to - len),
      };
    }

    // The selection includes the markers themselves, e.g. a double-clicked "**word**".
    const selected = state.sliceDoc(from, to);
    if (
      marker !== "*" &&
      selected.length > len * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker)
    ) {
      return {
        changes: [
          { from, to: from + len },
          { from: to - len, to },
        ],
        range: EditorSelection.range(from, to - len * 2),
      };
    }

    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: wasEmpty
        ? EditorSelection.cursor(range.head + len)
        : EditorSelection.range(from + len, to + len),
    };
  });

  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
}

function toggleBlock(view: EditorView, kind: BlockKind): void {
  const { state } = view;
  const doc = state.doc;

  const lineNumbers = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number;
    const last = doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) lineNumbers.add(n);
  }
  const all = [...lineNumbers].sort((a, b) => a - b).map((n) => doc.line(n));
  // With several lines selected, blank ones are left alone; a lone blank line still gets a prefix.
  const lines = all.length > 1 ? all.filter((l) => l.text.trim() !== "") : all;
  if (lines.length === 0) return;

  const parsed = lines.map((line) => {
    const m = BLOCK_PREFIX.exec(line.text)!;
    return { line, indent: m[1], marker: m[2] ?? "" };
  });
  const removing = parsed.every((p) => blockKindOf(p.marker) === kind);

  // Numbered lists continue from the item above when there is one.
  let counter = 1;
  if (kind === "numbered" && parsed[0].line.number > 1) {
    const prev = /^(\s*)(\d+)[.)]\s+/.exec(doc.line(parsed[0].line.number - 1).text);
    if (prev && prev[1] === parsed[0].indent) counter = Number(prev[2]) + 1;
  }

  const changes: ChangeSpec[] = parsed.map(({ line, indent, marker }) => {
    let insert = "";
    if (!removing) {
      if (kind === "heading") insert = "## ";
      else if (kind === "bullet") insert = "- ";
      else if (kind === "task") insert = "- [ ] ";
      else if (kind === "quote") insert = "> ";
      else insert = `${counter++}. `;
    }
    const from = line.from + indent.length;
    return { from, to: from + marker.length, insert };
  });

  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    // Bias forward so a cursor sitting at the start of the line ends up after the new prefix.
    selection: state.selection.map(changeSet, 1),
    scrollIntoView: true,
    userEvent: "input.format",
  });
}

function insertWikilink(view: EditorView): void {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    if (range.empty) {
      return { changes: { from: range.from, insert: "[[]]" }, range: EditorSelection.cursor(range.from + 2) };
    }
    return {
      changes: [
        { from: range.from, insert: "[[" },
        { from: range.to, insert: "]]" },
      ],
      range: EditorSelection.range(range.from + 2, range.to + 2),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
}

function insertLink(view: EditorView): void {
  const { state } = view;
  const url = "https://";
  const tr = state.changeByRange((range) => {
    if (range.empty) {
      // No text yet: put the cursor in the label.
      return {
        changes: { from: range.from, insert: `[](${url})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    // Text selected: it becomes the label, and the URL is selected ready to be typed over.
    const urlFrom = range.to + 3; // "[" before the label, "](" after it
    return {
      changes: [
        { from: range.from, insert: "[" },
        { from: range.to, insert: `](${url})` },
      ],
      range: EditorSelection.range(urlFrom, urlFrom + url.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
}

export function applyFormat(view: EditorView, kind: FormatKind): boolean {
  const marker = INLINE_MARKERS[kind];
  if (marker) toggleInline(view, marker);
  else if (kind === "wikilink") insertWikilink(view);
  else if (kind === "link") insertLink(view);
  else toggleBlock(view, kind as BlockKind);
  view.focus();
  return true;
}
