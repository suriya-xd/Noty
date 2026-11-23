import { Text } from "@codemirror/state";
import {
  blankTable,
  deleteColumn,
  deleteRow,
  escapeCell,
  findTables,
  insertColumn,
  insertRow,
  parseSizeComment,
  serializeTable,
  setAlign,
  sizeComment,
  splitRow,
  tableModel,
} from "../src/components/markdownTables";

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

const tables = (s: string) => findTables(Text.of(s.split("\n")));
const texts = (s: string) => splitRow(s, 0).map((c) => c.text);

console.log("\nsplitRow");
eq("leading and trailing pipes", texts("| a | b |"), ["a", "b"]);
eq("no outer pipes", texts("a | b"), ["a", "b"]);
eq("escaped pipe stays in the cell", texts("| a \\| b | c |"), ["a | b", "c"]);
eq("pipe inside code stays in the cell", texts("| `x | y` | c |"), ["`x | y`", "c"]);
eq("empty cell", texts("| a |  | c |"), ["a", "", "c"]);
eq("cell offsets point at trimmed text", splitRow("|  ab | c |", 10).map((c) => c.from), [13, 18]);

console.log("\nfindTables");
const claude = [
  "# Notes",
  "",
  "| Feature | Status | Notes |",
  "|:--------|:------:|------:|",
  "| Tables | **done** | `x` |",
  "| Lists | todo | |",
  "",
  "after",
].join("\n");
const t = tables(claude);
eq("finds one table", t.length, 1);
eq("line span", [t[0].fromLine, t[0].toLine], [3, 6]);
eq("alignment", t[0].align, ["left", "center", "right"]);
eq("header", t[0].header.map((c) => c.text), ["Feature", "Status", "Notes"]);
eq("rows", t[0].rows.map((r) => r.map((c) => c.text)), [["Tables", "**done**", "`x`"], ["Lists", "todo", ""]]);
eq("table ends at a non-row line", tables("| a | b |\n|---|---|\n| 1 | 2 |\ntext")[0].toLine, 3);
eq("header-only table", tables("| a | b |\n| --- | --- |")[0].rows.length, 0);
eq("column count mismatch is not a table", tables("| a | b |\n|---|").length, 0);
eq("setext heading is not a table", tables("a | b\n---").length, 0);
eq("tables inside code fences are ignored", tables("```\n| a | b |\n|---|---|\n```").length, 0);
eq("two tables", tables("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |").length, 2);

eq("cell end offsets", splitRow("|  ab | c |", 10).map((c) => c.to), [15, 19]);
eq("the line being typed is not part of a table", findTables(Text.of(["| a | b |", "|---|---|", "| 1 | 2 |", "| 3"]), 4)[0].toLine, 3);
eq("no table while its delimiter row is typed", findTables(Text.of(["| a | b |", "|---|---|"]), 2).length, 0);

console.log("\nediting model");
const short = tables("| a | b | c |\n|---|:-:|--:|\n| 1 |")[0];
eq("model pads short rows", tableModel(short).rows, [["1", "", ""]]);
eq("escapes pipes", escapeCell("a|b"), "a\\|b");
eq("keeps escaped pipes", escapeCell("a\\|b"), "a\\|b");
eq("trailing backslash can't eat the pipe", escapeCell("a\\"), "a\\ ");
eq("line breaks become spaces", escapeCell("a\nb"), "a b");
const md = serializeTable(tableModel(short));
eq("serialize pads columns and keeps alignment", md, "| a   | b   | c   |\n| --- | :-: | --: |\n| 1   |     |     |");
const round = tables(md)[0];
eq("serialized table parses back", [round.align, tableModel(round)], [short.align, tableModel(short)]);
const blank = blankTable(2, 1);
eq("blank table", serializeTable(blank), "| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |");
eq("blank table parses", tables(serializeTable(blank)).length, 1);
const m = tableModel(tables("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")[0]);
eq("insert row", insertRow(m, 1).rows, [["1", "2"], ["", ""], ["3", "4"]]);
eq("delete row", deleteRow(m, 0).rows, [["3", "4"]]);
const withCol = insertColumn(m, 1);
eq("insert column header", withCol.header, ["a", "", "b"]);
eq("insert column rows", withCol.rows, [["1", "", "2"], ["3", "", "4"]]);
eq("insert column align", withCol.align, [null, null, null]);
eq("delete column", deleteColumn(m, 0), { align: [null], header: ["b"], rows: [["2"], ["4"]] });
eq("set align", setAlign(m, 1, "right").align, [null, "right"]);
eq("table with an empty header cell parses", tables(serializeTable(withCol))[0].header.map((c) => c.text), ["a", "", "b"]);
eq("pipes survive a round trip", tables(serializeTable({ align: [null], header: ["x|y"], rows: [] }))[0].header[0].text, "x|y");

console.log("\nsizes");
eq("parse size comment", parseSizeComment("<!-- table: widths=140,auto,90; heights=auto,64 -->"), { widths: [140, null, 90], heights: [null, 64] });
eq("not a size comment", parseSizeComment("<!-- note -->"), null);
eq("write size comment", sizeComment({ widths: [140, null, 90], heights: [null, null] }), "<!-- table: widths=140,auto,90 -->");
eq("no comment when all automatic", sizeComment({ widths: [null], heights: [] }), null);
const sizedDoc = "text\n<!-- table: widths=100,200; heights=auto,50 -->\n| a | b |\n|---|---|\n| 1 | 2 |";
const sized = tables(sizedDoc)[0];
eq("comment line belongs to the table", [sized.fromLine, sized.from, sized.toLine], [2, 5, 5]);
eq("table sizes", sized.size, { widths: [100, 200], heights: [null, 50] });
eq("header still found below the comment", sized.header.map((c) => c.text), ["a", "b"]);
const sm = tableModel(sized);
eq("model sizes", [sm.widths, sm.heights], [[100, 200], [null, 50]]);
eq("serialize writes the comment first", serializeTable(sm).split("\n")[0], "<!-- table: widths=100,200; heights=auto,50 -->");
eq("sized table round trip", tableModel(tables(serializeTable(sm))[0]), sm);
eq("insert column gets a width", insertColumn(sm, 1).widths, [100, 140, 200]);
eq("delete column drops its width", deleteColumn(sm, 0).widths, [200]);
eq("insert row keeps heights in step", insertRow(sm, 0).heights, [null, null, 50]);
eq("delete row drops its height", deleteRow(sm, 0).heights, [null]);
eq("unsized model has no sizes", "widths" in tableModel(tables("| a |\n|---|")[0]), false);
eq("a stray comment elsewhere is not a size", tables("<!-- table: widths=9 -->\n\n| a |\n|---|")[0].size, null);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
