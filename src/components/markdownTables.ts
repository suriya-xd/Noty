import { Annotation, EditorSelection, RangeSetBuilder, StateField } from "@codemirror/state";
import type { ChangeSpec, EditorState, Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, runScopeHandlers } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import type { DecorationSet } from "@codemirror/view";

/**
 * GitHub-style Markdown tables in the editor. A table is always shown as a real table, and is
 * edited in place: every cell is a small text box that shows its Markdown while it has the focus.
 * A toolbar above the table adds and removes rows and columns, changes a column's alignment and
 * deletes the table. Each edit is written straight back to the note's Markdown, so undo, saving
 * and sync all work as for any other typing.
 *
 * Tables span several lines, and CodeMirror only lets a state field (not a view plugin) replace
 * line breaks, so this lives in its own field instead of the live preview plugin.
 */

export type CellAlign = "left" | "center" | "right" | null;

export interface TableCell {
  /** Cell text with surrounding spaces trimmed and `\|` unescaped. */
  text: string;
  /** Document offset where the cell's (trimmed) text starts. */
  from: number;
  /** Document offset where the cell's (trimmed) text ends. */
  to: number;
}

export interface MarkdownTable {
  /** Document offsets of the whole table, first row start to last row end. */
  from: number;
  to: number;
  /** 1-based line numbers. */
  fromLine: number;
  toLine: number;
  align: CellAlign[];
  header: TableCell[];
  rows: TableCell[][];
  /** Column widths and row heights the user set, from the comment line above the table. */
  size: TableSize | null;
}

/**
 * Sizes set by dragging a table's edges, in pixels; null is "automatic". Markdown has no syntax
 * for this, so it is kept in an HTML comment on the line above the table, which other Markdown
 * viewers don't show:  <!-- table: widths=140,220,auto; heights=auto,64 -->
 * `heights` starts with the header row.
 */
export interface TableSize {
  widths: (number | null)[];
  heights: (number | null)[];
}

const SIZE_COMMENT = /^\s{0,3}<!--\s*table:(.*?)-->\s*$/;

export function parseSizeComment(text: string): TableSize | null {
  const m = SIZE_COMMENT.exec(text);
  if (!m) return null;
  const size: TableSize = { widths: [], heights: [] };
  for (const part of m[1].split(/[;\s]+/)) {
    const [key, value] = part.split("=");
    if ((key !== "widths" && key !== "heights") || value === undefined) continue;
    size[key] = value.split(",").map((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    });
  }
  return size;
}

/** The comment line for `size`, or null when every size is automatic. */
export function sizeComment(size: Partial<TableSize> | null | undefined): string | null {
  const list = (values: (number | null)[] | undefined) => {
    const v = [...(values ?? [])];
    while (v.length && v[v.length - 1] == null) v.pop();
    return v.length ? v.map((n) => (n == null ? "auto" : String(Math.round(n)))).join(",") : null;
  };
  const parts: string[] = [];
  const w = list(size?.widths);
  const h = list(size?.heights);
  if (w) parts.push(`widths=${w}`);
  if (h) parts.push(`heights=${h}`);
  return parts.length ? `<!-- table: ${parts.join("; ")} -->` : null;
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Splits a table row into cells, honouring `\|` and pipes inside `code`. */
export function splitRow(text: string, lineFrom: number): TableCell[] {
  const cells: TableCell[] = [];
  let start = 0;
  let i = 0;
  // Leading pipe (after indentation) is not a cell boundary.
  const lead = /^\s*\|/.exec(text);
  if (lead) start = i = lead[0].length;
  let inCode = false;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const leftPad = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const from = lineFrom + start + leftPad;
    cells.push({ text: trimmed.replace(/\\\|/g, "|"), from, to: from + trimmed.length });
  };
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    else if (ch === "|" && !inCode) {
      push(i);
      start = i + 1;
    }
  }
  // Trailing text after the last pipe is a cell unless it's empty (a closing pipe).
  if (text.slice(start).trim() !== "" || cells.length === 0) push(text.length);
  return cells;
}

function isDelimiterRow(text: string): CellAlign[] | null {
  if (!text.includes("-")) return null;
  const cells = splitRow(text, 0);
  if (cells.length === 0 || !cells.every((c) => DELIMITER_CELL.test(c.text))) return null;
  // A lone "---" with no pipe is a horizontal rule / setext heading, not a table.
  if (!text.includes("|")) return null;
  return cells.map((c) => {
    const l = c.text.startsWith(":");
    const r = c.text.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
}

function isRowCandidate(text: string): boolean {
  return text.includes("|") && text.trim() !== "" && !/^\s{4,}/.test(text);
}

/**
 * Finds every table in the document (skipping fenced code blocks). `skipLine` (1-based) is never
 * part of a table: it is the line being typed as plain Markdown, which shouldn't vanish into the
 * table before it's finished.
 */
export function findTables(doc: Text, skipLine = -1): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let inFence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (FENCE.test(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || n === doc.lines || n === skipLine || n + 1 === skipLine || !isRowCandidate(line.text)) continue;
    const delim = doc.line(n + 1);
    const align = isDelimiterRow(delim.text);
    if (!align) continue;
    const header = splitRow(line.text, line.from);
    if (header.length !== align.length) continue;

    const rows: TableCell[][] = [];
    let last = n + 1;
    while (last < doc.lines) {
      const next = doc.line(last + 1);
      if (last + 1 === skipLine || !isRowCandidate(next.text) || FENCE.test(next.text)) break;
      rows.push(splitRow(next.text, next.from));
      last++;
    }
    // A size comment directly above belongs to the table (and is hidden with it).
    const above = n > 1 && n - 1 !== skipLine ? doc.line(n - 1) : null;
    const size = above ? parseSizeComment(above.text) : null;
    tables.push({
      from: size ? above!.from : line.from,
      to: doc.line(last).to,
      fromLine: size ? n - 1 : n,
      toLine: last,
      align,
      header,
      rows,
      size,
    });
    n = last;
  }
  return tables;
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** Appends `text`'s inline Markdown (code, bold, italic, strike, links, wikilinks, <br>) to `parent`. */
export function renderInline(text: string, parent: HTMLElement): void {
  const re =
    /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|(?<![*\w])\*([^*\s][^*]*?)\*(?!\*)|(?<![_\w])_([^_\s][^_]*?)_(?![_\w])|!?\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<br\s*\/?>|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const textNode = (s: string) => parent.appendChild(document.createTextNode(s.replace(/\\([\\`*_~[\]|])/g, "$1")));
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) textNode(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const code = document.createElement("code");
      code.className = "cm-md-table-code";
      code.textContent = m[2].trim() || m[2];
      parent.appendChild(code);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const b = document.createElement("strong");
      renderInline(m[3] ?? m[4], b);
      parent.appendChild(b);
    } else if (m[5] !== undefined) {
      const s = document.createElement("s");
      renderInline(m[5], s);
      parent.appendChild(s);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const em = document.createElement("em");
      renderInline(m[6] ?? m[7], em);
      parent.appendChild(em);
    } else if (m[8] !== undefined) {
      const target = m[8].trim();
      const a = document.createElement("span");
      a.className = "cm-md-wikilink";
      a.dataset.wikilinkTarget = target;
      a.textContent = (m[9] ?? target).trim();
      parent.appendChild(a);
    } else if (m[10] !== undefined) {
      const a = document.createElement("span");
      a.className = "cm-md-link";
      a.dataset.href = m[11];
      a.title = m[11];
      renderInline(m[10], a);
      parent.appendChild(a);
    } else if (m[12] !== undefined) {
      const a = document.createElement("span");
      a.className = "cm-md-link";
      a.dataset.href = m[12];
      a.title = m[12];
      a.textContent = m[12];
      parent.appendChild(a);
    } else {
      parent.appendChild(document.createElement("br"));
    }
  }
  if (last < text.length) textNode(text.slice(last));
}

// ---------------------------------------------------------------------------------------------
// Editing model: a table as plain strings, and the operations the toolbar offers

export interface TableModel {
  align: CellAlign[];
  header: string[];
  rows: string[][];
  /** Column widths in pixels (null: automatic); absent when no column has been sized. */
  widths?: (number | null)[];
  /** Row heights in pixels, header row first (null: automatic); absent when none is set. */
  heights?: (number | null)[];
}

/** Width given to a new column of a table whose columns have been sized. */
export const DEFAULT_COL_WIDTH = 140;

/** The table's cells as text, every row padded (or cut) to the header's width, as GFM shows it. */
export function tableModel(t: MarkdownTable): TableModel {
  const cols = t.align.length;
  const fit = (cells: TableCell[]) => Array.from({ length: cols }, (_, c) => cells[c]?.text ?? "");
  const m: TableModel = { align: [...t.align], header: fit(t.header), rows: t.rows.map(fit) };
  const sized = (list: (number | null)[] | undefined, n: number) =>
    list?.some((v) => v != null) ? Array.from({ length: n }, (_, i) => list[i] ?? null) : undefined;
  const widths = sized(t.size?.widths, cols);
  const heights = sized(t.size?.heights, t.rows.length + 1);
  if (widths) m.widths = widths;
  if (heights) m.heights = heights;
  return m;
}

/** Escapes a cell's text for a table row: `|` becomes `\|`, and a trailing `\` can't eat the pipe. */
export function escapeCell(text: string): string {
  let s = text.replace(/[\r\n]+/g, " ").replace(/ /g, " ").replace(/(?<!\\)\|/g, "\\|");
  if (/(?<!\\)(\\\\)*\\$/.test(s)) s += " ";
  return s;
}

const DELIMITERS: Record<string, (w: number) => string> = {
  left: (w) => ":" + "-".repeat(w - 1),
  center: (w) => ":" + "-".repeat(w - 2) + ":",
  right: (w) => "-".repeat(w - 1) + ":",
  none: (w) => "-".repeat(w),
};

/** Writes a table as Markdown with its columns padded so they line up in plain text too. */
export function serializeTable(m: TableModel): string {
  const header = m.header.map(escapeCell);
  const rows = m.rows.map((r) => r.map(escapeCell));
  const widths = header.map((h, c) => Math.max(3, h.length, ...rows.map((r) => r[c].length)));
  const line = (cells: string[]) => "| " + cells.map((s, c) => s.padEnd(widths[c])).join(" | ") + " |";
  const delim = "| " + widths.map((w, c) => DELIMITERS[m.align[c] ?? "none"](w)).join(" | ") + " |";
  const comment = sizeComment(m);
  return [...(comment ? [comment] : []), line(header), delim, ...rows.map(line)].join("\n");
}

export function insertRow(m: TableModel, at: number): TableModel {
  const rows = [...m.rows];
  rows.splice(at, 0, m.header.map(() => ""));
  // heights[0] is the header row, so body row `at` is heights[at + 1].
  const heights = m.heights && [...m.heights.slice(0, at + 1), null, ...m.heights.slice(at + 1)];
  return { ...m, rows, ...(heights && { heights }) };
}

export function deleteRow(m: TableModel, at: number): TableModel {
  const heights = m.heights?.filter((_, i) => i !== at + 1);
  return { ...m, rows: m.rows.filter((_, i) => i !== at), ...(heights && { heights }) };
}

export function insertColumn(m: TableModel, at: number): TableModel {
  const add = <T,>(list: T[], v: T) => [...list.slice(0, at), v, ...list.slice(at)];
  return {
    ...m,
    align: add(m.align, null),
    header: add(m.header, ""),
    rows: m.rows.map((r) => add(r, "")),
    ...(m.widths && { widths: add(m.widths, DEFAULT_COL_WIDTH) }),
  };
}

export function deleteColumn(m: TableModel, at: number): TableModel {
  const drop = <T,>(list: T[]) => list.filter((_, i) => i !== at);
  return {
    ...m,
    align: drop(m.align),
    header: drop(m.header),
    rows: m.rows.map(drop),
    ...(m.widths && { widths: drop(m.widths) }),
  };
}

export function setAlign(m: TableModel, col: number, align: CellAlign): TableModel {
  return { ...m, align: m.align.map((a, i) => (i === col ? align : a)) };
}

/** A new, empty table: numbered column headings and blank rows. */
export function blankTable(cols = 3, rows = 2): TableModel {
  const header = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  return { align: header.map(() => null), header, rows: Array.from({ length: rows }, () => header.map(() => "")) };
}

// ---------------------------------------------------------------------------------------------
// Widget

/** Marks transactions made by the table widget itself. */
const fromTable = Annotation.define<boolean>();

/** Row index of the header row; body rows count from 0. */
const HEADER = -1;

interface CellRef {
  row: number;
  col: number;
}

/** Which cell of a table (by its DOM block) has, or last had, the focus. */
const activeCells = new WeakMap<HTMLElement, CellRef>();

const ALIGN_ORDER: CellAlign[] = [null, "left", "center", "right"];
const ALIGN_LABEL: Record<string, string> = { none: "Auto", left: "Left", center: "Center", right: "Right" };

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  minus: '<path d="M5 12h14"/>',
  align: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
  resize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  table: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
};

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

type Action =
  | "row-above"
  | "row-below"
  | "del-row"
  | "col-left"
  | "col-right"
  | "del-col"
  | "align"
  | "reset-size"
  | "del-table"
  | "add-row-end"
  | "add-col-end";

const TOOLBAR: ({ action: Action; label: string; title: string; icon?: keyof typeof ICONS; danger?: boolean } | { group: string })[] = [
  { group: "Row" },
  { action: "row-above", label: "Above", title: "Insert a row above", icon: "plus" },
  { action: "row-below", label: "Below", title: "Insert a row below", icon: "plus" },
  { action: "del-row", label: "Delete", title: "Delete this row", icon: "minus", danger: true },
  { group: "Column" },
  { action: "col-left", label: "Left", title: "Insert a column to the left", icon: "plus" },
  { action: "col-right", label: "Right", title: "Insert a column to the right", icon: "plus" },
  { action: "del-col", label: "Delete", title: "Delete this column", icon: "minus", danger: true },
  { group: "" },
  { action: "align", label: "Auto", title: "Change this column's alignment", icon: "align" },
  { action: "reset-size", label: "Reset size", title: "Set every column width and row height back to automatic", icon: "resize" },
  { action: "del-table", label: "Table", title: "Delete the whole table", icon: "trash", danger: true },
];

/** Finds the table a widget's DOM block shows, in the current state. */
function tableOf(view: EditorView, block: HTMLElement): MarkdownTable | null {
  let pos: number;
  try {
    pos = view.posAtDOM(block);
  } catch {
    return null;
  }
  return view.state.field(tableField, false)?.tables.find((t) => t.from === pos) ?? null;
}

function blockAt(view: EditorView, tableFrom: number): HTMLElement | null {
  for (const el of view.dom.querySelectorAll<HTMLElement>(".cm-md-table-block")) {
    try {
      if (view.posAtDOM(el) === tableFrom) return el;
    } catch {
      /* not in the document any more */
    }
  }
  return null;
}

function cellEl(block: HTMLElement, ref: CellRef): HTMLElement | null {
  return block.querySelector<HTMLElement>(`[data-row="${ref.row}"][data-col="${ref.col}"]`);
}

function cellRefOf(el: HTMLElement): CellRef {
  return { row: Number(el.dataset.row), col: Number(el.dataset.col) };
}

function cellText(t: MarkdownTable, ref: CellRef): string {
  const cells = ref.row === HEADER ? t.header : t.rows[ref.row];
  return cells?.[ref.col]?.text ?? "";
}

/** What a cell box holds, as it would be written back (spaces trimmed, line breaks flattened). */
function boxText(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/ /g, " ").replace(/[\r\n]+/g, " ");
}

/** Puts the caret in a cell box: at a character offset, at the end, or selecting all of it. */
function placeCaret(el: HTMLElement, where: "end" | "all" | number) {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  const range = el.ownerDocument.createRange();
  const text = el.firstChild;
  if (where === "all" || !text) {
    range.selectNodeContents(el);
    if (where !== "all") range.collapse(false);
  } else {
    const len = text.textContent?.length ?? 0;
    const at = where === "end" ? len : Math.min(where, len);
    range.setStart(text, at);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The caret's character offset inside a cell box, or null when the selection is elsewhere. */
function caretOffset(el: HTMLElement): number | null {
  const sel = el.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.focusNode!, sel.focusOffset);
  return range.toString().length;
}

/** Moves the focus into a cell of the table starting at `tableFrom`. */
export function focusTableCell(view: EditorView, tableFrom: number, ref: CellRef, caret: "end" | "all" | number = "end"): boolean {
  const block = blockAt(view, tableFrom);
  const el = block && cellEl(block, ref);
  if (!el) return false;
  el.focus({ preventScroll: true });
  placeCaret(el, caret);
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/** Replaces the whole table with `model`, then puts the focus in `focus` (if given). */
function rewrite(view: EditorView, t: MarkdownTable, model: TableModel, focus: CellRef | null, caret: "end" | "all" = "end") {
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: serializeTable(model) },
    annotations: [fromTable.of(true), isolateHistory.of("full")],
    userEvent: "input.table",
  });
  if (focus) focusTableCell(view, t.from, focus, caret);
}

function removeTable(view: EditorView, t: MarkdownTable) {
  const doc = view.state.doc;
  // Take one line break with it, so no empty line is left where the table was.
  const to = t.to < doc.length ? t.to + 1 : t.to;
  const from = to === t.to && t.from > 0 ? t.from - 1 : t.from;
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    annotations: [fromTable.of(true), isolateHistory.of("full")],
    userEvent: "delete.table",
  });
  view.focus();
}

/** Leaves the table for the line above or below it (adding a line when there is none). */
function leaveTable(view: EditorView, t: MarkdownTable, dir: "before" | "after") {
  const doc = view.state.doc;
  if (dir === "before") {
    if (t.from > 0) view.dispatch({ selection: { anchor: t.from - 1 }, annotations: fromTable.of(true), scrollIntoView: true });
    else view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, annotations: fromTable.of(true), scrollIntoView: true });
  } else if (t.to < doc.length) {
    view.dispatch({ selection: { anchor: t.to + 1 }, annotations: fromTable.of(true), scrollIntoView: true });
  } else {
    view.dispatch({
      changes: { from: t.to, insert: "\n" },
      selection: { anchor: t.to + 1 },
      annotations: fromTable.of(true),
      scrollIntoView: true,
    });
  }
  view.focus();
}

/** Writes the text of the focused cell box back to the document. */
function commitCell(view: EditorView, block: HTMLElement, el: HTMLElement) {
  const t = tableOf(view, block);
  if (!t) return;
  const ref = cellRefOf(el);
  const text = boxText(el);
  if (text.trim() === cellText(t, ref)) return;
  const cell = ref.row === HEADER ? t.header[ref.col] : t.rows[ref.row]?.[ref.col];
  const caret = caretOffset(el);
  if (cell) {
    let { from, to } = cell;
    let insert = escapeCell(text);
    if (from === to) {
      // An empty cell: write " text " between its pipes rather than squeezing it against one.
      const line = view.state.doc.lineAt(from);
      const pipe = line.text.lastIndexOf("|", from - line.from - 1);
      from = pipe < 0 ? line.from : line.from + pipe + 1;
      insert = ` ${insert} `;
    }
    view.dispatch({
      changes: { from, to, insert },
      annotations: fromTable.of(true),
      userEvent: "input.type",
    });
  } else {
    // The row is shorter than the header; write the whole table out with this cell filled in.
    const m = tableModel(t);
    if (ref.row === HEADER) m.header[ref.col] = text;
    else m.rows[ref.row][ref.col] = text;
    rewrite(view, t, m, null);
  }
  // Normally the box is kept as it is; if the table had to be redrawn, find the new one.
  if (!el.isConnected) focusTableCell(view, t.from, ref, caret ?? "end");
}

function runAction(view: EditorView, block: HTMLElement, action: Action) {
  const t = tableOf(view, block);
  if (!t) return;
  const m = tableModel(t);
  const cols = m.header.length;
  const active = activeCells.get(block) ?? null;
  const row = active?.row ?? null;
  const col = active?.col ?? null;
  switch (action) {
    case "row-above": {
      const at = row === null || row === HEADER ? 0 : row;
      return rewrite(view, t, insertRow(m, at), { row: at, col: col ?? 0 });
    }
    case "row-below":
    case "add-row-end": {
      const at = action === "add-row-end" || row === null ? m.rows.length : row + 1;
      return rewrite(view, t, insertRow(m, at), { row: at, col: action === "add-row-end" ? 0 : col ?? 0 });
    }
    case "del-row": {
      if (row === null || row === HEADER) return;
      const next = m.rows.length > 1 ? { row: Math.min(row, m.rows.length - 2), col: col ?? 0 } : { row: HEADER, col: col ?? 0 };
      return rewrite(view, t, deleteRow(m, row), next);
    }
    case "col-left": {
      const at = col ?? 0;
      return rewrite(view, t, insertColumn(m, at), { row: row ?? HEADER, col: at });
    }
    case "col-right":
    case "add-col-end": {
      const at = action === "add-col-end" || col === null ? cols : col + 1;
      return rewrite(view, t, insertColumn(m, at), { row: action === "add-col-end" ? HEADER : row ?? HEADER, col: at });
    }
    case "del-col": {
      if (col === null) return;
      if (cols <= 1) return removeTable(view, t);
      return rewrite(view, t, deleteColumn(m, col), { row: row ?? HEADER, col: Math.min(col, cols - 2) });
    }
    case "align": {
      if (col === null) return;
      const next = ALIGN_ORDER[(ALIGN_ORDER.indexOf(m.align[col]) + 1) % ALIGN_ORDER.length];
      return rewrite(view, t, setAlign(m, col, next), active);
    }
    case "reset-size":
      return rewrite(view, t, { ...m, widths: undefined, heights: undefined }, active);
    case "del-table":
      return removeTable(view, t);
  }
}

/**
 * Moves to another cell. Going past the last row adds a row (`pastEnd: "add"`, for Enter and
 * Tab), leaves the table (`"leave"`, for the arrow keys) or does nothing (`"stay"`).
 */
function moveFrom(view: EditorView, block: HTMLElement, from: CellRef, dRow: number, dCol: number, pastEnd: "add" | "leave" | "stay") {
  const t = tableOf(view, block);
  if (!t) return;
  const cols = t.align.length;
  const rows = t.rows.length;
  let { row, col } = from;
  if (dCol) {
    col += dCol;
    if (col >= cols) {
      col = 0;
      row++;
    } else if (col < 0) {
      if (row === HEADER) return;
      col = cols - 1;
      row--;
    }
  } else row += dRow;
  if (row < HEADER) return pastEnd === "leave" ? leaveTable(view, t, "before") : undefined;
  if (row >= rows) {
    if (pastEnd === "leave") return leaveTable(view, t, "after");
    if (pastEnd === "add") return rewrite(view, t, insertRow(tableModel(t), rows), { row: rows, col });
    return;
  }
  focusTableCell(view, t.from, { row, col }, dCol ? (dCol > 0 ? 0 : "end") : "end");
}

function updateToolbar(block: HTMLElement, t: MarkdownTable | null) {
  const active = activeCells.get(block) ?? null;
  const set = (action: Action, disabled: boolean, label?: string) => {
    const btn = block.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!btn) return;
    btn.disabled = disabled;
    if (label !== undefined) {
      const span = btn.querySelector("span");
      if (span) span.textContent = label;
    }
  };
  set("del-row", !active || active.row === HEADER);
  set("del-col", !active);
  set("align", !active, ALIGN_LABEL[(active && t?.align[active.col]) || "none"]);
  set("reset-size", !t?.size);
  block.classList.toggle("cm-md-table-active", !!active);
}

// ---------------------------------------------------------------------------------------------
// Resizing: drag a column's right edge or a row's bottom edge

const MIN_COL_WIDTH = 48;
const MAX_FIT_WIDTH = 480;
const MIN_ROW_HEIGHT = 28;

function rowEls(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...(table.tHead?.rows ?? []), ...(table.tBodies[0]?.rows ?? [])];
}

/**
 * Shows a table at the given sizes. Once any column has a width, every column gets one and the
 * table is exactly as wide as its columns (wider than the note scrolls sideways). Row heights are
 * minimums: a row still grows to fit its text.
 */
function applySize(block: HTMLElement, widths: (number | null)[] | undefined, heights: (number | null)[] | undefined) {
  const table = block.querySelector("table")!;
  const sized = !!widths?.some((w) => w != null);
  let cg = table.querySelector("colgroup");
  if (sized) {
    if (!cg) cg = table.insertBefore(document.createElement("colgroup"), table.firstChild);
    while (cg.children.length > widths!.length) cg.lastElementChild!.remove();
    while (cg.children.length < widths!.length) cg.appendChild(document.createElement("col"));
    let total = 0;
    widths!.forEach((w, i) => {
      const px = w ?? DEFAULT_COL_WIDTH;
      total += px;
      (cg!.children[i] as HTMLElement).style.width = `${px}px`;
    });
    table.style.tableLayout = "fixed";
    table.style.width = `${total}px`;
  } else {
    cg?.remove();
    table.style.tableLayout = "";
    table.style.width = "";
  }
  block.classList.toggle("cm-md-table-sized", sized);
  rowEls(table).forEach((tr, i) => {
    const h = heights?.[i];
    tr.style.height = h ? `${h}px` : "";
  });
}

/** Puts a drag handle on every column's right edge and every row's bottom edge. */
function layoutHandles(block: HTMLElement) {
  const table = block.querySelector("table");
  const layer = block.querySelector<HTMLElement>(".cm-md-table-handles");
  if (!table || !layer || !table.isConnected) return;
  const head = table.tHead?.rows[0];
  if (!head) return;
  const rows = rowEls(table);
  const cols = head.cells.length;
  if (layer.dataset.shape !== `${cols}x${rows.length}`) {
    layer.replaceChildren();
    const add = (kind: "col" | "row", index: number) => {
      const h = document.createElement("div");
      h.className = `cm-md-table-handle cm-md-table-handle-${kind}`;
      h.dataset.resize = kind;
      h.dataset.index = String(index);
      h.title =
        kind === "col"
          ? "Drag to change the column's width · double-click to fit its contents"
          : "Drag to change the row's height · double-click to reset it";
      layer.appendChild(h);
    };
    for (let c = 0; c < cols; c++) add("col", c);
    for (let r = 0; r < rows.length; r++) add("row", r);
    // The outer edges' handles sit just inside the table; their line is drawn on the edge.
    (layer.children[cols - 1] as HTMLElement | undefined)?.classList.add("cm-md-table-handle-last");
    (layer.lastElementChild as HTMLElement | null)?.classList.add("cm-md-table-handle-last");
    layer.dataset.shape = `${cols}x${rows.length}`;
  }
  const box = table.getBoundingClientRect();
  const handles = layer.children;
  for (let c = 0; c < cols; c++) {
    const h = handles[c] as HTMLElement;
    const w = h.offsetWidth;
    h.style.left = `${head.cells[c].getBoundingClientRect().right - box.left - (c === cols - 1 ? w : w / 2)}px`;
    h.style.height = `${box.height}px`;
  }
  rows.forEach((tr, r) => {
    const h = handles[cols + r] as HTMLElement;
    const hh = h.offsetHeight;
    h.style.top = `${tr.getBoundingClientRect().bottom - box.top - (r === rows.length - 1 ? hh : hh / 2)}px`;
    h.style.width = `${box.width}px`;
  });
  const addRow = block.querySelector<HTMLElement>(".cm-md-table-add-row");
  const wrap = block.querySelector<HTMLElement>(".cm-md-table-wrap");
  if (addRow && wrap) addRow.style.width = block.classList.contains("cm-md-table-sized") ? `${wrap.offsetWidth}px` : "";
}

/** The width column `col` needs to show every cell on one line (capped, so long text wraps). */
function fitWidth(block: HTMLElement, col: number): number {
  const table = block.querySelector("table")!;
  let widest = 0;
  let pad = 26;
  for (const tr of rowEls(table)) {
    const cell = tr.cells[col];
    if (!cell) continue;
    const cs = getComputedStyle(cell);
    pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-10000px;top:0";
    probe.style.font = cs.font;
    probe.innerHTML = cell.innerHTML;
    block.appendChild(probe);
    widest = Math.max(widest, probe.getBoundingClientRect().width);
    probe.remove();
  }
  return Math.min(MAX_FIT_WIDTH, Math.max(MIN_COL_WIDTH, Math.ceil(widest + pad)));
}

/** Current on-screen width of every column, used to fix them all once one is sized. */
function measuredWidths(block: HTMLElement): number[] {
  const head = block.querySelector("table")!.tHead!.rows[0];
  return [...head.cells].map((c) => Math.round(c.getBoundingClientRect().width));
}

function listenForResize(view: EditorView, block: HTMLElement) {
  const layer = block.querySelector<HTMLElement>(".cm-md-table-handles")!;

  layer.addEventListener("pointerdown", (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-resize]");
    const t = handle && tableOf(view, block);
    if (!handle || !t || e.button !== 0) return;
    // Keep the focus (and a phone's keyboard) where it is, and the canvas from dragging the card.
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);

    const kind = handle.dataset.resize as "col" | "row";
    const index = Number(handle.dataset.index);
    const m = tableModel(t);
    const table = block.querySelector("table")!;
    const startWidths = m.widths?.map((w) => w ?? DEFAULT_COL_WIDTH) ?? measuredWidths(block);
    const startHeight = rowEls(table)[index]?.getBoundingClientRect().height ?? MIN_ROW_HEIGHT;
    const start = kind === "col" ? e.clientX : e.clientY;
    let widths = m.widths;
    let heights = m.heights;
    let moved = false;
    block.classList.add("cm-md-table-resizing");
    handle.classList.add("cm-md-table-handle-dragging");

    const move = (ev: PointerEvent) => {
      const d = (kind === "col" ? ev.clientX : ev.clientY) - start;
      if (!moved && Math.abs(d) < 3) return;
      moved = true;
      if (kind === "col") {
        widths = startWidths.map((w, i) => (i === index ? Math.max(MIN_COL_WIDTH, Math.round(w + d)) : w));
      } else {
        heights = Array.from({ length: m.rows.length + 1 }, (_, i) => m.heights?.[i] ?? null);
        heights[index] = Math.max(MIN_ROW_HEIGHT, Math.round(startHeight + d));
      }
      applySize(block, widths, heights);
      layoutHandles(block);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      block.classList.remove("cm-md-table-resizing");
      handle.classList.remove("cm-md-table-handle-dragging");
      const now = tableOf(view, block);
      if (!moved || !now) return;
      rewrite(view, now, { ...tableModel(now), widths, heights }, null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });

  layer.addEventListener("dblclick", (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-resize]");
    const t = handle && tableOf(view, block);
    if (!handle || !t) return;
    e.preventDefault();
    const index = Number(handle.dataset.index);
    const m = tableModel(t);
    if (handle.dataset.resize === "col") {
      const widths = m.widths?.map((w) => w ?? DEFAULT_COL_WIDTH) ?? measuredWidths(block);
      widths[index] = fitWidth(block, index);
      rewrite(view, t, { ...m, widths }, null);
    } else if (m.heights) {
      const heights = m.heights.map((h, i) => (i === index ? null : h));
      rewrite(view, t, { ...m, heights: heights.some((h) => h != null) ? heights : undefined }, null);
    }
  });
}

const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

class TableWidget extends WidgetType {
  /** Cheap identity for `eq`: the table's source and position. */
  private readonly key: string;

  constructor(readonly table: MarkdownTable, source: string) {
    super();
    this.key = `${table.from}\n${source}`;
  }

  eq(other: TableWidget) {
    return other.key === this.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-md-table-block";
    block.contentEditable = "false";

    const toolbar = document.createElement("div");
    toolbar.className = "cm-md-table-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Table");
    toolbar.innerHTML = `<span class="cm-md-table-toolbar-icon">${icon("table")}</span>`;
    // Each label stays on one line with its buttons when the toolbar wraps.
    let set: HTMLElement = toolbar;
    for (const item of TOOLBAR) {
      if ("group" in item) {
        set = document.createElement("span");
        set.className = "cm-md-table-toolbar-set";
        const g = document.createElement("span");
        g.className = "cm-md-table-toolbar-group";
        g.textContent = item.group;
        set.appendChild(g);
        toolbar.appendChild(set);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.action = item.action;
      btn.title = item.title;
      btn.setAttribute("aria-label", item.title);
      btn.className = "cm-md-table-btn" + (item.danger ? " cm-md-table-btn-danger" : "");
      btn.innerHTML = (item.icon ? icon(item.icon) : "") + (item.label ? `<span>${item.label}</span>` : "");
      set.appendChild(btn);
    }

    const body = document.createElement("div");
    body.className = "cm-md-table-body";
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const handles = document.createElement("div");
    handles.className = "cm-md-table-handles";
    handles.dataset.canvasUi = "";
    wrap.append(table, handles);
    const addCol = document.createElement("button");
    addCol.type = "button";
    addCol.className = "cm-md-table-add cm-md-table-add-col";
    addCol.dataset.action = "add-col-end";
    addCol.title = "Add a column";
    addCol.setAttribute("aria-label", "Add a column");
    addCol.innerHTML = icon("plus");
    body.append(wrap, addCol);

    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "cm-md-table-add cm-md-table-add-row";
    addRow.dataset.action = "add-row-end";
    addRow.title = "Add a row";
    addRow.setAttribute("aria-label", "Add a row");
    addRow.innerHTML = icon("plus");

    block.append(toolbar, body, addRow);
    this.listen(view, block);
    listenForResize(view, block);
    this.sync(block);
    updateToolbar(block, this.table);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => layoutHandles(block));
      observer.observe(table);
      resizeObservers.set(block, observer);
    }
    return block;
  }

  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (!dom.classList.contains("cm-md-table-block")) return false;
    this.sync(dom);
    updateToolbar(dom, this.table);
    return true;
  }

  destroy(dom: HTMLElement) {
    resizeObservers.get(dom)?.disconnect();
    resizeObservers.delete(dom);
  }

  /** Makes the table's cells match this widget's table, leaving the box being typed in alone. */
  private sync(block: HTMLElement) {
    const t = this.table;
    const cols = t.align.length;
    const tableEl = block.querySelector("table")!;
    const thead = tableEl.tHead ?? tableEl.createTHead();
    const tbody = tableEl.tBodies[0] ?? tableEl.createTBody();
    const syncRow = (tr: HTMLTableRowElement, tag: "th" | "td", row: number) => {
      while (tr.cells.length > cols) tr.deleteCell(-1);
      while (tr.cells.length < cols) {
        const el = document.createElement(tag);
        try {
          el.contentEditable = "plaintext-only";
        } catch {
          el.contentEditable = "true";
        }
        el.spellcheck = true;
        tr.appendChild(el);
      }
      for (let col = 0; col < cols; col++) {
        const el = tr.cells[col];
        el.dataset.row = String(row);
        el.dataset.col = String(col);
        el.style.textAlign = t.align[col] ?? "";
        const text = cellText(t, { row, col });
        if (el.ownerDocument.activeElement === el) {
          // Being typed in: only replace it when the text really changed (an undo, say).
          if (boxText(el).trim() !== text) {
            el.textContent = text;
            placeCaret(el, "end");
          }
          el.dataset.src = text;
        } else if (el.dataset.src !== text || el.dataset.raw) {
          el.replaceChildren();
          renderInline(text, el);
          el.dataset.src = text;
          delete el.dataset.raw;
        }
      }
    };
    const headRow = thead.rows[0] ?? thead.insertRow();
    syncRow(headRow, "th", HEADER);
    while (tbody.rows.length > t.rows.length) tbody.deleteRow(-1);
    while (tbody.rows.length < t.rows.length) tbody.insertRow();
    t.rows.forEach((_, r) => syncRow(tbody.rows[r], "td", r));
    const m = tableModel(t);
    applySize(block, m.widths, m.heights);
    // Handles follow the cells; measure once the editor has laid the table out.
    requestAnimationFrame(() => layoutHandles(block));
  }

  private listen(view: EditorView, block: HTMLElement) {
    const cellFrom = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-row]");
      return el && block.contains(el) ? el : null;
    };

    // Toolbar and "+" buttons. Pressing one keeps the focus in the cell being edited.
    block.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("[data-action]")) e.preventDefault();
    });
    block.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
      if (!btn || btn.disabled) return;
      e.preventDefault();
      runAction(view, block, btn.dataset.action as Action);
    });

    block.addEventListener("focusin", (e) => {
      const el = cellFrom(e);
      if (!el) return;
      activeCells.set(block, cellRefOf(el));
      // Show the cell's Markdown while it's being edited (only differs when it has formatting).
      const src = el.dataset.src ?? "";
      if (el.textContent !== src || el.childElementCount) {
        el.textContent = src;
        placeCaret(el, "end");
      }
      el.dataset.raw = "1";
      updateToolbar(block, tableOf(view, block));
    });
    block.addEventListener("focusout", (e) => {
      const el = cellFrom(e);
      if (el) {
        const text = boxText(el).trim();
        el.replaceChildren();
        renderInline(text, el);
        el.dataset.src = text;
        delete el.dataset.raw;
      }
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (!next || !block.contains(next)) {
        activeCells.delete(block);
        updateToolbar(block, tableOf(view, block));
      }
    });

    block.addEventListener("input", (e) => {
      const el = cellFrom(e);
      if (el && !(e as InputEvent).isComposing) commitCell(view, block, el);
    });
    block.addEventListener("compositionend", (e) => {
      const el = cellFrom(e);
      if (el) commitCell(view, block, el);
    });

    // Cells hold one line of plain text: no pasted formatting or line breaks.
    block.addEventListener("paste", (e) => {
      const el = cellFrom(e);
      if (!el) return;
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/[\r\n]+/g, " ");
      if (text) document.execCommand("insertText", false, text);
    });
    block.addEventListener("drop", (e) => {
      if (cellFrom(e)) e.preventDefault();
    });
    block.addEventListener("beforeinput", (e) => {
      const el = cellFrom(e);
      if (!el) return;
      const type = (e as InputEvent).inputType;
      if (type.startsWith("format")) e.preventDefault();
      // Phone keyboards send Enter this way rather than as a key press.
      else if (type === "insertParagraph" || type === "insertLineBreak") {
        e.preventDefault();
        moveFrom(view, block, cellRefOf(el), 1, 0, "add");
      }
    });

    block.addEventListener("keydown", (e) => {
      const el = cellFrom(e);
      if (!el || e.isComposing) return;
      const ref = cellRefOf(el);
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        // Undo/redo belong to the note, not to this one box.
        e.preventDefault();
        const t = tableOf(view, block);
        runScopeHandlers(view, e, "editor");
        // The undone step may have removed this cell; stay in the table if it's still there.
        const now = t && view.state.field(tableField).tables.find((x) => x.from === t.from);
        if (!el.isConnected && now) {
          const row = Math.min(ref.row, now.rows.length - 1);
          focusTableCell(view, now.from, { row, col: Math.min(ref.col, now.align.length - 1) });
        }
        return;
      }
      if (mod && (key === "b" || key === "i")) {
        e.preventDefault();
        const marker = key === "b" ? "**" : "*";
        const sel = el.ownerDocument.getSelection()?.toString() ?? "";
        document.execCommand("insertText", false, marker + sel + marker);
        if (!sel) {
          const at = caretOffset(el);
          if (at !== null) placeCaret(el, at - marker.length);
        }
        return;
      }
      if (mod || e.altKey) return;
      const collapsed = !el.ownerDocument.getSelection()?.toString();
      const caret = caretOffset(el);
      let handled = true;
      if (e.key === "Tab") moveFrom(view, block, ref, 0, e.shiftKey ? -1 : 1, "add");
      else if (e.key === "Enter" && e.shiftKey) document.execCommand("insertText", false, "<br>");
      else if (e.key === "Enter") moveFrom(view, block, ref, 1, 0, "add");
      else if (e.key === "ArrowUp" && !e.shiftKey) moveFrom(view, block, ref, -1, 0, "leave");
      else if (e.key === "ArrowDown" && !e.shiftKey) moveFrom(view, block, ref, 1, 0, "leave");
      else if (e.key === "ArrowLeft" && !e.shiftKey && collapsed && caret === 0) moveFrom(view, block, ref, 0, -1, "stay");
      else if (e.key === "ArrowRight" && !e.shiftKey && collapsed && caret === boxText(el).length)
        moveFrom(view, block, ref, 0, 1, "stay");
      else if (e.key === "Escape") {
        const t = tableOf(view, block);
        if (t) leaveTable(view, t, "after");
      } else handled = false;
      if (handled) e.preventDefault();
    });
  }

  /** Links inside cells are handled by the editor's own link handlers; everything else here. */
  ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !target?.closest?.("[data-href], [data-wikilink-target]");
  }
}

// ---------------------------------------------------------------------------------------------
// Inserting a table

/** Inserts a new, empty table below the cursor's line and puts the focus in its first heading. */
export function insertTable(view: EditorView, cols = 3, rows = 2): boolean {
  const { state } = view;
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.head);
  const md = serializeTable(blankTable(cols, rows));
  const blank = line.text.trim() === "";
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  // A blank line after the table, unless there already is one, so typing can carry on below it.
  const after = next && next.text.trim() === "" ? "" : "\n";
  let change: ChangeSpec;
  let tableFrom: number;
  if (blank) {
    const prev = line.number > 1 ? doc.line(line.number - 1) : null;
    const before = prev && prev.text.trim() !== "" ? "\n" : "";
    change = { from: line.from, to: line.to, insert: before + md + after };
    tableFrom = line.from + before.length;
  } else {
    change = { from: line.to, insert: "\n\n" + md + after };
    tableFrom = line.to + 2;
  }
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(tableFrom + md.length + after.length),
    annotations: fromTable.of(true),
    userEvent: "input.table",
    scrollIntoView: true,
  });
  if (!focusTableCell(view, tableFrom, { row: HEADER, col: 0 }, "all")) view.focus();
  return true;
}

// ---------------------------------------------------------------------------------------------
// State

interface TableState {
  tables: MarkdownTable[];
  decorations: DecorationSet;
  /** The line being typed as plain Markdown, kept out of tables until the cursor leaves it. */
  typingLine: number | null;
}

function buildDecorations(state: EditorState, tables: MarkdownTable[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const t of tables) {
    builder.add(
      t.from,
      t.to,
      Decoration.replace({ widget: new TableWidget(t, state.doc.sliceString(t.from, t.to)), block: true })
    );
  }
  return builder.finish();
}

const tableField = StateField.define<TableState>({
  create(state) {
    const tables = findTables(state.doc);
    return { tables, decorations: buildDecorations(state, tables), typingLine: null };
  },
  update(value, tr) {
    let typing = value.typingLine;
    const head = tr.state.selection.main;
    const headLine = tr.state.doc.lineAt(head.head).number;
    if (tr.docChanged) {
      const typed = !tr.annotation(fromTable) && (tr.isUserEvent("input.type") || tr.isUserEvent("delete"));
      typing = typed && head.empty ? headLine : null;
    }
    if (typing !== null && headLine !== typing) typing = null;
    if (!tr.docChanged && typing === value.typingLine) return value;
    const tables = findTables(tr.state.doc, typing ?? -1);
    return { tables, decorations: buildDecorations(tr.state, tables), typingLine: typing };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/**
 * When the cursor is moved onto a table with the keyboard (it would sit invisibly beside or
 * inside it), the focus goes into the table's first or last row instead.
 */
const enterWithCursor = EditorView.updateListener.of((update) => {
  if (!update.selectionSet || !update.view.hasFocus) return;
  const tr = update.transactions.find((t) => t.isUserEvent("select") && !t.annotation(fromTable));
  if (!tr) return;
  const sel = update.state.selection.main;
  if (!sel.empty) return;
  const t = update.state.field(tableField).tables.find((t) => sel.head >= t.from && sel.head <= t.to);
  if (!t) return;
  const cameFromAbove = update.startState.selection.main.head < t.from;
  const ref = cameFromAbove || t.rows.length === 0 ? { row: HEADER, col: 0 } : { row: t.rows.length - 1, col: 0 };
  const view = update.view;
  queueMicrotask(() => focusTableCell(view, t.from, ref, "end"));
});

/** Returns true when line `n` (1-based) belongs to a table. Used by the live preview plugin. */
export function isTableLine(state: EditorState, n: number): boolean {
  const field = state.field(tableField, false);
  return !!field?.tables.some((t) => n >= t.fromLine && n <= t.toLine);
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const tableTheme = EditorView.theme({
  ".cm-md-table-block": {
    margin: "6px 0 12px",
    position: "relative",
    // Its width comes from the editor, never from its contents: a wide table or the toolbar
    // scrolls inside the block instead of widening the whole note.
    contain: "inline-size",
    maxWidth: "100%",
  },
  ".cm-md-table-toolbar": {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "2px",
    minHeight: "28px",
    marginBottom: "4px",
    whiteSpace: "nowrap",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 120ms ease",
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
    fontSize: "11px",
    userSelect: "none",
  },
  ".cm-md-table-block:hover .cm-md-table-toolbar, .cm-md-table-block:focus-within .cm-md-table-toolbar": {
    opacity: "1",
    pointerEvents: "auto",
  },
  ".cm-md-table-toolbar-set": {
    display: "inline-flex",
    alignItems: "center",
    gap: "2px",
    flexShrink: "0",
  },
  ".cm-md-table-toolbar-icon": {
    display: "inline-flex",
    color: "#64748b",
    padding: "0 4px 0 2px",
  },
  ".cm-md-table-toolbar-group": {
    color: "#64748b",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: "10px",
    padding: "0 2px 0 8px",
    borderLeft: "1px solid #30363d",
    marginLeft: "4px",
  },
  ".cm-md-table-toolbar-group:empty": {
    padding: "0 0 0 4px",
  },
  ".cm-md-table-btn": {
    WebkitTapHighlightColor: "transparent",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "24px",
    padding: "0 7px",
    borderRadius: "6px",
    border: "1px solid transparent",
    background: "transparent",
    color: "#c9d1d9",
    font: "inherit",
    cursor: "pointer",
    flexShrink: "0",
  },
  ".cm-md-table-btn:hover:not(:disabled)": {
    background: "#21262d",
    borderColor: "#30363d",
    color: "#ffffff",
  },
  ".cm-md-table-btn-danger:hover:not(:disabled)": {
    color: "#f87171",
    borderColor: "rgba(248, 113, 113, 0.35)",
    background: "rgba(248, 113, 113, 0.08)",
  },
  ".cm-md-table-btn:disabled": {
    opacity: "0.35",
    cursor: "default",
  },
  ".cm-md-table-body": {
    display: "flex",
    alignItems: "stretch",
    gap: "4px",
  },
  ".cm-md-table-wrap": {
    position: "relative",
    flex: "1 1 auto",
    minWidth: "0",
    overflowX: "auto",
    // Always as tall as the table; a handle a frame behind a shrinking row mustn't add a scrollbar.
    overflowY: "hidden",
    borderRadius: "10px",
    border: "1px solid #30363d",
  },
  // Sized tables are as wide as their columns, not the whole note.
  ".cm-md-table-sized .cm-md-table-wrap": {
    flex: "0 1 auto",
  },
  ".cm-md-table-handles": {
    position: "absolute",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    zIndex: "2",
    pointerEvents: "none",
  },
  ".cm-md-table-handle": {
    position: "absolute",
    pointerEvents: "auto",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  },
  ".cm-md-table-handle::after": {
    content: '""',
    position: "absolute",
    backgroundColor: "transparent",
    borderRadius: "2px",
    transition: "background-color 100ms ease",
  },
  ".cm-md-table-handle-col": { top: "0", width: "10px", cursor: "col-resize" },
  ".cm-md-table-handle-col::after": { top: "0", bottom: "0", left: "calc(50% - 1px)", width: "2px" },
  ".cm-md-table-handle-row": { left: "0", height: "8px", cursor: "row-resize" },
  ".cm-md-table-handle-row::after": { left: "0", right: "0", top: "calc(50% - 1px)", height: "2px" },
  ".cm-md-table-handle-col.cm-md-table-handle-last::after": { left: "auto", right: "0" },
  ".cm-md-table-handle-row.cm-md-table-handle-last::after": { top: "auto", bottom: "0" },
  ".cm-md-table-handle:hover::after, .cm-md-table-handle-dragging::after": {
    backgroundColor: "rgba(56, 189, 248, 0.8)",
  },
  ".cm-md-table-resizing, .cm-md-table-resizing *": {
    userSelect: "none",
  },
  ".cm-md-table-resizing .cm-md-table-handle-col": { cursor: "col-resize" },
  ".cm-md-table-add": {
    WebkitTapHighlightColor: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px dashed #30363d",
    borderRadius: "8px",
    background: "transparent",
    color: "#64748b",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 120ms ease, color 120ms ease, border-color 120ms ease",
    padding: "0",
  },
  ".cm-md-table-add-col": { width: "18px", flexShrink: "0" },
  ".cm-md-table-add-row": { width: "calc(100% - 22px)", height: "18px", marginTop: "4px" },
  ".cm-md-table-block:hover .cm-md-table-add, .cm-md-table-block:focus-within .cm-md-table-add": {
    opacity: "1",
  },
  ".cm-md-table-add:hover": {
    color: "#38bdf8",
    borderColor: "rgba(56, 189, 248, 0.5)",
    background: "rgba(56, 189, 248, 0.06)",
  },
  ".cm-md-table": {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.92em",
    lineHeight: "1.55",
  },
  ".cm-md-table th, .cm-md-table td": {
    padding: "7px 12px",
    textAlign: "left",
    verticalAlign: "top",
    borderBottom: "1px solid rgba(48, 54, 61, 0.7)",
    borderRight: "1px solid rgba(48, 54, 61, 0.5)",
    minWidth: "60px",
    outline: "none",
    cursor: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    caretColor: "#38bdf8",
  },
  ".cm-md-table th:last-child, .cm-md-table td:last-child": {
    borderRight: "none",
  },
  ".cm-md-table tbody tr:last-child td": {
    borderBottom: "none",
  },
  ".cm-md-table th": {
    backgroundColor: "#161b22",
    color: "#ffffff",
    fontWeight: "600",
    borderBottom: "1px solid #30363d",
  },
  ".cm-md-table td": {
    color: "#d0d7de",
  },
  ".cm-md-table tbody tr:nth-child(even) td": {
    backgroundColor: "rgba(22, 27, 34, 0.45)",
  },
  ".cm-md-table tbody tr:hover td": {
    backgroundColor: "rgba(56, 189, 248, 0.05)",
  },
  // The cell being edited shows its Markdown, framed so it's clear where typing goes.
  ".cm-md-table th:focus, .cm-md-table td:focus, .cm-md-table tbody tr td:focus": {
    boxShadow: "inset 0 0 0 2px rgba(56, 189, 248, 0.65)",
    backgroundColor: "rgba(56, 189, 248, 0.07)",
    fontFamily: mono,
    fontSize: "0.92em",
  },
  ".cm-md-table strong": { color: "#ffffff", fontWeight: "700" },
  ".cm-md-table s": { color: "#94a3b8" },
  // Touch screens: no hover, so the toolbar shows only while a cell is being edited. It sits
  // under the table (so the tapped cell doesn't jump), wraps instead of scrolling out of sight,
  // and has finger-sized buttons.
  "@media (hover: none), (pointer: coarse)": {
    ".cm-md-table-block": {
      display: "flex",
      flexDirection: "column",
    },
    ".cm-md-table-toolbar": {
      order: "3",
      display: "none",
      flexWrap: "wrap",
      height: "auto",
      rowGap: "2px",
      columnGap: "6px",
      margin: "6px 0 0",
      padding: "4px",
      overflowX: "visible",
      whiteSpace: "normal",
      borderRadius: "10px",
      border: "1px solid #30363d",
      backgroundColor: "#161b22",
      fontSize: "12.5px",
    },
    ".cm-md-table-block:focus-within .cm-md-table-toolbar": {
      display: "flex",
    },
    ".cm-md-table-btn": {
      height: "38px",
      padding: "0 10px",
    },
    ".cm-md-table-toolbar-group": {
      marginLeft: "2px",
      borderLeft: "none",
    },
    ".cm-md-table-toolbar-icon": { display: "none" },
    // Hover sticks after a tap on touch screens; highlight only while pressed.
    ".cm-md-table-btn:hover:not(:disabled), .cm-md-table-btn-danger:hover:not(:disabled)": {
      background: "transparent",
      borderColor: "transparent",
      color: "#c9d1d9",
    },
    ".cm-md-table-btn:active:not(:disabled)": {
      background: "#30363d",
      color: "#ffffff",
    },
    ".cm-md-table-add:hover": {
      color: "#64748b",
      borderColor: "#30363d",
      background: "transparent",
    },
    ".cm-md-table-add:active": {
      color: "#38bdf8",
      borderColor: "rgba(56, 189, 248, 0.5)",
    },
    ".cm-md-table-handle-col": { width: "22px" },
    ".cm-md-table-handle-row": { height: "18px" },
    ".cm-md-table-block:focus-within .cm-md-table-handle::after": {
      backgroundColor: "rgba(56, 189, 248, 0.3)",
    },
    ".cm-md-table-block .cm-md-table-handle-dragging::after": {
      backgroundColor: "rgba(56, 189, 248, 0.9)",
    },
    ".cm-md-table-add-col": { width: "32px" },
    ".cm-md-table-add-row": { width: "calc(100% - 36px)", height: "34px" },
  },
  ".cm-md-table-code": {
    fontFamily: mono,
    fontSize: "0.88em",
    backgroundColor: "rgba(22, 27, 34, 0.9)",
    border: "1px solid #30363d",
    color: "#7dd3fc",
    padding: "1px 5px",
    borderRadius: "5px",
  },
});

/** Renders Markdown tables and lets them be edited in place. Add next to the live preview plugin. */
export function markdownTables(): Extension {
  return [tableField, enterWithCursor, tableTheme];
}
