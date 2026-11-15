import { EditorState } from "@codemirror/state";
import { renumberLists, orderedListRenumbering } from "../src/components/listNumbering";
import { findBlock, moveBlock } from "../src/components/blockMove";

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

/** Applies renumberLists to the whole text (every line touched). */
function renumber(text: string): string {
  const lines = text.split("\n");
  const edits = renumberLists(lines, [{ from: 0, to: lines.length - 1 }]);
  for (const e of [...edits].reverse()) {
    const l = lines[e.line];
    lines[e.line] = l.slice(0, e.from) + e.insert + l.slice(e.to);
  }
  return lines.join("\n");
}

/** Runs a user transaction through the editor extension and returns the resulting text. */
function edit(text: string, from: number, to: number, insert: string, userEvent = "input"): string {
  const state = EditorState.create({ doc: text, extensions: [orderedListRenumbering] });
  return state.update({ changes: { from, to, insert }, userEvent }).state.doc.toString();
}

console.log("\nrenumberLists");
eq("reordered list counts up again", renumber("3. c\n1. a\n2. b"), "1. c\n2. a\n3. b");
eq("already in order: unchanged", renumber("1. a\n2. b\n3. c"), "1. a\n2. b\n3. c");
eq("list deliberately starting at 5 keeps its start", renumber("7. c\n5. a\n6. b"), "5. c\n6. a\n7. b");
eq("blank line splits: lower part restarts at 1", renumber("1. a\n2. b\n\n3. c\n4. d"), "1. a\n2. b\n\n1. c\n2. d");
eq("nested lists are numbered on their own", renumber("2. a\n   2. x\n   1. y\n1. b"), "1. a\n   1. x\n   2. y\n2. b");
eq("wrapped text under an item doesn't break the list", renumber("2. a\n   more\n1. b"), "1. a\n   more\n2. b");
eq("a paragraph ends the list", renumber("2. a\ntext\n5. b"), "2. a\ntext\n5. b");
eq("bullets are left alone", renumber("- a\n- b"), "- a\n- b");
eq("`)` lists are separate from `.` lists", renumber("2. a\n1) b\n3) c"), "2. a\n1) b\n2) c");
eq("code blocks are left alone", renumber("```\n3. x\n1. y\n```"), "```\n3. x\n1. y\n```");
eq("10 items", renumber(Array.from({ length: 10 }, (_, i) => `${10 - i}. x`).join("\n")).split("\n").map((l) => l.split(".")[0]).join(","), "1,2,3,4,5,6,7,8,9,10");
eq(
  "only lists near the edit are touched",
  renumberLists("3. a\n1. b\n\ntext\n\n3. c\n1. d".split("\n"), [{ from: 6, to: 6 }]).map((e) => e.line),
  [5, 6]
);

console.log("\nIn the editor");
const list = "1. one\n2. two\n3. three";
// Drag "3. three" to the top, as the block handle does.
{
  const lines = list.split("\n");
  const res = moveBlock(lines, findBlock(lines, 2)!, 0)!;
  const next = res.lines.join("\n");
  eq("dragging an item to the top renumbers", edit(list, 0, list.length, next, "move.block"), "1. three\n2. one\n3. two");
}
// Alt+Up on the last line swaps it with the one above.
eq("moving a line up renumbers", edit(list, 7, list.length, "3. three\n2. two", "move.line"), "1. one\n2. three\n3. two");
// Cutting a line out of the middle.
eq("cutting an item renumbers the rest", edit(list, 7, 14, "", "delete.cut"), "1. one\n2. three");
// Pasting an item in.
eq("pasting an item renumbers", edit(list, 0, 0, "1. zero\n", "input.paste"), "1. zero\n2. one\n3. two\n4. three");
// Splitting the list with a blank line.
eq("a blank line splits it into two lists", edit(list, 6, 6, "\n", "input"), "1. one\n\n1. two\n2. three");
// Typing within a line never renumbers: a list can be started at any number.
eq("typing a number is left alone", edit("1. a\n", 5, 5, "5", "input.type"), "1. a\n5");
// Programmatic loads (no user event) never rewrite the note.
eq("loading a note doesn't rewrite it", edit("", 0, 0, "3. a\n1. b", ""), "3. a\n1. b");

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll list-numbering tests passed\n");
