import { buildNoteHierarchy, childrenOnBranch, makeResolver } from "../src/utils/noteHierarchy";

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

const build = (links: Record<string, string[]>, extra: string[] = []) =>
  buildNoteHierarchy([...Object.keys(links), ...extra], (p) => links[p] ?? []);
const nested = (h: ReturnType<typeof build>) => [...h.nested].sort();

console.log("\nresolving links");
const resolve = makeResolver(["A.md", "docs/Plan.md", "docs/A.md", "Map.canvas", "deep/x/A.md"]);
eq("bare name", resolve("Plan", "A.md"), "docs/Plan.md");
eq("case-insensitive", resolve("plan", "A.md"), "docs/Plan.md");
eq("with .md", resolve("docs/Plan.md", "A.md"), "docs/Plan.md");
eq("exact path wins", resolve("docs/A", "A.md"), "docs/A.md");
eq("an exact path beats the linking note's folder", resolve("A", "docs/Plan.md"), "A.md");
eq("relative to the linking note's folder", resolve("x/A", "deep/Note.md"), "deep/x/A.md");
eq("shortest path for a bare name", resolve("A", "other.md"), "A.md");
eq("canvas by full name", resolve("Map.canvas", "A.md"), "Map.canvas");
eq("canvas by bare name", resolve("Map", "A.md"), "Map.canvas");
eq("unknown", resolve("Nope", "A.md"), null);

console.log("\nchildren");
{
  const h = build({ "A.md": ["B", "C", "B", "A", "Missing"], "B.md": [], "C.md": [] });
  eq("in link order, no duplicates, no self, no missing", h.children.get("A.md"), ["B.md", "C.md"]);
  eq("notes without links have no entry", h.children.has("B.md"), false);
  eq("linked notes in the same folder are nested", nested(h), ["B.md", "C.md"]);
}
{
  const h = build({ "A.md": ["B"], "B.md": ["C"], "C.md": [] });
  eq("a chain nests all the way down", nested(h), ["B.md", "C.md"]);
}
{
  const h = build({ "A.md": ["C"], "B.md": ["C"], "C.md": [] });
  eq("two parents: nested once, listed under both", [nested(h), h.children.get("A.md"), h.children.get("B.md")], [
    ["C.md"],
    ["C.md"],
    ["C.md"],
  ]);
}

console.log("\nfolders");
{
  const h = build({ "A.md": ["B"], "docs/B.md": [] , "B.md": []});
  eq("a bare name prefers the root note", h.children.get("A.md"), ["B.md"]);
}
{
  const h = build({ "A.md": ["docs/B"], "docs/B.md": [] });
  eq("a child in another folder is still a child", h.children.get("A.md"), ["docs/B.md"]);
  eq("...but stays in its own folder", nested(h), []);
}
{
  const h = build({ "docs/A.md": ["B"], "docs/B.md": [] });
  eq("same subfolder nests", nested(h), ["docs/B.md"]);
}

console.log("\ncircles");
{
  const h = build({ "A.md": ["B"], "B.md": ["A"] });
  eq("A ↔ B: one stays in the folder", nested(h), ["B.md"]);
}
{
  const h = build({ "R.md": ["A"], "A.md": ["B"], "B.md": ["A"] });
  eq("a circle under a root: both nested", nested(h), ["A.md", "B.md"]);
}
{
  const h = build({ "A.md": ["B"], "B.md": ["C"], "C.md": ["A"] });
  eq("three in a circle: the first by path stays", nested(h), ["B.md", "C.md"]);
  eq("drawing stops at a note already above on the branch", childrenOnBranch(h, "C.md", new Set(["A.md", "B.md"])), []);
}
{
  // Board and Ideas come before Projects by name, but only Projects ↔ Roadmap is a circle.
  const h = build({ "Projects.md": ["Roadmap", "Ideas", "Board.canvas"], "Roadmap.md": ["Q1", "Projects"], "Q1.md": [], "Ideas.md": [] }, ["Board.canvas"]);
  eq("notes hanging off a circle nest under it", nested(h), ["Board.canvas", "Ideas.md", "Q1.md", "Roadmap.md"]);
}
{
  const h = build({ "A.md": ["B"], "B.md": ["A"], "C.md": ["D"], "D.md": ["C"] });
  eq("two separate circles each keep one", nested(h), ["B.md", "D.md"]);
}
{
  const h = build({ "A.md": ["B"], "B.md": [] }, ["Lone.md"]);
  eq("every note is reachable: nested ones have a parent, the rest are in the folder", nested(h), ["B.md"]);
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
