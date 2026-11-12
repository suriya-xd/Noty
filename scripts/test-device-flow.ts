import { GitHubService, pollDeviceFlow } from "../src/services/githubService";
import { GitVaultBridge } from "../src/services/gitVaultBridge";
import type { DeviceTokenResponse } from "../src/types/gitVault";

// Fake clock: timers only fire when the test advances time.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let now = 1_000_000;
type Timer = { fn: () => void; at: number };
let timers: Timer[] = [];
(globalThis as any).setTimeout = (fn: () => void, ms: number) => {
  const t = { fn, at: now + ms };
  timers.push(t);
  return t;
};
(globalThis as any).clearTimeout = (t: Timer) => {
  timers = timers.filter((x) => x !== t);
};
Date.now = () => now;
const flush = () => new Promise<void>((r) => setImmediate(r));
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    timers = timers.filter((t) => t !== next);
    now = next.at;
    next.fn();
    await flush();
  }
  now = end;
}

let failures = 0;
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
};

const res = (r: Partial<DeviceTokenResponse>): DeviceTokenResponse => ({ status: "pending", ...r }) as DeviceTokenResponse;
function script(steps: Array<DeviceTokenResponse | Error>) {
  const calls: number[] = [];
  (GitHubService as any).pollDeviceToken = async () => {
    calls.push(now);
    const step = steps.shift() ?? res({ status: "pending" });
    if (step instanceof Error) throw step;
    return step;
  };
  return calls;
}
function run(opts: { interval?: number; expiresIn?: number } = {}) {
  const log: string[] = [];
  const stop = pollDeviceFlow({
    deviceCode: "dc",
    interval: opts.interval ?? 5,
    expiresIn: opts.expiresIn ?? 900,
    onApproved: (t) => void log.push(`approved:${t}`),
    onFailure: (m) => void log.push(`failed:${m}`),
  });
  return { log, stop };
}

console.log("\nDevice flow polling");

{
  const calls = script([res({}), res({}), res({ status: "approved", access_token: "tok" })]);
  const { log } = run({ interval: 5 });
  await advance(4_999);
  eq("does not poll before the interval", calls.length, 0);
  await advance(30_000);
  eq("polls on the interval until approved", [calls.length, log], [3, ["approved:tok"]]);
  await advance(60_000);
  eq("stops after approval", calls.length, 3);
}
{
  const calls = script([res({ status: "slow_down", interval: 10 }), res({ status: "approved", access_token: "t" })]);
  const { log } = run({ interval: 5 });
  await advance(5_000);
  await advance(9_000);
  eq("slow_down raises the wait (no poll after 9s)", calls.length, 1);
  await advance(1_000);
  eq("...then polls at the new interval", [calls.length, log], [2, ["approved:t"]]);
}
{
  const calls = script([res({ status: "slow_down" }), res({ status: "approved", access_token: "t" })]);
  run({ interval: 5 });
  await advance(5_000);
  await advance(9_999);
  eq("slow_down without a new interval adds 5s", calls.length, 1);
  await advance(1);
  eq("...and polls at +5s", calls.length, 2);
}
{
  script([new Error("net"), new Error("net"), res({ status: "approved", access_token: "ok" })]);
  const { log } = run({ interval: 5 });
  await advance(60_000);
  eq("survives a couple of network errors", log, ["approved:ok"]);
}
{
  script([new Error("e1"), new Error("e2"), new Error("e3"), new Error("e4")]);
  const { log } = run({ interval: 5 });
  await advance(120_000);
  eq("gives up after repeated network errors", log, ["failed:e4"]);
}
{
  script([new Error("a"), new Error("b"), res({}), new Error("c"), new Error("d"), res({ status: "approved", access_token: "x" })]);
  const { log } = run({ interval: 5 });
  await advance(120_000);
  eq("a success resets the error count", log, ["approved:x"]);
}
{
  script([res({ status: "denied", error_description: "No." })]);
  const { log } = run();
  await advance(10_000);
  eq("denied is reported", log, ["failed:No."]);
}
{
  script([res({ status: "expired" })]);
  const { log } = run();
  await advance(10_000);
  eq("expired from GitHub is reported", log.length === 1 && log[0].startsWith("failed:"), true);
}
{
  script([]);
  const { log } = run({ interval: 5, expiresIn: 20 });
  await advance(60_000);
  eq("local expiry stops polling", log.length === 1 && log[0].startsWith("failed:That code expired"), true);
}
{
  const calls = script([]);
  const { log, stop } = run({ interval: 5 });
  await advance(5_000);
  stop();
  await advance(60_000);
  eq("cancel stops everything, silently", [calls.length, log], [1, []]);
}
{
  const calls = script([res({ status: "approved", access_token: "t" })]);
  const log: string[] = [];
  pollDeviceFlow({
    deviceCode: "dc",
    interval: 5,
    expiresIn: 900,
    onApproved: () => {
      throw new Error("validation failed");
    },
    onFailure: (m) => void log.push(m),
  });
  await advance(10_000);
  eq("an error while finishing sign-in is reported once", [calls.length, log], [1, ["validation failed"]]);
}

console.log("\nBridge error handling");
{
  (globalThis as any).setTimeout = realSetTimeout; // the mock backend uses a real delay
  (globalThis as any).clearTimeout = realClearTimeout;
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
      return "resolved";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  // Native app: the Rust error is shown as is, and nothing falls back to the browser mock.
  (globalThis as any).window = {
    __TAURI_INTERNALS__: {
      invoke: async () => {
        throw "Couldn't connect to GitHub: timed out";
      },
      transformCallback: () => 0,
    },
  };
  eq("native failure is reported as itself", await rejection(GitVaultBridge.startDeviceFlow()), "Couldn't connect to GitHub: timed out");
  eq("native failure on poll too", await rejection(GitVaultBridge.pollDeviceToken("dc")), "Couldn't connect to GitHub: timed out");

  // Plain browser with no backend: a clear message instead of "Unknown command".
  delete (globalThis as any).window;
  (globalThis as any).fetch = async () => {
    throw new Error("no server");
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const msg = await rejection(GitVaultBridge.startDeviceFlow());
  console.warn = origWarn;
  eq("browser-only: explains instead of 'Unknown command'", msg.startsWith("Signing in with a browser code works in the Noty"), true);
}

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll device-flow tests passed\n");
