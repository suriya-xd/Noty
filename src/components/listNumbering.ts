/**
 * Keeps numbered lists numbered 1, 2, 3… when their lines are rearranged.
 *
 * A numbered list here is a run of `1.`-style items at the same indent with no blank line between
 * them (lines indented deeper, such as nested lists or wrapped text, belong to the item above and
 * don't break the run). A blank line ends the list: if the user splits a list in two with a
 * blank line, the part below starts again from 1.
 *
 * Only lists next to an edit that adds, removes or moves whole lines are renumbered: typing
 * within a line (e.g. writing `5. ` to start a list at 5) is never second-guessed, and opening a
 * note never rewrites it.
 *
 * `renumberLists` is pure, so it can be tested on its own (scripts/test-list-numbering.ts).
 */
import { EditorState, Transaction } from "@codemirror/state";
import type { ChangeSpec, Extension } from "@codemirror/state";
import { findFences } from "./blockMove";

const ORDERED_ITEM = /^(\s*)(\d{1,9})([.)])(?=\s|$)/;

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

interface Run {
  indent: number;
  delim: string;
  /** 0-based line indices of the run's items. */
  items: number[];
  /** The run comes right after a blank line that cut it off from a list above. */
  afterSplit: boolean;
}

export interface NumberEdit {
  /** 0-based line index. */
  line: number;
  /** Column range of the number (digits only) within the line. */
  from: number;
  to: number;
  insert: string;
}

/** Inclusive 0-based line range. */
export interface LineRange {
  from: number;
  to: number;
}

/**
 * The number changes that make every numbered list overlapping `touched` count up from its
 * start. A list starts at its smallest number (so moving item 3 to the top still gives 1, 2, 3,
 * and a list deliberately started at 5 keeps starting at 5), except the lower part of a list
 * split by a blank line, which starts again at 1.
 */
export function renumberLists(lines: readonly string[], touched: readonly LineRange[]): NumberEdit[] {
  if (touched.length === 0) return [];

  const inFence = new Uint8Array(lines.length);
  for (const f of findFences(lines)) for (let i = f.from; i <= f.to; i++) inFence[i] = 1;

  const runs: Run[] = [];
  let open: Run[] = []; // innermost last
  const close = (keep: (r: Run) => boolean) => {
    const kept: Run[] = [];
    for (const r of open) (keep(r) ? kept : runs).push(r);
    open = kept;
  };

  /** Whether a new run at `indent` starting at line `i` follows a list it was split from. */
  const followsSplitList = (i: number, indent: number): boolean => {
    let j = i - 1;
    if (j < 0 || lines[j].trim() !== "") return false;
    while (j >= 0 && lines[j].trim() === "") j--;
    while (j >= 0 && !inFence[j] && lines[j].trim() !== "" && indentOf(lines[j]) > indent) j--;
    if (j < 0 || inFence[j] || lines[j].trim() === "") return false;
    const m = ORDERED_ITEM.exec(lines[j]);
    return !!m && indentOf(lines[j]) === indent;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (text.trim() === "") {
      close(() => false);
      continue;
    }
    const indent = indentOf(text);
    const m = inFence[i] ? null : ORDERED_ITEM.exec(text);
    if (!m) {
      // Text at or left of a list's indent ends it; deeper text belongs to the item above.
      close((r) => r.indent < indent);
      continue;
    }
    close((r) => r.indent <= indent && !(r.indent === indent && r.delim !== m[3]));
    const top = open[open.length - 1];
    if (top && top.indent === indent) {
      top.items.push(i);
    } else {
      open.push({ indent, delim: m[3], items: [i], afterSplit: followsSplitList(i, indent) });
    }
  }
  close(() => false);

  const edits: NumberEdit[] = [];
  for (const run of runs) {
    const first = run.items[0];
    const last = run.items[run.items.length - 1];
    const hit = touched.some((t) => t.from <= last + 1 && t.to >= first - 1);
    if (!hit) continue;

    const numbers = run.items.map((i) => parseInt(ORDERED_ITEM.exec(lines[i])![2], 10));
    const start = run.afterSplit ? 1 : Math.min(...numbers);
    run.items.forEach((lineIndex, k) => {
      const want = String(start + k);
      const m = ORDERED_ITEM.exec(lines[lineIndex])!;
      if (m[2] === want) return;
      const from = m[1].length;
      edits.push({ line: lineIndex, from, to: from + m[2].length, insert: want });
    });
  }
  return edits.sort((a, b) => a.line - b.line);
}

/** Edits from the user that can rearrange lines. Undo/redo and programmatic loads are left alone. */
function rearrangesLines(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  if (!(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return false;
  let multiline = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (multiline) return;
    if (inserted.lines > 1 || tr.startState.doc.sliceString(fromA, toA).includes("\n")) multiline = true;
  });
  return multiline;
}

/**
 * Renumbers the numbered lists around an edit that added, removed or moved lines, as part of the
 * same transaction (so one undo reverts both the edit and the renumbering).
 */
export const orderedListRenumbering: Extension = EditorState.transactionFilter.of((tr) => {
  if (!rearrangesLines(tr)) return tr;

  const doc = tr.newDoc;
  const touched: LineRange[] = [];
  tr.changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
    touched.push({ from: doc.lineAt(fromB).number - 1, to: doc.lineAt(toB).number - 1 });
  });

  const lines = doc.toString().split("\n");
  const edits = renumberLists(lines, touched);
  if (edits.length === 0) return tr;

  const changes: ChangeSpec[] = edits.map((e) => {
    const line = doc.line(e.line + 1);
    return { from: line.from + e.from, to: line.from + e.to, insert: e.insert };
  });
  return [tr, { changes, sequential: true }];
});
