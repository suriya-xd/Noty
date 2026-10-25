import type { Plugin } from "vite";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

const execAsync = util.promisify(exec);

export function gitVaultPlugin(): Plugin {
  return {
    name: "vite-gitvault-backend",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/gitvault/")) {
          return next();
        }

        const endpoint = req.url.replace("/api/gitvault/", "").split("?")[0];

        // Parse JSON body
        let body: Record<string, any> = {};
        if (req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk as Buffer);
            }
            const rawBody = Buffer.concat(chunks).toString();
            if (rawBody.trim()) {
              body = JSON.parse(rawBody);
            }
          } catch (e) {
            console.error("Failed to parse request body:", e);
          }
        }

        const userHome = process.env.USERPROFILE || process.env.HOME || process.cwd();
        const defaultVaultPath = path.join(userHome, "GitVault");
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

              let repoName = path.basename(vaultPath);
              if (remoteUrl) {
                const match = remoteUrl.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
                if (match) repoName = match[1];
              }

              sendJson({
                path: vaultPath,
                name: repoName,
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

            case "read_file_content": {
              let targetPath = body.full_path || body.path || "";
              if (!targetPath) return sendError("Missing file path", 400);
              if (!path.isAbsolute(targetPath)) {
                targetPath = path.join(vaultPath, targetPath);
              }
              if (fs.existsSync(targetPath)) {
                const content = fs.readFileSync(targetPath, "utf-8");
                sendJson(content);
              } else {
                sendJson("");
              }
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
                  : `# ${body.rel_path.split("/").pop()?.replace(".md", "") || "Untitled"}\n\n`;
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
                await execAsync("git fetch origin", { cwd: vaultPath });
              } catch (e) {
                console.warn("fetch failed (offline?):", e);
              }
              const statusData = await getGitStatus(vaultPath);
              sendJson(statusData);
              break;
            }

            case "save_and_push": {
              const preStatus = await getGitStatus(vaultPath);
              if (preStatus.behind_count > 0) {
                return sendError(`Cannot save and push: remote is ahead by ${preStatus.behind_count} commit(s). Please click 'Sync' first.`);
              }
              // Stage all files
              await execAsync("git add -A", { cwd: vaultPath });
              const msg = body.commit_message || `Vault update: ${new Date().toISOString()}`;
              await execAsync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: vaultPath });
              
              // Push to origin
              if (!preStatus.remote_url) {
                return sendError("Committed locally, but no remote 'origin' is configured. Click the Settings icon to link your GitHub repository.");
              }

              try {
                const branch = preStatus.branch || "main";
                await execAsync(`git push -u origin ${branch}`, { cwd: vaultPath });
              } catch (pushErr: any) {
                return sendError(`Committed locally, but failed to push to GitHub: ${pushErr.message}. Check your remote URL and credentials in Settings.`);
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

              let branch = "main";
              try {
                const { stdout: b } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: vaultPath });
                branch = b.trim() || "main";
              } catch {}

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
                const { stdout: t } = await execAsync("git config gitvault.token", { cwd: vaultPath });
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
              if (cfg.remote_url) {
                const cleanUrl = cfg.remote_url.trim();
                let hasOrigin = false;
                try {
                  await execAsync("git remote get-url origin", { cwd: vaultPath });
                  hasOrigin = true;
                } catch {}

                if (hasOrigin) {
                  await execAsync(`git remote set-url origin "${cleanUrl}"`, { cwd: vaultPath });
                } else {
                  await execAsync(`git remote add origin "${cleanUrl}"`, { cwd: vaultPath });
                }
              }

              if (cfg.branch) {
                const cleanBranch = cfg.branch.trim();
                try {
                  await execAsync(`git branch -M "${cleanBranch}"`, { cwd: vaultPath });
                } catch {}
              }

              if (cfg.user_name) {
                await execAsync(`git config user.name "${cfg.user_name.trim()}"`, { cwd: vaultPath });
              }
              if (cfg.user_email) {
                await execAsync(`git config user.email "${cfg.user_email.trim()}"`, { cwd: vaultPath });
              }
              if (cfg.github_token !== undefined) {
                await execAsync(`git config gitvault.token "${cfg.github_token.trim()}"`, { cwd: vaultPath });
              }

              // Return updated config
              let remoteUrl: string | null = null;
              try {
                const { stdout: rUrl } = await execAsync("git remote get-url origin", { cwd: vaultPath });
                remoteUrl = rUrl.trim() || null;
              } catch {}

              let currentBranch = "main";
              try {
                const { stdout: b } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: vaultPath });
                currentBranch = b.trim() || "main";
              } catch {}

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

            case "test_remote_connection": {
              const targetUrl = body.remote_url;
              if (!targetUrl) return sendError("Remote URL is required", 400);

              try {
                await execAsync(`git ls-remote "${targetUrl}"`, { cwd: vaultPath });
                sendJson({ success: true, message: "Successfully connected to GitHub repository!" });
              } catch (testErr: any) {
                sendError(`Connection failed: ${testErr.message}`, 400);
              }
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
              const branch = body.branch || "main";
              const token = body.github_token;
              const userName = body.user_name;
              const userEmail = body.user_email;

              if (!remoteUrl) {
                return sendError("Remote URL is required to connect vault", 400);
              }

              if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
              }

              const gitDir = path.join(targetPath, ".git");
              if (!fs.existsSync(gitDir)) {
                await execAsync("git init", { cwd: targetPath });
              }

              // Configure origin
              let hasOrigin = false;
              try {
                await execAsync("git remote get-url origin", { cwd: targetPath });
                hasOrigin = true;
              } catch {}

              if (hasOrigin) {
                await execAsync(`git remote set-url origin "${remoteUrl}"`, { cwd: targetPath });
              } else {
                await execAsync(`git remote add origin "${remoteUrl}"`, { cwd: targetPath });
              }

              if (userName) await execAsync(`git config user.name "${userName}"`, { cwd: targetPath });
              if (userEmail) await execAsync(`git config user.email "${userEmail}"`, { cwd: targetPath });
              if (token) await execAsync(`git config gitvault.token "${token}"`, { cwd: targetPath });

              // Fetch from origin
              try {
                await execAsync("git fetch origin", { cwd: targetPath });
                try {
                  await execAsync(`git checkout -B ${branch} origin/${branch}`, { cwd: targetPath });
                } catch {
                  await execAsync(`git branch -M ${branch}`, { cwd: targetPath });
                }
              } catch (e) {
                console.warn("fetch failed during connect:", e);
                await execAsync(`git branch -M ${branch}`, { cwd: targetPath });
              }

              // If no markdown notes exist, create initial Welcome note
              const welcomePath = path.join(targetPath, "Welcome.md");
              const files = fs.readdirSync(targetPath);
              const hasNotes = files.some((f) => f.endsWith(".md"));
              if (!hasNotes && !fs.existsSync(welcomePath)) {
                fs.writeFileSync(
                  welcomePath,
                  `# Welcome to GitVault\n\nYour vault is now connected to GitHub repository: \`${remoteUrl}\`.\n\n- Every note is written locally to disk\n- Hit **Save** to stage, commit, and push directly to GitHub\n`,
                  "utf-8"
                );
              }

              const status = await getGitStatus(targetPath);
              sendJson(status);
              break;
            }

            case "sync_and_pull": {
              try {
                await execAsync("git fetch origin", { cwd: vaultPath });
              } catch (e) {
                console.warn("Fetch failed during sync:", e);
              }

              const status = await getGitStatus(vaultPath);
              if (status.behind_count === 0) {
                return sendJson({
                  success: true,
                  message: "Repository is already up to date.",
                  state: status.state,
                  conflicts: [],
                });
              }

              // Check if overlapping
              const dirtyFiles = status.files.filter((f: any) => f.is_modified || f.is_untracked).map((f: any) => f.path);
              const remoteFiles = status.files.filter((f: any) => f.has_remote_update).map((f: any) => f.path);
              const overlapping = dirtyFiles.filter((p: string) => remoteFiles.includes(p));

              if (overlapping.length > 0) {
                // In-memory 3-way conflict simulation/detection
                const conflicts = [];
                for (const p of overlapping) {
                  let base = "";
                  let remote = "";
                  try {
                    const { stdout: b } = await execAsync(`git show HEAD:${p}`, { cwd: vaultPath });
                    base = b;
                  } catch {}
                  try {
                    const { stdout: r } = await execAsync(`git show origin/main:${p}`, { cwd: vaultPath });
                    remote = r;
                  } catch {}
                  const local = fs.existsSync(path.join(vaultPath, p)) ? fs.readFileSync(path.join(vaultPath, p), "utf-8") : "";

                  conflicts.push({
                    path: p,
                    base_content: base,
                    local_content: local,
                    remote_content: remote,
                    hunks: [
                      {
                        id: `hunk_${p}`,
                        base_lines: base,
                        local_lines: local,
                        remote_lines: remote,
                      },
                    ],
                  });
                }

                return sendJson({
                  success: false,
                  message: `Conflict detected in ${conflicts.length} file(s). Please resolve in the Visual Conflict Resolver.`,
                  state: "DirtyBehind",
                  conflicts,
                });
              }

              // Non-overlapping: stash if dirty, pull, pop stash
              const hadDirty = dirtyFiles.length > 0;
              if (hadDirty) {
                try { await execAsync("git stash save -u 'GitVault sync auto-stash'", { cwd: vaultPath }); } catch {}
              }
              await execAsync("git merge --ff-only origin/main", { cwd: vaultPath });
              if (hadDirty) {
                try { await execAsync("git stash pop", { cwd: vaultPath }); } catch {}
              }

              const postStatus = await getGitStatus(vaultPath);
              sendJson({
                success: true,
                message: "Successfully synced with GitHub!",
                state: postStatus.state,
                conflicts: [],
              });
              break;
            }

            case "resolve_conflicts": {
              const resolutions = body.resolutions || [];
              for (const resItem of resolutions) {
                if (resItem.custom_content !== undefined) {
                  const targetPath = path.join(vaultPath, resItem.path);
                  fs.writeFileSync(targetPath, resItem.custom_content, "utf-8");
                }
              }
              await execAsync("git add -A", { cwd: vaultPath });
              await execAsync('git commit -m "Merge branch origin/main: Resolved conflicts via GitVault"', { cwd: vaultPath });
              try {
                await execAsync("git push origin main", { cwd: vaultPath });
              } catch {}
              const postStatus = await getGitStatus(vaultPath);
              sendJson(postStatus);
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

  let aheadCount = 0;
  let behindCount = 0;
  try {
    const { stdout: revCount } = await execAsync("git rev-list HEAD...origin/main --count --left-right", { cwd: vaultPath });
    const [ahead, behind] = revCount.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
    aheadCount = ahead;
    behindCount = behind;
  } catch {}

  // Check diff against remote
  if (behindCount > 0) {
    try {
      const { stdout: diffFiles } = await execAsync("git diff --name-only HEAD origin/main", { cwd: vaultPath });
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

  let branchName = "main";
  try {
    const { stdout: bName } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: vaultPath });
    branchName = bName.trim() || "main";
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
