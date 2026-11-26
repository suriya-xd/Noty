import type { RepoStatusPayload } from "../types/noetic";

/** Why the last sync didn't get through, and since when. */
export interface SyncProblem {
  kind: "offline" | "sign-in" | "other";
  message: string;
  since: number;
}

export type SyncKind = "signed-out" | "sign-in" | "conflict" | "offline" | "waiting" | "updates" | "synced";

export interface SyncDescription {
  kind: SyncKind;
  label: string;
  headline: string;
  detail: string;
}

const DAY = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "noetic_sync_problem";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `signInRefused` comes from the GitHub service, which knows the wording of those errors. */
export function problemFrom(
  message: string,
  signInRefused: boolean,
  previous: SyncProblem | null,
  now = Date.now()
): SyncProblem {
  const kind = signInRefused ? "sign-in" : /couldn't (reach|connect)/i.test(message) ? "offline" : "other";
  return { kind, message, since: previous?.since ?? now };
}

export const failingForADay = (problem: SyncProblem | null, now = Date.now()): boolean =>
  !!problem && now - problem.since >= DAY;

/** Kept across restarts, so "failing for a day" means a day and not one session. */
export function loadProblem(): SyncProblem | null {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return p && typeof p.since === "number" && typeof p.kind === "string" ? p : null;
  } catch {
    return null;
  }
}

export function storeProblem(problem: SyncProblem | null): void {
  try {
    if (problem) localStorage.setItem(STORAGE_KEY, JSON.stringify(problem));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** The one thing to tell the user about syncing. The most urgent wins. */
export function describeSync(
  status: RepoStatusPayload | null,
  problem: SyncProblem | null,
  now = Date.now()
): SyncDescription {
  if (status && !status.remote_url) {
    return {
      kind: "signed-out",
      label: "This device only",
      headline: "Not signed in",
      detail: "Your notes are saved on this device only. Sign in to back them up and sync across devices.",
    };
  }
  const waiting = (status?.files ?? []).filter((f) => f.not_uploaded).length;
  const overdue =
    failingForADay(problem, now) && waiting > 0 ? " They have not been uploaded for over a day." : "";
  const kept = waiting > 0 ? ` ${plural(waiting, "changed file")} kept on this device.${overdue}` : "";

  if (problem?.kind === "sign-in") {
    return {
      kind: "sign-in",
      label: "Sign in needed",
      headline: "Sign in again to keep syncing",
      detail: `GitHub no longer accepts the saved sign-in.${kept}`,
    };
  }
  if (status?.has_conflict) {
    return {
      kind: "conflict",
      label: "Conflict",
      headline: "Choose which version to keep",
      detail: `A note changed here and on another device. Sync to choose.${kept}`,
    };
  }
  if (problem?.kind === "offline") {
    return {
      kind: "offline",
      label: waiting > 0 ? `Offline (${waiting})` : "Offline",
      headline: "Couldn't reach your backup",
      detail: `Check your connection, then sync.${kept}`,
    };
  }
  if (waiting > 0 || (status?.ahead_count ?? 0) > 0) {
    return {
      kind: "waiting",
      label: waiting > 0 ? `Not uploaded (${waiting})` : "Not uploaded",
      headline: waiting > 0 ? `${plural(waiting, "file")} not uploaded` : "Changes not uploaded",
      detail: problem
        ? `The last sync failed: ${problem.message}${overdue}`
        : "Changes are on this device. Sync to back them up and send them to your other devices.",
    };
  }
  if ((status?.behind_count ?? 0) > 0) {
    const n = status!.behind_count;
    return {
      kind: "updates",
      label: `Updates (${n})`,
      headline: `${plural(n, "update")} available`,
      detail: "Changes from your other devices are waiting. Sync to get them.",
    };
  }
  return {
    kind: "synced",
    label: "Synced",
    headline: "Everything is up to date",
    detail: "Nothing on this device is waiting to upload.",
  };
}
