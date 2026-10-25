import { backlinksGraph, BacklinksAdjacencyList } from "./backlinksGraph";
import { vaultIndex, VaultIndex } from "./vaultIndex";
import { FileSystemAdapter, RefactorResult } from "./types";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renames a file across the vault and refactors all incoming [[wikilinks]].
 * Preserves optional directory prefixes, headers (#Header), and aliases (|Alias).
 */
export async function renameFileWithWikilinks(
  oldPath: string,
  newPath: string,
  fs: FileSystemAdapter,
  graph: BacklinksAdjacencyList = backlinksGraph,
  index: VaultIndex = vaultIndex
): Promise<RefactorResult> {
  const normOldPath = oldPath.replace(/\\/g, "/");
  const normNewPath = newPath.replace(/\\/g, "/");

  const oldBaseName = normOldPath.split("/").pop()!.replace(/\.md$/i, "");
  const newBaseName = normNewPath.split("/").pop()!.replace(/\.md$/i, "");

  // 1. Query the adjacency list for all files containing links to the old name
  const backlinks = graph.getBacklinks(oldBaseName);
  const uniqueReferringFiles = Array.from(new Set(backlinks.map((b) => b.sourcePath)));

  // Regex matches: [[(optional/folder/)OldName(#OptionalHeader)?(|OptionalAlias)?]]
  const escapedOld = escapeRegex(oldBaseName);
  const refactorRegex = new RegExp(
    `\\[\\[([^[#|\\]\\r\\n]*\\/)?${escapedOld}(#[^[|\\]\\r\\n]+)?(\\|[^[\\]\\r\\n]+)?\\]\\]`,
    "g"
  );

  let totalLinksUpdated = 0;
  const modifiedFiles: string[] = [];

  // 2. Perform string replacement in all referring files
  for (const refPath of uniqueReferringFiles) {
    if (refPath === normOldPath) continue; // Skip renaming inside the file itself if self-referencing

    try {
      const originalContent = await fs.readFile(refPath);
      let fileModCount = 0;

      const updatedContent = originalContent.replace(
        refactorRegex,
        (_match, folderPrefix = "", header = "", alias = "") => {
          fileModCount++;
          return `[[${folderPrefix}${newBaseName}${header}${alias}]]`;
        }
      );

      if (fileModCount > 0) {
        totalLinksUpdated += fileModCount;
        await fs.writeFile(refPath, updatedContent);
        modifiedFiles.push(refPath);

        // Update in-memory graph for the modified file
        graph.updateFileLinks(refPath, updatedContent);
      }
    } catch (err) {
      console.error(`Failed to update wikilinks in ${refPath}:`, err);
    }
  }

  // 3. Rename the source file itself on disk
  await fs.renameFile(normOldPath, normNewPath);

  // 4. Update the vault index
  index.remove(normOldPath);
  index.addOrUpdate(normNewPath);

  // 5. Transfer forward links for the newly renamed file
  const selfLinks = graph.getForwardLinks(normOldPath);
  graph.removeFileLinks(normOldPath, false);
  if (selfLinks.length > 0) {
    try {
      const newContent = await fs.readFile(normNewPath);
      graph.updateFileLinks(normNewPath, newContent);
    } catch (err) {
      console.error(`Failed to re-parse forward links in renamed file ${normNewPath}:`, err);
    }
  }

  return {
    renamed: { from: normOldPath, to: normNewPath },
    affectedFiles: modifiedFiles,
    totalLinksUpdated,
  };
}
