// End-to-end check of the workspace flow, run against the dev server's backend (vite-noetic-plugin)
// with throwaway folders and a local stand-in for the account's notes repository.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "noetic-workspaces-"));
const origin = path.join(root, "origin.git");
const REMOTE = "https://noetic.test/notes.git";
execFileSync("git", ["init", "-q", "--bare", origin]);

// Point the fake https address at the local stand-in, and keep the machine's own git settings out.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
  GIT_CONFIG_VALUE_0: REMOTE,
  GIT_CONFIG_KEY_1: "init.defaultBranch",
  GIT_CONFIG_VALUE_1: "master",
});
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "");

const { noeticPlugin } = await import("../vite-noetic-plugin");

type Handler = (req: any, res: any, next: () => void) => Promise<void>;
let handler: Handler | undefined;
(noeticPlugin() as any).configureServer({ middlewares: { use: (h: Handler) => (handler = h) } });

async function call<T = any>(cmd: string, body: Record<string, unknown>): Promise<T> {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.url = `/api/noetic/${cmd}`;
  req.method = "POST";
  req.headers = {};
  return new Promise<T>((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      setHeader() {},
      end(text: string) {
        const data = JSON.parse(text);
        if (res.statusCode >= 400) reject(new Error(data.error));
        else resolve(data);
      },
    };
    handler!(req, res, () => reject(new Error("not handled"))).catch(reject);
  });
}

let failures = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
};
const fails = async (name: string, p: Promise<unknown>) => {
  const failed = await p.then(() => false, () => true);
  eq(name, failed, true);
};
const files = (dir: string) => fs.readdirSync(dir).filter((n) => n !== ".git").sort();
const inOrigin = (...args: string[]) => execFileSync("git", ["-C", origin, ...args]).toString().trim();
const device = (name: string) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
};
const connect = (dir: string) =>
  call("connect_vault", { vault_path: dir, remote_url: REMOTE, user_name: "T", user_email: "t@noetic.test" });

console.log("first device");
const a = device("a");
await call("init_or_open_vault", { vault_path: a });
eq("a new notes folder starts empty", files(a), []);
fs.writeFileSync(path.join(a, "Old.md"), "written before signing in");
eq("setup finds no workspaces", await connect(a), { current: null, workspaces: [] });
eq("main exists and is empty", inOrigin("ls-tree", "--name-only", "main"), "");
eq("no workspace is open yet", (await call("get_repo_status", { repo_path: a })).branch, "");
await fails("saving needs a workspace", call("save_and_push", { repo_path: a }));
await fails("main is reserved", call("create_workspace", { repo_path: a, name: "main" }));
await fails("a name is required", call("create_workspace", { repo_path: a, name: "  " }));
await fails("slashes are refused", call("create_workspace", { repo_path: a, name: "a/b" }));

let st = await call("create_workspace", { repo_path: a, name: "Work Notes" });
eq("spaces become dashes", st.branch, "Work-Notes");
eq("first workspace is saved and uploaded", st.state, "CleanSynced");
eq("existing notes moved into it", inOrigin("ls-tree", "--name-only", "Work-Notes"), "Old.md");
eq("main is still empty", inOrigin("ls-tree", "--name-only", "main"), "");
await fails("names are unique ignoring case", call("create_workspace", { repo_path: a, name: "work notes" }));

console.log("second workspace");
fs.writeFileSync(path.join(a, "Unsaved.md"), "x");
fs.mkdirSync(path.join(a, "empty-folder"));
st = await call("create_workspace", { repo_path: a, name: "personal" });
eq("a later workspace starts blank", files(a), []);
eq("and is uploaded", st.state, "CleanSynced");
fs.writeFileSync(path.join(a, "P.md"), "p");
st = await call("switch_workspace", { repo_path: a, name: "Work-Notes" });
eq("switching brings that workspace's notes back", files(a), ["Old.md", "Unsaved.md"]);
eq("nothing is left unsaved", st.dirty_count, 0);
await call("switch_workspace", { repo_path: a, name: "personal" });
eq("edits were saved before leaving", files(a), ["P.md"]);
eq("both are listed", await call("list_workspaces", { repo_path: a, refresh: true }), {
  current: "personal",
  workspaces: ["personal", "Work-Notes"],
});

console.log("second device");
const b = device("b");
await call("init_or_open_vault", { vault_path: b });
eq("setup finds the workspaces", await connect(b), { current: null, workspaces: ["personal", "Work-Notes"] });
st = await call("switch_workspace", { repo_path: b, name: "personal" });
eq("opening one brings its notes", files(b), ["P.md"]);
fs.writeFileSync(path.join(b, "FromB.md"), "b");
st = await call("save_and_push", { repo_path: b });
eq("save uploads", st.state, "CleanSynced");
st = await call("fetch_remote", { repo_path: a });
eq("the first device sees one update", st.behind_count, 1);
fs.writeFileSync(path.join(a, "Dirty.md"), "d");
await fails("unsaved changes plus waiting updates blocks switching", call("switch_workspace", { repo_path: a, name: "Work-Notes" }));
eq("sync succeeds", (await call("sync_and_pull", { repo_path: a })).success, true);
eq("sync brought the note and kept the edit", files(a), ["Dirty.md", "FromB.md", "P.md"]);

console.log("name clash on a device with unsynced notes");
const c = device("c");
await call("init_or_open_vault", { vault_path: c });
fs.writeFileSync(path.join(c, "P.md"), "different");
await connect(c);
await fails("opening is refused", call("switch_workspace", { repo_path: c, name: "personal" }));
eq("the local note is untouched", fs.readFileSync(path.join(c, "P.md"), "utf-8"), "different");

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll workspace checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
