import {
  baseNameOf,
  fileNameFromTitle,
  pathForName,
} from "../src/utils/noteTitle";

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

console.log("\nfileNameFromTitle");
eq("plain", fileNameFromTitle("Running"), "Running");
eq("illegal characters removed", fileNameFromTitle('Notes: Day 1 / "Draft"?'), "Notes Day 1 Draft");
eq("wikilink characters removed", fileNameFromTitle("See [[Foo#bar|baz]]"), "See Foobarbaz");
eq("whitespace collapsed", fileNameFromTitle("  a   b  "), "a b");
eq("leading and trailing dots dropped", fileNameFromTitle("..Hidden.."), "Hidden");
eq("nothing usable", fileNameFromTitle("???"), "");
eq("length capped", fileNameFromTitle("x".repeat(500)).length, 120);

console.log("\npaths");
eq("baseNameOf nested", baseNameOf("Projects/Plan.md"), "Plan");
eq("baseNameOf root", baseNameOf("Plan.md"), "Plan");
eq("pathForName nested", pathForName("Projects/Plan.md", "New"), "Projects/New.md");
eq("pathForName root", pathForName("Plan.md", "New"), "New.md");

if (failures > 0) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll note-title tests passed\n");
