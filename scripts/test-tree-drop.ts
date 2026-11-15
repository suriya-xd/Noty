import { canDrop, planDrop, renameInCustomOrder } from "../src/utils/customOrder";

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

console.log("\ncanDrop");
eq("not onto itself", canDrop("A", "A", "before", true), false);
eq("a folder not into its own contents", canDrop("A", "A/B", "inside", true), false);
eq("not inside a note", canDrop("x.md", "y.md", "inside", false), false);
eq("note into a folder", canDrop("x.md", "A", "inside", true), true);
eq("out of a folder, next to a top-level item", canDrop("A/x.md", "y.md", "after", false), true);

console.log("\nplanDrop");
const root = ["A", "B", "x.md", "y.md"];
eq(
  "reorder at the top level",
  planDrop({}, { source: "y.md", target: "A", position: "before", siblingNames: root, childNames: [], fromScreen: false }),
  { newPath: "y.md", order: { "": ["y.md", "A", "B", "x.md"] } }
);
eq(
  "drop a note into a folder (goes last)",
  planDrop({}, { source: "x.md", target: "A", position: "inside", siblingNames: root, childNames: ["a1.md", "a2.md"], fromScreen: false }),
  { newPath: "A/x.md", order: { A: ["a1.md", "a2.md", "x.md"] } }
);
eq(
  "drop a canvas between two items in a folder",
  planDrop({}, { source: "map.canvas", target: "A/a2.md", position: "before", siblingNames: ["a1.md", "a2.md"], childNames: [], fromScreen: false }),
  { newPath: "A/map.canvas", order: { A: ["a1.md", "map.canvas", "a2.md"] } }
);
eq(
  "take a note out of a folder to the top level",
  planDrop({ A: ["a1.md", "a2.md"], "": root }, { source: "A/a2.md", target: "x.md", position: "after", siblingNames: root, childNames: [], fromScreen: false }),
  { newPath: "a2.md", order: { A: ["a1.md"], "": ["A", "B", "x.md", "a2.md", "y.md"] } }
);
eq(
  "drop on the top-level zone",
  planDrop({ "": root }, { source: "A/a1.md", target: "", position: "inside", siblingNames: [], childNames: root, fromScreen: false }),
  { newPath: "a1.md", order: { "": ["A", "B", "x.md", "y.md", "a1.md"] } }
);
{
  // Moving a folder keeps the saved order of everything inside it.
  const order = { "": root, A: ["Sub", "a1.md"], "A/Sub": ["s2.md", "s1.md"] };
  const plan = planDrop(order, { source: "A", target: "B", position: "inside", siblingNames: root, childNames: [], fromScreen: false });
  eq("moving a folder: new path", plan.newPath, "B/A");
  eq("...its contents keep their order", [plan.order["B/A"], plan.order["B/A/Sub"]], [["Sub", "a1.md"], ["s2.md", "s1.md"]]);
  eq("...and old keys are gone", [plan.order["A"], plan.order["A/Sub"]], [undefined, undefined]);
  eq("...and it leaves the top level", plan.order[""], ["B", "x.md", "y.md"]);
}
eq(
  "A–Z list: the screen order is kept apart from the moved item",
  planDrop({ "": ["y.md", "x.md", "B", "A"] }, { source: "y.md", target: "A", position: "after", siblingNames: root, childNames: [], fromScreen: true }).order[""],
  ["A", "y.md", "B", "x.md"]
);
{ const r = renameInCustomOrder({ "P/Q": ["z"], P: ["Q"] }, "P", "R"); eq("renaming a folder re-keys nested order", [r.R, r["R/Q"], r.P, r["P/Q"]], [["Q"], ["z"], undefined, undefined]); }

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll tree-drop tests passed\n");
