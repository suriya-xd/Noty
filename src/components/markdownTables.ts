import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

/**
 * GitHub-style Markdown tables in the editor. A table is shown as a real table until the cursor
 * enters it; then its Markdown is shown (in a monospace font so the columns line up) for editing.
 * Clicking a cell puts the cursor at that cell's text.
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
    cells.push({ text: raw.trim().replace(/\\\|/g, "|"), from: lineFrom + start + leftPad });
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

/** Finds every table in the document (skipping fenced code blocks). */
export function findTables(doc: Text): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let inFence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (FENCE.test(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || n === doc.lines || !isRowCandidate(line.text)) continue;
    const delim = doc.line(n + 1);
    const align = isDelimiterRow(delim.text);
    if (!align) continue;
    const header = splitRow(line.text, line.from);
    if (header.length !== align.length) continue;

    const rows: TableCell[][] = [];
    let last = n + 1;
    while (last < doc.lines) {
      const next = doc.line(last + 1);
      if (!isRowCandidate(next.text) || FENCE.test(next.text)) break;
      rows.push(splitRow(next.text, next.from));
      last++;
    }
    tables.push({
      from: line.from,
      to: doc.line(last).to,
      fromLine: n,
      toLine: last,
      align,
      header,
      rows,
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
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";

    const table = document.createElement("table");
    table.className = "cm-md-table";

    const addCell = (row: HTMLTableRowElement, tag: "th" | "td", cell: TableCell | undefined, col: number, rowEnd: number) => {
      const el = document.createElement(tag);
      const align = this.table.align[col];
      if (align) el.style.textAlign = align;
      if (cell) renderInline(cell.text, el);
      el.dataset.pos = String(cell ? cell.from : rowEnd);
      row.appendChild(el);
    };

    const thead = document.createElement("thead");
    const headRow = thead.insertRow();
    const cols = this.table.align.length;
    const headerEnd = view.state.doc.lineAt(this.table.from).to;
    for (let c = 0; c < cols; c++) addCell(headRow, "th", this.table.header[c], c, headerEnd);
    table.appendChild(thead);

    if (this.table.rows.length) {
      const tbody = document.createElement("tbody");
      for (const cells of this.table.rows) {
        const tr = tbody.insertRow();
        const rowEnd = cells.length ? view.state.doc.lineAt(cells[0].from).to : this.table.to;
        // GFM: extra cells are dropped, missing ones are empty.
        for (let c = 0; c < cols; c++) addCell(tr, "td", cells[c], c, rowEnd);
      }
      table.appendChild(tbody);
    }

    wrap.appendChild(table);

    // A click on a cell (not a link) moves the cursor into that cell's Markdown.
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-href], [data-wikilink-target]")) return;
      const cell = target.closest("[data-pos]") as HTMLElement | null;
      e.preventDefault();
      const pos = cell ? Number(cell.dataset.pos) : this.table.from;
      view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: false });
      view.focus();
    });

    return wrap;
  }

  /** Links inside cells are handled by the editor's own link handlers; everything else here. */
  ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !target?.closest?.("[data-href], [data-wikilink-target]");
  }
}

// ---------------------------------------------------------------------------------------------
// State

interface TableState {
  tables: MarkdownTable[];
  decorations: DecorationSet;
}

const sourceLine = Decoration.line({ class: "cm-md-table-source" });
const sourceHeaderLine = Decoration.line({ class: "cm-md-table-source cm-md-table-source-head" });

function buildDecorations(state: EditorState, tables: MarkdownTable[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, selection } = state;
  for (const t of tables) {
    const editing = selection.ranges.some((r) => r.from <= t.to && r.to >= t.from);
    if (editing) {
      for (let n = t.fromLine; n <= t.toLine; n++) {
        builder.add(doc.line(n).from, doc.line(n).from, n <= t.fromLine + 1 ? sourceHeaderLine : sourceLine);
      }
    } else {
      builder.add(
        t.from,
        t.to,
        Decoration.replace({ widget: new TableWidget(t, doc.sliceString(t.from, t.to)), block: true })
      );
    }
  }
  return builder.finish();
}

const tableField = StateField.define<TableState>({
  create(state) {
    const tables = findTables(state.doc);
    return { tables, decorations: buildDecorations(state, tables) };
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    const tables = tr.docChanged ? findTables(tr.state.doc) : value.tables;
    return { tables, decorations: buildDecorations(tr.state, tables) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/** Returns true when line `n` (1-based) belongs to a table. Used by the live preview plugin. */
export function isTableLine(state: EditorState, n: number): boolean {
  const field = state.field(tableField, false);
  return !!field?.tables.some((t) => n >= t.fromLine && n <= t.toLine);
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const tableTheme = EditorView.theme({
  ".cm-md-table-wrap": {
    margin: "12px 0",
    overflowX: "auto",
    borderRadius: "10px",
    border: "1px solid #30363d",
    cursor: "text",
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
  ".cm-md-table strong": { color: "#ffffff", fontWeight: "700" },
  ".cm-md-table s": { color: "#94a3b8" },
  ".cm-md-table-code": {
    fontFamily: mono,
    fontSize: "0.88em",
    backgroundColor: "rgba(22, 27, 34, 0.9)",
    border: "1px solid #30363d",
    color: "#7dd3fc",
    padding: "1px 5px",
    borderRadius: "5px",
  },
  // While editing: the raw Markdown, monospaced so the columns line up.
  ".cm-md-table-source": {
    fontFamily: mono,
    fontSize: "13.5px",
    color: "#c9d1d9",
    whiteSpace: "pre-wrap",
  },
  ".cm-md-table-source-head": {
    color: "#ffffff",
  },
});

/** Renders Markdown tables. Add next to the live preview plugin. */
export function markdownTables(): Extension {
  return [tableField, tableTheme];
}
