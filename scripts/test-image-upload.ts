import { assetPathFor, altTextFor, imageFromDataTransfer } from "../src/utils/imageUpload";

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
const file = (name: string, type = "image/png") => new File([new Uint8Array([1])], name, { type });
const when = new Date(2026, 10, 15, 9, 5, 7);

console.log("\nassetPathFor");
eq("keeps a real name", assetPathFor(file("diagram.png"), [], when), "assets/diagram.png");
eq("pasted images get a dated name", assetPathFor(file("image.png"), [], when), "assets/pasted-2026-11-15-090507.png");
eq("two pastes in the same second don't overwrite", assetPathFor(file("image.png"), ["assets/pasted-2026-11-15-090507.png"], when), "assets/pasted-2026-11-15-090507-2.png");
eq("a taken name gets a number", assetPathFor(file("a.jpg"), ["assets/a.jpg", "assets/A-2.jpg"], when), "assets/a-3.jpg");
eq("extension from the type when missing", assetPathFor(file("blob", "image/webp"), [], when), "assets/pasted-2026-11-15-090507.webp");
eq("unsafe characters are replaced", assetPathFor(file("my photo (1).PNG"), [], when), "assets/my_photo__1.png");
eq("alt text for pasted images", altTextFor(file("image.png")), "Image");
eq("alt text from a real name", altTextFor(file("diagram.png")), "diagram");

console.log("\nimageFromDataTransfer");
const png = file("x.png");
const fakeDt = (items: any[], files: File[] = []) => ({ items, files }) as unknown as DataTransfer;
eq("finds an image item", imageFromDataTransfer(fakeDt([{ kind: "file", type: "image/png", getAsFile: () => png }]))?.name, "x.png");
eq("falls back to files", imageFromDataTransfer(fakeDt([], [png]))?.name, "x.png");
eq("ignores text", imageFromDataTransfer(fakeDt([{ kind: "string", type: "text/plain", getAsFile: () => null }])), null);

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll image-upload tests passed\n");
