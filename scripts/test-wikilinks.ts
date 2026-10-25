import { parseWikiLink, extractWikiLinks, transformWikiLinksToMarkdown } from "../src/utils/wikilinks/wikilinkParser";
import { VaultIndex } from "../src/utils/wikilinks/vaultIndex";
import { BacklinksAdjacencyList } from "../src/utils/wikilinks/backlinksGraph";
import { renameFileWithWikilinks } from "../src/utils/wikilinks/refactorLinks";

async function runTests() {
  console.log("\n==========================================");
  console.log("   Obsidian Wikilink System Test Suite    ");
  console.log("==========================================\n");

  // 1. Regex Parsing & Tokenization
  console.log("[1/5] Testing Regex Parsing & Tokenization...");
  const t1 = parseWikiLink("[[My Note#Section Title|Custom Label]]");
  console.log("  Parsed link with header & alias:", t1);
  if (
    t1?.target !== "My Note" ||
    t1?.header !== "Section Title" ||
    t1?.alias !== "Custom Label" ||
    t1?.displayText !== "Custom Label"
  ) {
    throw new Error("Failed to parse link with header and alias");
  }

  const t2 = parseWikiLink("[[SimpleNote]]");
  console.log("  Parsed simple link:", t2);
  if (t2?.target !== "SimpleNote" || t2?.displayText !== "SimpleNote") {
    throw new Error("Failed to parse simple link");
  }

  const t3 = parseWikiLink("[[Note#Header]]");
  console.log("  Parsed link with heading only:", t3);
  if (t3?.header !== "Header" || t3?.displayText !== "Note > Header") {
    throw new Error("Failed to parse link with heading only");
  }

  // 2. Code Block Isolation & Transformer
  console.log("\n[2/5] Testing Code Fence Isolation & Markdown Transformer...");
  const sampleMd = `
# Sample
Check [[NoteA#Section|Note A]] and inline code \`[[NotALink]]\`.
\`\`\`
[[AlsoNotALink]]
\`\`\`
And another [[sub/NoteB]].
`;
  const extracted = extractWikiLinks(sampleMd);
  console.log(`  Extracted tokens count: ${extracted.length} (Expected: 2)`);
  if (extracted.length !== 2) {
    throw new Error(`Expected 2 extracted tokens, got ${extracted.length}`);
  }

  const transformed = transformWikiLinksToMarkdown("See [[NoteA#Heading|Alias]] and [[NoteB]]");
  console.log("  Transformed Markdown URI:", transformed);
  if (!transformed.includes("[Alias](wikilink:NoteA?header=Heading)")) {
    throw new Error("Markdown transformer failed");
  }

  // 3. In-Memory Vault Index
  console.log("\n[3/5] Testing In-Memory Vault Index...");
  const idx = new VaultIndex();
  idx.reindex(["docs/Alpha.md", "work/Beta.md", "Archive/old.md"]);

  const res1 = idx.resolve("alpha");
  console.log("  Case-insensitive resolve 'alpha' ->", res1?.path);
  if (res1?.path !== "docs/Alpha.md") throw new Error("Vault index case-insensitive resolve failed");

  const res2 = idx.resolve("work/Beta.md");
  console.log("  Exact path resolve 'work/Beta.md' ->", res2?.path);
  if (res2?.path !== "work/Beta.md") throw new Error("Vault index exact path match failed");

  const resGhost = idx.resolve("GhostNote");
  console.log("  Unresolved note resolve 'GhostNote' ->", resGhost);
  if (resGhost !== null) throw new Error("Vault index should return null for ghost note");

  // 4. Backlinks Adjacency List
  console.log("\n[4/5] Testing Backlinks Adjacency List & Snippets...");
  const graph = new BacklinksAdjacencyList();
  graph.updateFileLinks("Daily/Today.md", "Discussing [[Alpha#Roadmap|Our Plan]] and [[Beta]].");

  const backlinksAlpha = graph.getBacklinks("Alpha");
  console.log(`  Incoming backlinks to 'Alpha': ${backlinksAlpha.length}`);
  console.log("  Snippet excerpt:", backlinksAlpha[0]?.contextSnippet);
  if (backlinksAlpha.length !== 1 || backlinksAlpha[0].sourceBaseName !== "Today") {
    throw new Error("Backlinks graph failed for Alpha");
  }

  // 5. Automated Link Refactoring on Rename
  console.log("\n[5/5] Testing Automated Link Refactoring on File Rename...");
  const virtualFiles: Record<string, string> = {
    "Daily/Today.md": "Discussing [[Alpha#Roadmap|Our Plan]] and [[Alpha]] today.",
    "projects/Project.md": "Reference to [[Alpha#Roadmap]].",
    "docs/Alpha.md": "# Alpha Documentation",
  };

  const fsAdapter = {
    readFile: async (p: string) => virtualFiles[p] || "",
    writeFile: async (p: string, c: string) => {
      virtualFiles[p] = c;
    },
    renameFile: async (o: string, n: string) => {
      virtualFiles[n] = virtualFiles[o];
      delete virtualFiles[o];
    },
  };

  idx.reindex(Object.keys(virtualFiles));
  graph.updateFileLinks("Daily/Today.md", virtualFiles["Daily/Today.md"]);
  graph.updateFileLinks("projects/Project.md", virtualFiles["projects/Project.md"]);

  const refactorResult = await renameFileWithWikilinks(
    "docs/Alpha.md",
    "docs/Gamma.md",
    fsAdapter,
    graph,
    idx
  );
  console.log("  Refactor summary:", refactorResult);
  console.log("  Updated Daily/Today.md:", virtualFiles["Daily/Today.md"]);
  console.log("  Updated projects/Project.md:", virtualFiles["projects/Project.md"]);

  if (!virtualFiles["Daily/Today.md"].includes("[[Gamma#Roadmap|Our Plan]]")) {
    throw new Error("Header and alias preservation failed in Today.md");
  }
  if (!virtualFiles["Daily/Today.md"].includes("[[Gamma]]")) {
    throw new Error("Base link refactoring failed in Today.md");
  }
  if (!virtualFiles["projects/Project.md"].includes("[[Gamma#Roadmap]]")) {
    throw new Error("Header preservation failed in Project.md");
  }
  if (virtualFiles["docs/Alpha.md"] !== undefined || virtualFiles["docs/Gamma.md"] === undefined) {
    throw new Error("File rename on disk failed");
  }

  console.log("\n>>> ALL 5 CORE MECHANICS PASSED 100% SUCCESSFULLY! <<<\n");
}

runTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
