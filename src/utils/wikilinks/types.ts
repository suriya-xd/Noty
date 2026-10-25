export interface WikiLinkToken {
  raw: string;          // e.g. "[[Architecture#Data Layer|System Core]]"
  target: string;       // e.g. "Architecture" or "docs/Architecture"
  header?: string;      // e.g. "Data Layer"
  alias?: string;       // e.g. "System Core"
  displayText: string;  // e.g. "System Core", or "Architecture > Data Layer"
  index?: number;       // Character offset in source content
}

export interface VaultFileMeta {
  path: string;         // Relative path (e.g. "docs/Architecture.md")
  baseName: string;     // Without extension (e.g. "Architecture")
  extension: string;    // e.g. "md"
  modifiedMs?: number;
}

export interface BacklinkEntry {
  sourcePath: string;       // File containing the link (e.g. "Daily/2026-10-25.md")
  sourceBaseName: string;   // e.g. "2026-10-25"
  token: WikiLinkToken;
  lineNumber: number;
  contextSnippet: string;   // Surrounding line excerpt for UI preview
}

export interface FileSystemAdapter {
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
}

export interface RefactorResult {
  renamed: { from: string; to: string };
  affectedFiles: string[];
  totalLinksUpdated: number;
}
