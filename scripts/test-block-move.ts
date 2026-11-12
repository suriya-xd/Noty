import { findBlock, moveBlock } from "../src/components/blockMove";
import type { BlockRange } from "../src/components/blockMove";

let failures = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`);
  }
}

const doc = (text: string) => text.split("\n");

/** Moves the block found at `line` to before `insertBefore` and returns the resulting text. */
function move(text: string, line: number, insertBefore: number): string | null {
  const lines = doc(text);
  const block = findBlock(lines, line) as BlockRange;
  const res = moveBlock(lines, block, insertBefore);
  return res ? res.lines.join("\n") : null;
}

console.log("\nfindBlock");
eq("plain line is its own block", findBlock(doc("a\nb\nc"), 1), { from: 1, to: 1 });
eq("blank line has no block", findBlock(doc("a\n\nb"), 1), null);
eq("out of range", findBlock(doc("a"), 5), null);
eq(
  "list item takes its indented children",
  findBlock(doc("- a\n  - a1\n  - a2\n- b"), 0),
  { from: 0, to: 2 }
);
eq("nested item takes only its own subtree", findBlock(doc("- a\n  - a1\n    - deep\n  - a2"), 1), { from: 1, to: 2 });
eq("last list item", findBlock(doc("- a\n- b"), 1), { from: 1, to: 1 });
eq(
  "any line of a code fence selects the whole fence",
  findBlock(doc("text\n```js\nlet a = 1;\n\nlet b = 2;\n```\nafter"), 4),
  { from: 1, to: 5 }
);
eq("unclosed fence runs to the end", findBlock(doc("```\ncode\nmore"), 1), { from: 0, to: 2 });
eq(
  "fence nested in a list item moves with it",
  findBlock(doc("- item\n  ```\n  x\n  ```\n- next"), 0),
  { from: 0, to: 3 }
);
eq("table rows form one block", findBlock(doc("| a | b |\n|---|---|\n| 1 | 2 |\n\ntext"), 1), { from: 0, to: 2 });
eq("numbered item", findBlock(doc("1. one\n   detail\n2. two"), 0), { from: 0, to: 1 });

console.log("\nmoveBlock: no-ops");
eq("drop right above itself", move("a\nb\nc", 1, 1), null);
eq("drop right below itself", move("a\nb\nc", 1, 2), null);
eq("drop inside itself", moveBlock(doc("- a\n  - b\n- c"), { from: 0, to: 1 }, 1), null);

console.log("\nmoveBlock: tight notes (one line per row)");
eq("up", move("a\nb\nc", 2, 0), "c\na\nb");
eq("down", move("a\nb\nc", 0, 3), "b\nc\na");
eq("to the middle", move("a\nb\nc\nd", 3, 1), "a\nd\nb\nc");
eq("no blank lines are invented", move("a\nb\nc", 0, 2), "b\na\nc");

console.log("\nmoveBlock: spaced paragraphs");
eq("last to first keeps paragraphs apart", move("A\n\nB\n\nC", 4, 0), "C\n\nA\n\nB");
eq("first to last keeps paragraphs apart", move("A\n\nB\n\nC", 0, 5), "B\n\nC\n\nA");
eq("into the middle", move("A\n\nB\n\nC", 4, 2), "A\n\nC\n\nB");
eq("after a blank-line gap does not double up", move("A\n\nB\n\nC", 0, 4), "B\n\nA\n\nC");

console.log("\nmoveBlock: structure");
eq("heading moves without extra blank lines", move("# One\ntext\n# Two\nmore", 2, 0), "# Two\n# One\ntext\nmore");
eq(
  "list item with children moves as one",
  move("- a\n  - a1\n- b\n- c", 0, 4),
  "- b\n- c\n- a\n  - a1"
);
eq(
  "code fence moves whole",
  move("intro\n\n```\ncode\n```\n\noutro", 3, 7),
  "intro\n\noutro\n\n```\ncode\n```"
);
eq("paragraph dropped under a list keeps its blank line", move("- x\n- y\n\nP", 3, 2), "- x\n- y\n\nP");
eq("paragraph moved into a list is set apart on both sides", move("P\n\n- x\n- y", 0, 3), "- x\n\nP\n\n- y");
eq("list item dropped into a list does not split it", move("- z\n\ntext\n\n- x\n- y", 0, 5), "text\n\n- x\n- z\n- y");
eq("list dropped under a paragraph gets a blank line", move("A\n\n- l\n\nB", 2, 5), "A\n\nB\n\n- l");
eq("tight notes still get no padding for different kinds", move("A\n- l\nB", 1, 3), "A\nB\n- l");

console.log("\nmoveBlock: selection target");
{
  const lines = doc("A\n\nB\n\nC");
  const res = moveBlock(lines, { from: 4, to: 4 }, 0);
  eq("movedStart points at the moved block", res && res.lines[res.movedStart], "C");
  const res2 = moveBlock(lines, { from: 0, to: 0 }, 5);
  eq("movedStart after padding", res2 && res2.lines[res2.movedStart], "A");
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll block-move tests passed\n");
