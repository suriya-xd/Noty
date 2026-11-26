// Registers the app's own Android services in the manifest that `tauri android init` generates
// (src-tauri/gen/android is created on each build, apart from the Kotlin files kept in the
// repository). Run after `tauri android init`; running it again changes nothing.
import fs from "node:fs";

const MANIFEST = "src-tauri/gen/android/app/src/main/AndroidManifest.xml";

// The background job that uploads notes once the phone is online (SyncJobService.kt).
const SERVICE = `        <service
            android:name=".SyncJobService"
            android:permission="android.permission.BIND_JOB_SERVICE"
            android:exported="false" />
`;

const xml = fs.readFileSync(MANIFEST, "utf-8");
if (xml.includes('android:name=".SyncJobService"')) {
  console.log("Manifest already registers SyncJobService.");
} else {
  const end = xml.lastIndexOf("</application>");
  if (end < 0) {
    console.error(`No </application> in ${MANIFEST}; can't register SyncJobService.`);
    process.exit(1);
  }
  const lineStart = xml.lastIndexOf("\n", end) + 1;
  fs.writeFileSync(MANIFEST, xml.slice(0, lineStart) + SERVICE + xml.slice(lineStart));
  console.log("Registered SyncJobService in the manifest.");
}
