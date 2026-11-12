# Noetic

Local-first Markdown notes for desktop (Windows, macOS, Linux) and Android, built with Tauri v2, React and CodeMirror 6.

## How notes are stored and synced

- Notes are plain Markdown files in a folder on the device (`~/Noetic` on desktop).
- Signing in with GitHub creates one private repository named `noetic-notes` in the user's account. The app always uses that repository; there is nothing to choose.
- The repository's `main` branch is kept empty. Each **workspace** is a branch that starts from it, so one account can hold several separate sets of notes (for example Personal and Work).
- The first time a device signs in, the user names a workspace or opens an existing one. Workspaces are switched and added from the workspace menu in the top bar.
- **Save** uploads the open workspace. **Sync** brings in changes saved from other devices. Switching workspaces saves the open one first.

The interface says "workspace", "save" and "sync"; repository and branch names do not appear in it.

## Development

```
npm install
npm run dev            # browser, backed by the Vite dev plugin (uses the git CLI and ~/Noetic)
npm run desktop:dev    # Tauri desktop app
npm run build
```

Tests:

```
npm run test:workspaces   # workspace flow against a throwaway local repository
npm run test:auth         # sign-in polling
npm run test:wikilinks
npm run test:canvas
npm run test:blocks
```

Android builds: `scripts/build-android.sh` (or `npm run android:build` on Windows). The APK is copied to `src-tauri/gen/android/app/build/outputs/noetic/Noetic-*.apk`.
