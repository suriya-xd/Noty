import { Text } from "@codemirror/state";
import { findTables, splitRow } from "../src/components/markdownTables";

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

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
