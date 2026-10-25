import { BacklinkEntry, WikiLinkToken } from "./types";
import { extractWikiLinks } from "./wikilinkParser";

export class BacklinksAdjacencyList {
  // Forward links: normalized sourcePath -> Array of extracted tokens
  private forwardLinks = new Map<string, WikiLinkToken[]>();

  // Backlinks: normalized targetBaseName -> Map<sourcePath, BacklinkEntry[]>
  private backlinkMap = new Map<string, Map<string, BacklinkEntry[]>>();

  private subscribers = new Set<() => void>();

  /**
   * Updates graph edges when a file is modified or parsed
   */
  public updateFileLinks(sourcePath: string, content: string): void {
    const normSource = sourcePath.replace(/\\/g, "/");
    this.removeFileLinks(normSource, false);

    let tokens: WikiLinkToken[] = [];
    if (normSource.endsWith(".canvas")) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.nodes)) {
          for (const node of parsed.nodes) {
            if (node.type === "file" && typeof node.file === "string" && node.file.trim()) {
              tokens.push({
                raw: `[[${node.file}]]`,
                target: node.file,
                displayText: `Canvas node: ${node.file}`,
                index: 0,
              });
            } else if (node.type === "text" && typeof node.text === "string") {
              tokens.push(...extractWikiLinks(node.text));
            }
          }
        }
      } catch {}
    } else {
      tokens = extractWikiLinks(content);
    }

    this.forwardLinks.set(normSource, tokens);

    const lines = content.split("\n");

    for (const token of tokens) {
      const targetBase = token.target.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();

      // Find line number and excerpt snippet
      let lineNumber = 1;
      let lineText = "";
      if (token.index !== undefined) {
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1; // +1 for newline
          if (charCount > token.index) {
            lineNumber = i + 1;
            lineText = lines[i].trim();
            break;
          }
        }
      }

      const sourceBaseName = normSource.split("/").pop()!.replace(/\.md$/i, "");
      const entry: BacklinkEntry = {
        sourcePath: normSource,
        sourceBaseName,
        token,
        lineNumber,
        contextSnippet: lineText || token.raw,
      };

      if (!this.backlinkMap.has(targetBase)) {
        this.backlinkMap.set(targetBase, new Map());
      }
      const fileMap = this.backlinkMap.get(targetBase)!;
      const existing = fileMap.get(normSource) || [];
      fileMap.set(normSource, [...existing, entry]);
    }

    this.notify();
  }

  /**
   * Removes all outgoing links when a file is deleted or before re-indexing
   */
  public removeFileLinks(sourcePath: string, notify = true): void {
    const normSource = sourcePath.replace(/\\/g, "/");
    const oldTokens = this.forwardLinks.get(normSource);

    if (oldTokens) {
      for (const token of oldTokens) {
        const targetBase = token.target.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
        const fileMap = this.backlinkMap.get(targetBase);
        if (fileMap) {
          fileMap.delete(normSource);
          if (fileMap.size === 0) {
            this.backlinkMap.delete(targetBase);
          }
        }
      }
      this.forwardLinks.delete(normSource);
    }

    if (notify) this.notify();
  }

  /**
   * Returns all notes that link back to the target note
   */
  public getBacklinks(targetFileNameOrPath: string): BacklinkEntry[] {
    const baseName = targetFileNameOrPath
      .replace(/\\/g, "/")
      .split("/")
      .pop()!
      .replace(/\.md$/i, "")
      .toLowerCase();

    const fileMap = this.backlinkMap.get(baseName);
    if (!fileMap) return [];

    const results: BacklinkEntry[] = [];
    for (const entries of fileMap.values()) {
      results.push(...entries);
    }
    return results;
  }

  /**
   * Returns all outgoing wikilinks originating from a specific file
   */
  public getForwardLinks(sourcePath: string): WikiLinkToken[] {
    const normSource = sourcePath.replace(/\\/g, "/");
    return this.forwardLinks.get(normSource) || [];
  }

  public subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify() {
    this.subscribers.forEach((cb) => cb());
  }
}

export const backlinksGraph = new BacklinksAdjacencyList();
