import { VaultFileMeta } from "./types";

export class VaultIndex {
  // Map normalized base filename (lowercase, no extension) -> array of matching entries
  private byBaseName = new Map<string, VaultFileMeta[]>();
  // Map normalized relative path (lowercase) -> single entry
  private byPath = new Map<string, VaultFileMeta>();

  private subscribers = new Set<() => void>();

  /**
   * Re-indexes the vault from relative file paths (e.g. from gitVaultBridge.listVaultFiles)
   */
  public reindex(filePaths: string[]): void {
    this.byBaseName.clear();
    this.byPath.clear();

    for (const filePath of filePaths) {
      if (!filePath.endsWith(".md")) continue;
      this.addOrUpdate(filePath, false);
    }

    this.notifySubscribers();
  }

  public addOrUpdate(filePath: string, notify = true): void {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const segments = normalizedPath.split("/");
    const fileName = segments[segments.length - 1];
    const baseName = fileName.replace(/\.md$/i, "");

    const meta: VaultFileMeta = {
      path: normalizedPath,
      baseName,
      extension: "md",
    };

    const normPathKey = normalizedPath.toLowerCase();
    const normBaseKey = baseName.toLowerCase();

    this.byPath.set(normPathKey, meta);

    const existing = this.byBaseName.get(normBaseKey) || [];
    const filtered = existing.filter((f) => f.path.toLowerCase() !== normPathKey);
    this.byBaseName.set(normBaseKey, [...filtered, meta]);

    if (notify) this.notifySubscribers();
  }

  public remove(filePath: string): void {
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    const meta = this.byPath.get(normalizedPath);
    if (!meta) return;

    this.byPath.delete(normalizedPath);

    const normBaseKey = meta.baseName.toLowerCase();
    const list = this.byBaseName.get(normBaseKey) || [];
    const remaining = list.filter((f) => f.path.toLowerCase() !== normalizedPath);

    if (remaining.length === 0) {
      this.byBaseName.delete(normBaseKey);
    } else {
      this.byBaseName.set(normBaseKey, remaining);
    }

    this.notifySubscribers();
  }

  /**
   * Resolves target wikilink to an actual file.
   * Supports:
   * - Base filename: "ProjectPlan" -> "work/ProjectPlan.md"
   * - Relative path: "sub/Note" -> "docs/sub/Note.md"
   * - Folder-relative proximity: if sourcePath is "docs/a.md", prefers "docs/target.md"
   */
  public resolve(target: string, sourcePath?: string): VaultFileMeta | null {
    if (!target) return null;

    let cleanTarget = target.replace(/\\/g, "/").trim();
    if (cleanTarget.endsWith(".md")) {
      cleanTarget = cleanTarget.slice(0, -3);
    }

    // 1. Exact path match
    const exactPathKey = `${cleanTarget}.md`.toLowerCase();
    if (this.byPath.has(exactPathKey)) {
      return this.byPath.get(exactPathKey)!;
    }

    // 2. Folder proximity check if sourcePath is provided
    if (sourcePath) {
      const sourceDir = sourcePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      const relativeTarget = sourceDir ? `${sourceDir}/${cleanTarget}.md`.toLowerCase() : exactPathKey;
      if (this.byPath.has(relativeTarget)) {
        return this.byPath.get(relativeTarget)!;
      }
    }

    // 3. Base filename match
    const baseNameKey = (cleanTarget.split("/").pop() || cleanTarget).toLowerCase();
    const candidates = this.byBaseName.get(baseNameKey);

    if (!candidates || candidates.length === 0) return null;

    // If multiple matches, prioritize shortest path (root note takes precedence)
    return candidates.reduce((best, curr) => (curr.path.length < best.path.length ? curr : best));
  }

  public getAllBaseNames(): string[] {
    return Array.from(this.byBaseName.values())
      .flat()
      .map((m) => m.baseName);
  }

  public getAllEntries(): VaultFileMeta[] {
    return Array.from(this.byPath.values());
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notifySubscribers() {
    this.subscribers.forEach((cb) => cb());
  }
}

// Global Singleton for instant lookup across all components and background routines
export const vaultIndex = new VaultIndex();
