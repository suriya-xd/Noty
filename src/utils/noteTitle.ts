/**
 * A note's title is its file name, shown as an editable inline title above the text (see
 * components/inlineTitle.ts). These helpers map a typed title to a legal file name and path.
 * Pure functions, no UI or filesystem.
 */

const MAX_NAME_LENGTH = 120;

/**
 * The file name (without extension) a title maps to. Characters a file name can't hold, or that
 * would break `[[wikilinks]]`, are dropped. Returns "" when nothing usable is left.
 */
export function fileNameFromTitle(title: string): string {
  return title
    .replace(/[\\/:*?"<>|[\]#^\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** "Projects/Plan.md" -> "Plan". */
export function baseNameOf(path: string): string {
  return (path.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.md$/i, "");
}

/** The path of the note at `path` after it is renamed to `name`, keeping its folder. */
export function pathForName(path: string, name: string): string {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return `${slash >= 0 ? norm.slice(0, slash + 1) : ""}${name}.md`;
}
