import { findLinksInLine, linkMarkdown, normalizeUrl } from "../src/components/editorCommands";

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
const urls = (t: string) => findLinksInLine(t).map((l) => [l.text, l.url, t.slice(l.from, l.to)]);

console.log("\nfinding links");
eq("markdown link", urls("see [the docs](https://x.com/a) now"), [["the docs", "https://x.com/a", "[the docs](https://x.com/a)"]]);
eq("bare address, trailing period left out", urls("go to https://x.com/a."), [["", "https://x.com/a", "https://x.com/a"]]);
eq("autolink", urls("<https://x.com>"), [["", "https://x.com", "<https://x.com>"]]);
eq("images are not links", urls("![pic](assets/a.png)"), []);
eq("wikilinks are not web links", urls("[[Note]]"), []);
eq("escaped brackets in text", urls("[a \\[b\\]](https://x.com)"), [["a [b]", "https://x.com", "[a \\[b\\]](https://x.com)"]]);
eq("address inside a markdown link isn't found twice", urls("[https://x.com](https://x.com)").length, 1);

console.log("\nwriting links");
eq("shown as the address", linkMarkdown("https://x.com", null), "https://x.com");
eq("shown as text", linkMarkdown("https://x.com", "Site"), "[Site](https://x.com)");
eq("text equal to the address shows the address", linkMarkdown("https://x.com", "https://x.com"), "https://x.com");
eq("mailto is wrapped so it stays a link", linkMarkdown("mailto:a@b.co", null), "<mailto:a@b.co>");
eq("brackets in text are escaped", linkMarkdown("https://x.com", "a [b]"), "[a \\[b\\]](https://x.com)");
eq("spaces and parens in the address are encoded", linkMarkdown("https://x.com/a b(c)", "t"), "[t](https://x.com/a%20b%28c%29)");
eq("round trip", urls(linkMarkdown("https://x.com", "a [b]"))[0].slice(0, 2), ["a [b]", "https://x.com"]);

console.log("\nnormalising addresses");
eq("adds https", normalizeUrl("example.com/x"), "https://example.com/x");
eq("keeps a scheme", normalizeUrl(" http://a.b "), "http://a.b");
eq("email becomes mailto", normalizeUrl("me@site.org"), "mailto:me@site.org");

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll link tests passed\n");
