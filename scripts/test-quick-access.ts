// A stand-in for the browser's localStorage, installed before the module is loaded.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const qa = await import("../src/utils/quickAccess");

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
const paths = () => qa.getQuickAccess().recent.map((r) => r.path);
const pins = () => qa.getQuickAccess().pins.map((p) => p.path);

console.log("\nrecent");
qa.setQuickAccessScope("/v", "Personal");
qa.recordOpened("A.md", false, 1);
qa.recordOpened("B.md", false, 2);
qa.recordOpened("A.md", false, 3);
eq("newest first, no repeats", paths(), ["A.md", "B.md"]);
for (let i = 0; i < 30; i++) qa.recordOpened(`n${i}.md`, false, 10 + i);
eq("keeps the last 20", paths().length, 20);
qa.recordOpened("", false);
eq("an empty path is ignored", paths()[0], "n29.md");

console.log("\npins");
qa.togglePin("Docs", true);
qa.togglePin("A.md", false);
eq("pinned in order", pins(), ["Docs", "A.md"]);
eq("isPinned", [qa.isPinned("A.md"), qa.isPinned("B.md")], [true, false]);
qa.togglePin("Docs", true);
eq("pinning again unpins", pins(), ["A.md"]);

console.log("\nworkspaces");
qa.setQuickAccessScope("/v", "Work");
eq("another workspace starts empty", [pins(), paths()], [[], []]);
qa.togglePin("W.md", false);
qa.setQuickAccessScope("/v", "Personal");
eq("switching back restores its pins", pins(), ["A.md"]);
eq("...saved on the device", JSON.parse(store.get("noetic.quickAccess./v::Work")!).pins[0].path, "W.md");

console.log("\nrenames and deletes");
qa.togglePin("Docs/Plan.md", false);
qa.togglePin("Docs", true);
qa.recordOpened("Docs/Plan.md", false, 100);
qa.renameInQuickAccess("Docs", "Archive/Docs");
eq("a folder rename moves its contents", pins(), ["A.md", "Archive/Docs/Plan.md", "Archive/Docs"]);
eq("...and recent items", paths()[0], "Archive/Docs/Plan.md");
qa.renameInQuickAccess("A.md", "A2.md");
eq("a note rename", pins()[0], "A2.md");
qa.renameInQuickAccess("Arch", "X");
eq("a name that only starts the same is left alone", pins()[2], "Archive/Docs");
qa.removeFromQuickAccess("Archive/Docs");
eq("deleting a folder forgets what was in it", [pins(), paths().includes("Archive/Docs/Plan.md")], [["A2.md"], false]);

console.log("\ndashboard");
{
  const exists = new Map<string, boolean>([["A2.md", false], ["n29.md", false], ["n28.md", false], ["Docs", true]]);
  eq("pins win", qa.dashboardItems(qa.getQuickAccess(), exists), { kind: "pinned", items: [{ path: "A2.md", isFolder: false }] });
  qa.togglePin("A2.md", false);
  const recent = qa.dashboardItems(qa.getQuickAccess(), exists, 2);
  eq("no pins: recent, only what still exists, up to the limit", [recent.kind, recent.items.map((i) => i.path)], ["recent", ["n29.md", "n28.md"]]);
  qa.togglePin("Gone.md", false);
  eq("a pin whose file is gone doesn't count", qa.dashboardItems(qa.getQuickAccess(), exists, 1).kind, "recent");
  qa.togglePin("Docs", false);
  eq("a folder pinned as a note doesn't match", qa.dashboardItems(qa.getQuickAccess(), exists, 1).kind, "recent");
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
