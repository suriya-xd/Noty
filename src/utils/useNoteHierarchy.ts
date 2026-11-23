import { useEffect, useMemo, useState } from "react";
import { VaultEntry } from "../types/noetic";
import { backlinksGraph } from "./wikilinks/backlinksGraph";
import { buildNoteHierarchy, NoteHierarchy } from "./noteHierarchy";

/** The notes hierarchy for the listed files, rebuilt as the links index fills in or changes. */
export function useNoteHierarchy(entries: VaultEntry[]): NoteHierarchy {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    // The index reports once per note while it loads; rebuild once per frame at most.
    let frame: number | null = null;
    const unsubscribe = backlinksGraph.subscribe(() => {
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          setVersion((v) => v + 1);
        });
      }
    });
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return useMemo(() => {
    const files = entries
      .filter((e) => !e.is_directory && (e.path.endsWith(".md") || e.path.endsWith(".canvas")))
      .map((e) => e.path);
    return buildNoteHierarchy(files, (p) => backlinksGraph.getForwardLinks(p).map((t) => t.target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, version]);
}
