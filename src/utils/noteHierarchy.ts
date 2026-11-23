/**
 * The notes hierarchy: a note that links to other notes shows them nested under it.
 *
 * Rules:
 * - A note's children are the notes and canvases it links to, in the order the links appear.
 * - A child in the SAME folder as its parent is shown only under the parent, not again at its
 *   own place in the folder. A child in another folder stays in its folder and is also shown
 *   under the parent, so moving notes between folders never makes one disappear.
 * - A note linked from several notes in its folder appears under each of them.
 * - Links that go round in a circle (A → B → A) can't all be nested: one note of the circle stays
 *   in the folder and the rest hang under it. A row never repeats a note already above it.
 */

const norm = (p: string) => p.replace(/\\/g, "/");
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const stripExt = (p: string) => p.replace(/\.(md|canvas)$/i, "");

export interface NoteHierarchy {
  /** Note path → the notes it links to (resolved paths, no duplicates, never itself). */
  children: Map<string, string[]>;
  /** Notes shown only under a parent in their own folder, so left out of the folder listing. */
  nested: Set<string>;
}

/**
 * Finds the file a link points at, the same way the editor resolves links: an exact path, then a
 * path relative to the linking note's folder, then any note with that name (shortest path wins).
 */
export function makeResolver(files: string[]): (target: string, sourcePath: string) => string | null {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const raw of files) {
    const path = norm(raw);
    const key = path.toLowerCase();
    byPath.set(key, path);
    // A link without an extension means a note, so ".md" files also answer to the bare path.
    if (key.endsWith(".md")) byPath.set(key.slice(0, -3), byPath.get(key.slice(0, -3)) ?? path);
    const name = stripExt(path.split("/").pop()!).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const lookup = (p: string) => byPath.get(p.toLowerCase()) ?? null;

  return (target, sourcePath) => {
    const clean = norm(target).trim().replace(/^\.\//, "");
    if (!clean) return null;
    const exact = lookup(clean);
    if (exact) return exact;
    const dir = folderOf(norm(sourcePath));
    if (dir) {
      const relative = lookup(`${dir}/${clean}`);
      if (relative) return relative;
    }
    const candidates = byName.get(stripExt(clean.split("/").pop()!).toLowerCase());
    if (!candidates?.length) return null;
    return candidates.reduce((best, cur) => (cur.length < best.length ? cur : best));
  };
}

/**
 * @param files every note and canvas path (no folders)
 * @param linksOf the raw link targets written in a note, e.g. ["Ideas", "docs/Plan.md"]
 */
export function buildNoteHierarchy(files: string[], linksOf: (path: string) => string[]): NoteHierarchy {
  const paths = files.map(norm);
  const resolve = makeResolver(paths);
  const children = new Map<string, string[]>();

  for (const path of paths) {
    const out: string[] = [];
    for (const target of linksOf(path)) {
      const hit = resolve(target, path);
      if (hit && hit !== path && !out.includes(hit)) out.push(hit);
    }
    if (out.length) children.set(path, out);
  }

  // Nesting inside a folder: walk down from the notes nothing in the folder links to.
  const nested = new Set<string>();
  const byFolder = new Map<string, string[]>();
  for (const path of paths) byFolder.set(folderOf(path), [...(byFolder.get(folderOf(path)) ?? []), path]);

  for (const [folder, members] of byFolder) {
    const sameFolder = (p: string) => (children.get(p) ?? []).filter((c) => folderOf(c) === folder);
    const linked = new Set(members.flatMap(sameFolder));
    const reached = new Set<string>();
    const walk = (root: string) => {
      const stack = [root];
      reached.add(root);
      while (stack.length) {
        for (const c of sameFolder(stack.pop()!)) {
          if (reached.has(c)) continue;
          reached.add(c);
          nested.add(c);
          stack.push(c);
        }
      }
    };
    const ordered = [...members].sort();
    for (const p of ordered) if (!linked.has(p)) walk(p);
    // What's left hangs off circles of links (A → B → A → …). Keep in the folder the note that
    // leads to the most of them, which is always one of a circle nothing else points into, so
    // the notes it links to still nest under it. Ties go to the first by path.
    const reachFrom = (start: string) => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        for (const c of sameFolder(stack.pop()!)) {
          if (!seen.has(c) && !reached.has(c)) {
            seen.add(c);
            stack.push(c);
          }
        }
      }
      return seen.size;
    };
    for (;;) {
      const left = ordered.filter((p) => !reached.has(p));
      if (!left.length) break;
      let best = left[0];
      let bestReach = reachFrom(best);
      for (const p of left.slice(1)) {
        const r = reachFrom(p);
        if (r > bestReach) [best, bestReach] = [p, r];
      }
      walk(best);
    }
  }

  return { children, nested };
}

/** The children to draw under a note, leaving out any note already above it on this branch. */
export function childrenOnBranch(h: NoteHierarchy, path: string, ancestors: ReadonlySet<string>): string[] {
  return (h.children.get(path) ?? []).filter((c) => !ancestors.has(c));
}
