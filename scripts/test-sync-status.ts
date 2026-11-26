import assert from "node:assert/strict";
import { describeSync, failingForADay, problemFrom } from "../src/utils/syncStatus";
import type { RepoStatusPayload } from "../src/types/noetic";

const file = (not_uploaded: boolean) => ({ path: "a.md", is_modified: false, is_untracked: false, has_remote_update: false, not_uploaded });
const status = (over: Partial<RepoStatusPayload> = {}): RepoStatusPayload => ({
  state: "CleanSynced", dirty_count: 0, behind_count: 0, ahead_count: 0, has_conflict: false,
  branch: "w", remote_name: "origin", remote_url: "u", files: [], ...over,
});
const offline = problemFrom("Couldn't reach your cloud storage: x", false, null, 0);
const signIn = problemFrom("Couldn't reach your cloud storage: 401", true, offline, 5);

assert.equal(offline.kind, "offline");
assert.equal(signIn.kind, "sign-in");
assert.equal(signIn.since, 0, "keeps the time of the first failure");
assert.equal(problemFrom("disk full", false, null).kind, "other");
assert.equal(failingForADay(offline, 1000), false);
assert.equal(failingForADay(offline, 24 * 3600 * 1000), true);

assert.equal(describeSync(status(), null).kind, "synced");
assert.equal(describeSync(status({ remote_url: null }), signIn).kind, "signed-out");
assert.equal(describeSync(status({ files: [file(true), file(false)] }), null).label, "Not uploaded (1)");
assert.equal(describeSync(status({ behind_count: 2 }), null).kind, "updates");
assert.equal(describeSync(status({ has_conflict: true }), offline).kind, "conflict");
assert.equal(describeSync(status({ has_conflict: true }), signIn).kind, "sign-in");
assert.match(describeSync(status({ files: [file(true)] }), offline, 24 * 3600 * 1000).detail, /over a day/);
assert.doesNotMatch(describeSync(status({ files: [file(true)] }), offline, 1000).detail, /over a day/);
console.log("All sync status checks passed.");
