import type { Plugin } from "vite";
import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

/**
 * Runs git with an argument list. Nothing is passed through a shell, so values that came from a
 * request (remote URL, branch, name, email, token, commit message) can't be turned into commands.
 */
const git = (args: string[], cwd: string) => execFileAsync("git", args, { cwd });

/** The branch every notes repository keeps empty; workspaces are the other branches. */
const STORAGE_BRANCH = "main";

/** Branch names go to git as arguments; refuse anything that could be read as an option. */
function safeBranch(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)) throw new Error(`Invalid branch name: ${value}`);
  return value;
}

/** Remote URLs: https or ssh forms only, never something git would read as an option. */
function safeRemoteUrl(url: unknown): string {
  const value = typeof url === "string" ? url.trim() : "";
  if (!/^(https:\/\/|http:\/\/|ssh:\/\/|git@)[^\s"'`$;&|<>]+$/.test(value)) throw new Error("Invalid remote URL");
  return value;
}

export function noeticPlugin(): Plugin {
  return {
    name: "vite-noetic-backend",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/noetic/")) {
          return next();
        }

        // This API reads and writes files and runs git with no sign-in, so it answers only the page
        // it serves. A browser attaches Origin to cross-site requests; a different site open in
        // another tab must not be able to drive it.
        const origin = req.headers.origin;
        if (origin && req.headers.host) {
          let originHost = "";
          try {
            originHost = new URL(origin).host;
          } catch {}
          if (originHost !== req.headers.host) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
            return;
          }
        }

        const endpoint = req.url.replace("/api/noetic/", "").split("?")[0];

        // Parse JSON body or URL query parameters
        let body: Record<string, any> = {};
        if (req.url && req.url.includes("?")) {
          try {
            const urlObj = new URL(req.url, "http://localhost");
            for (const [key, val] of urlObj.searchParams.entries()) {
              body[key] = val;
            }
          } catch {}
        }
        if (req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            const rawBody = Buffer.concat(chunks).toString();
            if (rawBody.trim()) {
              const parsed = JSON.parse(rawBody);
              body = { ...body, ...parsed };
            }
          } catch (e) {
            console.error("Failed to parse request body:", e);
          }
        }

        const userHome = process.env.USERPROFILE || process.env.HOME || process.cwd();
        const defaultVaultPath = path.join(userHome, "Noetic");
        const vaultPath = body.repo_path || body.vault_path || defaultVaultPath;

        const sendJson = (data: any, statusCode = 200) => {
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };

        const sendError = (msg: string, statusCode = 500) => {
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: msg }));
        };

        try {
          switch (endpoint) {
            case "init_or_open_vault": {
              if (!fs.existsSync(vaultPath)) {
                fs.mkdirSync(vaultPath, { recursive: true });
              }
              const gitDir = path.join(vaultPath, ".git");
              const isGit = fs.existsSync(gitDir);
              if (!isGit) {
                try {
                  await execAsync("git init", { cwd: vaultPath });
                } catch {}
              }

              let remoteUrl: string | null = null;
              try {
                const { stdout: rUrl } = await execAsync("git remote get-url origin", { cwd: vaultPath });
                remoteUrl = rUrl.trim() || null;
              } catch {}

              sendJson({
                path: vaultPath,
                name: path.basename(vaultPath),
                is_git_repo: true,
                remote_url: remoteUrl,
              });
              break;
            }

            case "list_vault_files": {
              if (!fs.existsSync(vaultPath)) {
                return sendJson([]);
              }
              const entries: any[] = [];
              const scanDir = (dir: string, baseRel: string = "") => {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                  if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "target" || item.name === "dist") {
                    continue;
                  }
                  const relPath = baseRel ? `${baseRel}/${item.name}` : item.name;
                  const fullPath = path.join(dir, item.name);
                  try {
                    const stat = fs.statSync(fullPath);
                    const isDir = item.isDirectory();
                    entries.push({
                      path: relPath,
                      name: item.name,
                      is_directory: isDir,
                      size_bytes: stat.size,
                      modified_ms: stat.mtimeMs,
                    });
                    if (isDir) {
                      scanDir(fullPath, relPath);
                    }
                  } catch {}
                }
              };
              scanDir(vaultPath);
              entries.sort((a, b) => {
                if (a.is_directory !== b.is_directory) {
                  return b.is_directory ? 1 : -1;
                }
                return a.path.localeCompare(b.path);
              });
              sendJson(entries);
              break;
            }

            case "raw":
            case "read_file_content": {
              let targetPath = body.full_path || body.path || "";
              if (!targetPath) return sendError("Missing file path", 400);
              if (!path.isAbsolute(targetPath)) {
                targetPath = path.join(vaultPath, targetPath);
              }
              if (!fs.existsSync(targetPath)) {
                if (endpoint === "raw" || req.method === "GET") {
                  res.statusCode = 404;
                  return res.end("File not found");
                }
                return sendJson("");
              }

              const ext = path.extname(targetPath).toLowerCase();
              const mimeMap: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".svg": "image/svg+xml",
                ".webp": "image/webp",
                ".bmp": "image/bmp",
                ".ico": "image/x-icon",
              };

              // If it's the raw endpoint, or a GET request, or an image file: serve binary with correct mime
              if (endpoint === "raw" || req.method === "GET" || mimeMap[ext]) {
                const mime = mimeMap[ext] || "application/octet-stream";
                const buf = fs.readFileSync(targetPath);
                res.statusCode = 200;
                res.setHeader("Content-Type", mime);
                res.setHeader("Cache-Control", "public, max-age=3600");
                return res.end(buf);
              }

              const content = fs.readFileSync(targetPath, "utf-8");
              sendJson(content);
              break;
            }

            case "save_image_file": {
              let relPath = body.rel_path;
              const base64Data = body.data_base64;
              if (!relPath || !base64Data) return sendError("Missing rel_path or data_base64", 400);
              const targetPath = path.isAbsolute(relPath) ? relPath : path.join(vaultPath, relPath);
              const dir = path.dirname(targetPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const pureBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
              fs.writeFileSync(targetPath, Buffer.from(pureBase64, "base64"));
              sendJson({ success: true, path: relPath });
              break;
            }

            case "write_file_content": {
              let targetPath = body.full_path || body.path || "";
              if (!targetPath) return sendError("Missing file path", 400);
              if (!path.isAbsolute(targetPath)) {
                targetPath = path.join(vaultPath, targetPath);
              }
              const dir = path.dirname(targetPath);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(targetPath, body.content || "", "utf-8");
              sendJson({ success: true });
              break;
            }

            case "create_file": {
              const fullPath = path.join(vaultPath, body.rel_path);
              const dir = path.dirname(fullPath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              if (!fs.existsSync(fullPath)) {
                const initialContent = body.rel_path.endsWith(".canvas")
                  ? JSON.stringify({ nodes: [], edges: [] }, null, 2)
                  : ""; // the title is the file name (inline title), not text in the note
                fs.writeFileSync(fullPath, initialContent, "utf-8");
              }
              sendJson({ success: true });
              break;
            }

            case "create_folder": {
              const fullPath = path.join(vaultPath, body.rel_path);
              if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
              }
              sendJson({ success: true });
              break;
            }

            case "delete_file": {
              const fullPath = path.join(vaultPath, body.rel_path);
              if (fs.existsSync(fullPath)) {
                if (fs.statSync(fullPath).isDirectory()) {
                  fs.rmSync(fullPath, { recursive: true, force: true });
                } else {
                  fs.unlinkSync(fullPath);
                }
              }
              sendJson({ success: true });
              break;
            }

            case "rename_file": {
              const oldPath = path.join(vaultPath, body.old_path);
              const newPath = path.join(vaultPath, body.new_path);
              if (fs.existsSync(oldPath)) {
                const parentDir = path.dirname(newPath);
                if (!fs.existsSync(parentDir)) {
                  fs.mkdirSync(parentDir, { recursive: true });
                }
                fs.renameSync(oldPath, newPath);
              }
              sendJson({ success: true });
              break;
            }

            case "get_repo_status": {
              const statusData = await getGitStatus(vaultPath);
              sendJson(statusData);
              break;
            }

            case "fetch_remote": {
              try {
                await git(["fetch", "--prune", "origin"], vaultPath);
              } catch (e) {
                console.warn("fetch failed (offline?):", e);
              }
              const statusData = await getGitStatus(vaultPath);
              sendJson(statusData);
              break;
            }

            case "save_and_push": {
              const preStatus = await getGitStatus(vaultPath);
              if (!preStatus.remote_url) {
                return sendError("Your notes are kept on this device. Sign in to back them up and sync them.");
              }
              if (!preStatus.branch) {
                return sendError("Choose or create a workspace first.");
              }
              if (preStatus.behind_count > 0) {
                return sendError("There are updates waiting from your other devices. Sync first, then save.");
              }
              await commitAll(vaultPath, body.commit_message || `Notes update: ${new Date().toISOString()}`);

              try {
                await git(["push", "-u", "origin", safeBranch(preStatus.branch)], vaultPath);
              } catch (pushErr: any) {
                return sendError(`Saved on this device, but it couldn't be uploaded: ${pushErr.message}. It will be sent the next time you save while online.`);
              }

              const postStatus = await getGitStatus(vaultPath);
              sendJson(postStatus);
              break;
            }

            case "get_vault_config": {
              let remoteUrl: string | null = null;
              try {
                const { stdout: rUrl } = await execAsync("git remote get-url origin", { cwd: vaultPath });
                remoteUrl = rUrl.trim() || null;
              } catch {}

              const branch = (await currentWorkspace(vaultPath)) ?? "";

              let userName: string | null = null;
              let userEmail: string | null = null;
              try {
                const { stdout: n } = await execAsync("git config user.name", { cwd: vaultPath });
                userName = n.trim() || null;
              } catch {}
              try {
                const { stdout: e } = await execAsync("git config user.email", { cwd: vaultPath });
                userEmail = e.trim() || null;
              } catch {}

              let hasToken = false;
              try {
                const { stdout: t } = await execAsync("git config noetic.token", { cwd: vaultPath });
                hasToken = Boolean(t.trim());
              } catch {}

              sendJson({
                vault_path: vaultPath,
                remote_url: remoteUrl,
                branch,
                user_name: userName,
                user_email: userEmail,
                has_token: hasToken,
              });
              break;
            }

            case "set_vault_config": {
              const cfg = body.config || body;
              if (cfg.user_name) {
                await git(["config", "user.name", String(cfg.user_name).trim()], vaultPath);
              }
              if (cfg.user_email) {
                await git(["config", "user.email", String(cfg.user_email).trim()], vaultPath);
              }
              if (cfg.github_token !== undefined) {
                await git(["config", "noetic.token", String(cfg.github_token).trim()], vaultPath);
              }

              // Return updated config
              let remoteUrl: string | null = null;
              try {
                const { stdout: rUrl } = await execAsync("git remote get-url origin", { cwd: vaultPath });
                remoteUrl = rUrl.trim() || null;
              } catch {}

              const currentBranch = (await currentWorkspace(vaultPath)) ?? "";

              sendJson({
                vault_path: vaultPath,
                remote_url: remoteUrl,
                branch: currentBranch,
                user_name: cfg.user_name || null,
                user_email: cfg.user_email || null,
                has_token: Boolean(cfg.github_token),
              });
              break;
            }

            case "github_start_device_flow": {
              const clientId = body.client_id || "Ov23liegRfd4WTYsq3Cf";
              try {
                const formBody = new URLSearchParams({
                  client_id: clientId,
                  scope: "repo,read:user,user:email",
                });
                const res = await fetch("https://github.com/login/device/code", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: formBody.toString(),
                });
                const data = await res.json();
                sendJson(data);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                sendError(`Device flow initiation failed: ${msg}`, 500);
              }
              break;
            }

            case "github_poll_device_token": {
              const clientId = body.client_id || "Ov23liegRfd4WTYsq3Cf";
              const deviceCode = body.device_code;
              if (!deviceCode) {
                return sendError("device_code is required", 400);
              }
              try {
                const formBody = new URLSearchParams({
                  client_id: clientId,
                  device_code: deviceCode,
                  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                });
                const res = await fetch("https://github.com/login/oauth/access_token", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: formBody.toString(),
                });
                const data = await res.json();
                if (data.access_token) {
                  sendJson({
                    status: "approved",
                    access_token: data.access_token,
                    token_type: data.token_type,
                    scope: data.scope,
                  });
                } else if (data.error === "authorization_pending") {
                  sendJson({
                    status: "pending",
                    interval: data.interval || 5,
                    error_description: data.error_description,
                  });
                } else if (data.error === "slow_down") {
                  sendJson({
                    status: "slow_down",
                    interval: data.interval || 10,
                    error_description: data.error_description,
                  });
                } else if (data.error === "expired_token") {
                  sendJson({
                    status: "expired",
                    error_description: data.error_description || "Device code expired.",
                  });
                } else if (data.error === "access_denied") {
                  sendJson({
                    status: "denied",
                    error_description: data.error_description || "Access denied by user.",
                  });
                } else {
                  sendJson({
                    status: "error",
                    error_description: data.error_description || data.error || "Unknown error",
                  });
                }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                sendError(`Device flow polling failed: ${msg}`, 500);
              }
              break;
            }

            case "connect_vault": {
              const targetPath = body.vault_path || vaultPath;
              const remoteUrl = body.remote_url;
              const token = body.github_token;
              const userName = body.user_name;
              const userEmail = body.user_email;

              if (!remoteUrl) {
                return sendError("Remote URL is required", 400);
              }

              if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
              }
              if (!fs.existsSync(path.join(targetPath, ".git"))) {
                await git(["init"], targetPath);
              }

              let hasOrigin = false;
              try {
                await git(["remote", "get-url", "origin"], targetPath);
                hasOrigin = true;
              } catch {}
              await git(["remote", hasOrigin ? "set-url" : "add", "origin", safeRemoteUrl(remoteUrl)], targetPath);

              if (userName) await git(["config", "user.name", String(userName)], targetPath);
              if (userEmail) await git(["config", "user.email", String(userEmail)], targetPath);
              if (token) await git(["config", "noetic.token", String(token)], targetPath);

              await git(["fetch", "--prune", "origin"], targetPath);

              // The storage branch stays empty; create it if the repository is brand new.
              if (!(await refExists(targetPath, `refs/remotes/origin/${STORAGE_BRANCH}`))) {
                const root = await emptyRootCommit(targetPath);
                await git(["push", "origin", `${root}:refs/heads/${STORAGE_BRANCH}`], targetPath);
                await git(["fetch", "--prune", "origin"], targetPath);
              }

              sendJson(await listWorkspaces(targetPath));
              break;
            }

            case "list_workspaces": {
              if (body.refresh) {
                try {
                  await git(["fetch", "--prune", "origin"], vaultPath);
                } catch {}
              }
              sendJson(await listWorkspaces(vaultPath));
              break;
            }

            case "create_workspace": {
              const name = String(body.name ?? "").trim().split(/\s+/).filter(Boolean).join("-");
              if (!name) return sendError("Give the workspace a name.", 400);
              if (name.toLowerCase() === STORAGE_BRANCH || name.toUpperCase() === "HEAD") {
                return sendError(`"${name}" is reserved. Pick a different name.`, 400);
              }
              let valid = !name.startsWith("-") && !name.includes("/");
              if (valid) {
                try {
                  await git(["check-ref-format", "--branch", name], vaultPath);
                } catch {
                  valid = false;
                }
              }
              if (!valid) {
                return sendError("Workspace names can use letters, numbers, spaces, dashes and underscores.", 400);
              }
              const existing = await listWorkspaces(vaultPath);
              if (existing.workspaces.some((w) => w.toLowerCase() === name.toLowerCase())) {
                return sendError(`A workspace named "${name}" already exists.`, 400);
              }

              if (existing.current) {
                // A later workspace starts blank; the open one is saved first.
                const blocked = await saveBeforeLeaving(vaultPath, existing.current);
                if (blocked) return sendError(blocked, 400);
                await git(["branch", name, await workspaceBase(vaultPath)], vaultPath);
                await git(["checkout", "-f", name], vaultPath);
                removeEmptyFolders(vaultPath);
              } else {
                // The first workspace on this device takes the notes already in the folder.
                const base = await workspaceBase(vaultPath);
                await git(["update-ref", `refs/heads/${name}`, base], vaultPath);
                await git(["symbolic-ref", "HEAD", `refs/heads/${name}`], vaultPath);
                await git(["reset", "-q"], vaultPath);
                if (!hasNotes(vaultPath)) {
                  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), WELCOME_NOTE, "utf-8");
                }
                await commitAll(vaultPath, "First notes in this workspace");
              }

              try {
                await git(["push", "-u", "origin", name], vaultPath);
              } catch {}
              sendJson(await getGitStatus(vaultPath));
              break;
            }

            case "switch_workspace": {
              const name = String(body.name ?? "").trim();
              const list = await listWorkspaces(vaultPath);
              if (list.current === name) return sendJson(await getGitStatus(vaultPath));
              if (!list.workspaces.includes(name)) {
                return sendError(`The workspace "${name}" no longer exists.`, 400);
              }
              const target = safeBranch(name);

              if (list.current) {
                const blocked = await saveBeforeLeaving(vaultPath, list.current);
                if (blocked) return sendError(blocked, 400);
              }
              if (!(await refExists(vaultPath, `refs/heads/${target}`))) {
                await git(["branch", target, `origin/${target}`], vaultPath);
              }
              if (list.current) {
                await git(["checkout", "-f", target], vaultPath);
                removeEmptyFolders(vaultPath);
              } else {
                // Notes in the folder belong to no workspace yet: keep them, refuse on a name clash.
                try {
                  await git(["checkout", target], vaultPath);
                } catch {
                  return sendError(
                    "Some notes on this device have the same names as notes in this workspace. Rename or move them, then try again.",
                    400
                  );
                }
              }
              sendJson(await getGitStatus(vaultPath));
              break;
            }

            case "sync_and_pull": {
              await git(["fetch", "--prune", "origin"], vaultPath).catch((e) => {
                throw new Error(`Couldn't reach your cloud storage: ${e.message}`);
              });

              const status = await getGitStatus(vaultPath);
              if (!status.branch || status.behind_count === 0) {
                return sendJson({
                  success: true,
                  message: "Everything is up to date.",
                  state: status.state,
                  conflicts: [],
                });
              }
              const upstream = `origin/${safeBranch(status.branch)}`;

              const dirtyFiles = status.files.filter((f: any) => f.is_modified || f.is_untracked).map((f: any) => f.path);
              const remoteFiles = status.files.filter((f: any) => f.has_remote_update).map((f: any) => f.path);
              const overlapping = dirtyFiles.filter((p: string) => remoteFiles.includes(p));

              if (overlapping.length > 0) {
                const conflicts = [];
                for (const p of overlapping) {
                  let base = "";
                  let remote = "";
                  try {
                    const { stdout: b } = await git(["show", `HEAD:${p}`], vaultPath);
                    base = b;
                  } catch {}
                  try {
                    const { stdout: r } = await git(["show", `${upstream}:${p}`], vaultPath);
                    remote = r;
                  } catch {}
                  const local = fs.existsSync(path.join(vaultPath, p)) ? fs.readFileSync(path.join(vaultPath, p), "utf-8") : "";

                  conflicts.push({
                    path: p,
                    base_content: base,
                    local_content: local,
                    remote_content: remote,
                    hunks: [{ id: `hunk_${p}`, base_lines: base, local_lines: local, remote_lines: remote }],
                  });
                }

                return sendJson({
                  success: false,
                  message: `${conflicts.length} note(s) changed both here and on another device. Choose which version to keep.`,
                  state: "DirtyBehind",
                  conflicts,
                });
              }

              // Non-overlapping: stash if dirty, fast-forward, pop stash
              const hadDirty = dirtyFiles.length > 0;
              if (hadDirty) {
                try { await git(["stash", "push", "-u", "-m", "Noetic sync"], vaultPath); } catch {}
              }
              await git(["merge", "--ff-only", upstream], vaultPath);
              if (hadDirty) {
                try { await git(["stash", "pop"], vaultPath); } catch {}
              }

              const postStatus = await getGitStatus(vaultPath);
              sendJson({
                success: true,
                message: "Synced. Your notes are up to date.",
                state: postStatus.state,
                conflicts: [],
              });
              break;
            }

            case "resolve_conflicts": {
              // Take the incoming version of everything, then put the chosen text on top of it,
              // left as unsaved edits (the same result as the app's own backend).
              const resolutions = body.resolutions || [];
              const workspace = await currentWorkspace(vaultPath);
              if (!workspace) return sendError("Choose or create a workspace first.", 400);
              await git(["reset", "--hard", `origin/${safeBranch(workspace)}`], vaultPath);
              for (const resItem of resolutions) {
                if (resItem.custom_content !== undefined) {
                  const targetPath = path.join(vaultPath, resItem.path);
                  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                  fs.writeFileSync(targetPath, resItem.custom_content, "utf-8");
                }
              }
              sendJson(await getGitStatus(vaultPath));
              break;
            }

            default:
              sendError(`Unknown endpoint: ${endpoint}`, 404);
          }
        } catch (err: any) {
          console.error(`Error in endpoint ${endpoint}:`, err);
          sendError(err.message || String(err), 500);
        }
      });
    },
  };
}

const WELCOME_NOTE =
  "Noetic keeps your notes as plain Markdown files on this device and backs them up to your account.\n\n- **Save** uploads your changes so your other devices can get them.\n- **Sync** brings in changes made on your other devices.\n- **Workspaces** keep separate sets of notes apart, for example Personal and Work. Switch or add one from the workspace menu.\n";

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

/** The open workspace: the checked-out branch, unless it has no saves yet or is the storage branch. */
async function currentWorkspace(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
    const name = stdout.trim();
    if (!name || name === STORAGE_BRANCH) return null;
    return (await refExists(cwd, `refs/heads/${name}`)) ? name : null;
  } catch {
    return null;
  }
}

async function listWorkspaces(cwd: string): Promise<{ current: string | null; workspaces: string[] }> {
  const names = new Set<string>();
  try {
    const { stdout } = await git(
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
      cwd
    );
    for (const ref of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
      if (name !== STORAGE_BRANCH && name !== "HEAD") names.add(name);
    }
  } catch {}
  const workspaces = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { current: await currentWorkspace(cwd), workspaces };
}

/** A commit with no files and no parent. */
async function emptyRootCommit(cwd: string): Promise<string> {
  // Git's well-known id for a tree with nothing in it; written so it exists before it is pushed.
  let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  try {
    const { stdout: written } = await git(["hash-object", "-t", "tree", "-w", os.devNull], cwd);
    tree = written.trim() || tree;
  } catch {}
  const { stdout } = await git(["commit-tree", tree, "-m", "Noetic storage"], cwd);
  return stdout.trim();
}

/** Where a new workspace starts: the empty commit on the storage branch. */
async function workspaceBase(cwd: string): Promise<string> {
  const ref = `refs/remotes/origin/${STORAGE_BRANCH}`;
  if (await refExists(cwd, ref)) {
    const { stdout: files } = await git(["ls-tree", "--name-only", ref], cwd);
    if (!files.trim()) {
      const { stdout } = await git(["rev-parse", ref], cwd);
      return stdout.trim();
    }
  }
  return emptyRootCommit(cwd);
}

/** Stages and commits everything; does nothing when there is nothing new. */
async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], cwd);
  const { stdout } = await git(["status", "--porcelain"], cwd);
  if (stdout.trim()) await git(["commit", "-q", "-m", String(message)], cwd);
}

/** Saves the open workspace before another is opened. Returns a message when that isn't safe. */
async function saveBeforeLeaving(cwd: string, workspace: string): Promise<string | null> {
  const status = await getGitStatus(cwd);
  if (status.dirty_count === 0) return null;
  if (status.behind_count > 0) {
    return "This workspace has unsaved changes and updates waiting from your other devices. Sync it first, then switch.";
  }
  await commitAll(cwd, `Saved before leaving workspace: ${new Date().toISOString()}`);
  try {
    await git(["push", "-u", "origin", safeBranch(workspace)], cwd);
  } catch {}
  return null;
}

function hasNotes(dir: string): boolean {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    if (item.isDirectory() ? hasNotes(path.join(dir, item.name)) : /\.(md|canvas)$/.test(item.name)) return true;
  }
  return false;
}

/** Empty folders aren't part of a save, so they would otherwise follow the user between workspaces. */
function removeEmptyFolders(dir: string): boolean {
  let empty = true;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && item.name !== ".git" && removeEmptyFolders(full)) fs.rmdirSync(full);
    else empty = false;
  }
  return empty;
}

async function getGitStatus(vaultPath: string) {
  let dirtyCount = 0;
  const fileStatuses: any[] = [];

  try {
    const { stdout: statusOut } = await execAsync("git status --porcelain=v1", { cwd: vaultPath });
    const lines = statusOut.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const code = line.substring(0, 2);
      const filePath = line.substring(3).trim().replace(/\\/g, "/");
      const isUntracked = code.includes("?");
      const isModified = !isUntracked;
      fileStatuses.push({
        path: filePath,
        is_modified: isModified,
        is_untracked: isUntracked,
        has_remote_update: false,
      });
      dirtyCount++;
    }
  } catch (e) {
    console.error("git status failed:", e);
  }

  const branchName = (await currentWorkspace(vaultPath)) ?? "";
  const upstream = branchName ? `refs/remotes/origin/${branchName}` : "";
  const hasUpstream = Boolean(upstream) && (await refExists(vaultPath, upstream));

  let aheadCount = 0;
  let behindCount = 0;
  try {
    if (hasUpstream) {
      const { stdout: revCount } = await git(["rev-list", "--count", "--left-right", `HEAD...${upstream}`], vaultPath);
      const [ahead, behind] = revCount.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      aheadCount = ahead;
      behindCount = behind;
    } else if (branchName) {
      // Not uploaded yet: every save on it is waiting.
      const { stdout } = await git(["rev-list", "--count", "HEAD"], vaultPath);
      aheadCount = parseInt(stdout.trim(), 10) || 0;
    }
  } catch {}

  // Check diff against the cloud copy
  if (behindCount > 0) {
    try {
      const { stdout: diffFiles } = await git(["diff", "--name-only", "HEAD", upstream], vaultPath);
      const changed = diffFiles.split("\n").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean);
      for (const p of changed) {
        const existing = fileStatuses.find((f) => f.path === p);
        if (existing) {
          existing.has_remote_update = true;
        } else {
          fileStatuses.push({
            path: p,
            is_modified: false,
            is_untracked: false,
            has_remote_update: true,
          });
        }
      }
    } catch {}
  }

  let remoteUrl: string | null = null;
  try {
    const { stdout: rUrl } = await execAsync("git remote get-url origin", { cwd: vaultPath });
    remoteUrl = rUrl.trim() || null;
  } catch {}

  let state = "CleanSynced";
  if (behindCount > 0) {
    state = dirtyCount > 0 ? "DirtyBehind" : "CleanBehind";
  } else if (aheadCount > 0) {
    state = "AheadOffline";
  } else if (dirtyCount > 0) {
    state = "DirtySynced";
  } else {
    state = "CleanSynced";
  }

  return {
    state,
    dirty_count: dirtyCount,
    behind_count: behindCount,
    ahead_count: aheadCount,
    branch: branchName,
    remote_name: remoteUrl ? "origin" : null,
    remote_url: remoteUrl,
    files: fileStatuses,
    last_synced_at: new Date().toLocaleTimeString(),
  };
}
