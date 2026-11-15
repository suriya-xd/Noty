import { GitHubService, pollDeviceFlow } from "../src/services/githubService";
import { NoeticBridge } from "../src/services/noeticBridge";
import type { DeviceTokenResponse } from "../src/types/noetic";

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

console.log("\nSigning in while the app is in the background");
{
  // A stand-in for the page: the app is hidden while the user is in the browser.
  const listeners: Array<() => void> = [];
  const doc = {
    visibilityState: "visible",
    addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.splice(listeners.indexOf(fn), 1),
  };
  (globalThis as any).document = doc;
  const show = (visible: boolean) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    listeners.slice().forEach((fn) => fn());
  };

  {
    const errors = Array.from({ length: 30 }, () => new Error("request failed in background"));
    script([...errors, res({ status: "approved", access_token: "late" })]);
    const { log } = run({ interval: 5 });
    show(false);
    await advance(150_000);
    eq("failures while hidden never end the sign-in", log, []);
    show(true);
    await advance(10_000);
    eq("...and it completes once the app is back", log, ["approved:late"]);
  }
  {
    const calls = script([res({}), res({ status: "approved", access_token: "now" })]);
    const { log } = run({ interval: 5 });
    await advance(5_000);
    show(false);
    now += 90_000; // timers did not run at all while hidden
    show(true);
    await advance(0);
    eq("returning to the app checks straight away", [calls.length, log], [2, ["approved:now"]]);
  }
  {
    const calls = script([res({}), res({})]);
    const { stop } = run({ interval: 5 });
    await advance(5_000);
    show(false);
    now += 2_000;
    show(true);
    await advance(2_999);
    eq("...but never sooner than GitHub's interval", calls.length, 1);
    await advance(1_000);
    eq("...nor before the extra second that avoids a 'slow down'", calls.length, 1);
    await advance(1);
    eq("...then on time", calls.length, 2);
    stop();
  }
  {
    script([new Error("e1"), new Error("e2"), new Error("e3"), new Error("e4")]);
    const { log } = run({ interval: 5 });
    await advance(120_000);
    eq("failures while visible still give up", log, ["failed:e4"]);
  }
  {
    const { log, stop } = run({ interval: 5 });
    stop();
    eq("stopping removes the listener", [listeners.length, log], [0, []]);
  }
  {
    script([]);
    const log: string[] = [];
    pollDeviceFlow({ deviceCode: "dc", interval: 5, expiresIn: 900, expiresAt: now + 12_000, onApproved: () => {}, onFailure: (m) => void log.push(m) });
    await advance(30_000);
    eq("a resumed sign-in keeps the original expiry", log.length === 1 && log[0].startsWith("That code expired"), true);
  }
  delete (globalThis as any).document;
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
  eq("native failure is reported as itself", await rejection(NoeticBridge.startDeviceFlow()), "Couldn't connect to GitHub: timed out");
  eq("native failure on poll too", await rejection(NoeticBridge.pollDeviceToken("dc")), "Couldn't connect to GitHub: timed out");

  // Plain browser with no backend: a clear message instead of "Unknown command".
  delete (globalThis as any).window;
  (globalThis as any).fetch = async () => {
    throw new Error("no server");
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const msg = await rejection(NoeticBridge.startDeviceFlow());
  console.warn = origWarn;
  eq("browser-only: explains instead of 'Unknown command'", msg.startsWith("Signing in with GitHub works in the Noetic"), true);
}

console.log("\nSign-in renewal (expiring tokens)");
{
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const user = { login: "me", name: "Me", avatar_url: "", email: null, html_url: "" };
  const refreshCalls: string[] = [];
  const configWrites: string[] = [];
  let refreshAnswer: () => Promise<DeviceTokenResponse> = async () => res({});
  (NoeticBridge as any).refreshGitHubToken = async (rt: string) => {
    refreshCalls.push(rt);
    return refreshAnswer();
  };
  (NoeticBridge as any).setVaultConfig = async (_p: string, cfg: { github_token: string }) => {
    configWrites.push(cfg.github_token);
    return {};
  };
  const origWarn = console.warn;
  console.warn = () => {};

  GitHubService.saveGitHubAuth("tok1", user, res({
    status: "approved", access_token: "tok1", refresh_token: "r1", expires_in: 8 * 3600, refresh_token_expires_in: 180 * 86400,
  }));
  eq("fresh token is used as is", await GitHubService.getValidToken(), "tok1");
  eq("...without renewing", refreshCalls.length, 0);

  now += 8 * 3600 * 1000 - 5 * 60 * 1000; // 5 minutes left
  refreshAnswer = async () => res({ status: "approved", access_token: "tok2", refresh_token: "r2", expires_in: 8 * 3600 });
  const [a, b] = await Promise.all([GitHubService.getValidToken(), GitHubService.getValidToken()]);
  eq("near expiry the token is renewed", [a, b], ["tok2", "tok2"]);
  eq("...once, even when asked twice at the same time", refreshCalls, ["r1"]);
  eq("...and the new refresh token is kept", GitHubService.getStoredGitHubAuth()?.refreshToken, "r2");

  now += 8 * 3600 * 1000;
  refreshAnswer = async () => {
    throw new Error("offline");
  };
  eq("offline: keeps the saved sign-in", await GitHubService.getValidToken(), "tok2");
  eq("...and stays signed in", GitHubService.getStoredGitHubAuth()?.needsSignIn, undefined);

  // A save turned down by GitHub renews and retries once.
  refreshAnswer = async () => res({ status: "approved", access_token: "tok3", refresh_token: "r3", expires_in: 8 * 3600 });
  let attempts = 0;
  const out = await GitHubService.withFreshSignIn("/vault", async () => {
    attempts++;
    if (attempts === 1 && configWrites.at(-1) !== "tok3") throw new Error("Your sign-in was not accepted.");
    return "saved";
  });
  eq("cloud operations run with the renewed token", [out, configWrites.at(-1)], ["saved", "tok3"]);

  // A refused refresh token: kept signed in on this device but asked to sign in again.
  GitHubService.saveGitHubAuth("old", user, res({ status: "approved", access_token: "old", refresh_token: "dead", expires_in: 1 }));
  refreshAnswer = async () => res({ status: "expired" });
  now += 10_000;
  eq("refused refresh token: returns the old token", await GitHubService.getValidToken(), "old");
  eq("...and marks that signing in again is needed", GitHubService.getStoredGitHubAuth()?.needsSignIn, true);

  // Tokens that never expire are never renewed.
  GitHubService.saveGitHubAuth("forever", user);
  refreshCalls.length = 0;
  eq("non-expiring token is used as is", await GitHubService.getValidToken(true), "forever");
  eq("...with no renewal", refreshCalls.length, 0);

  // Start-up check of a sign-in saved before renewal existed (no refresh token).
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  GitHubService.saveGitHubAuth("legacy", user);
  eq("lapsed old sign-in: asks to sign in once more", await GitHubService.checkSignIn(), "needs-sign-in");
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  GitHubService.saveGitHubAuth("legacy-ok", user);
  eq("working old sign-in: left alone", await GitHubService.checkSignIn(), "ok");
  (globalThis as any).fetch = async () => {
    throw new Error("offline");
  };
  eq("offline: never counts against the sign-in", await GitHubService.checkSignIn(), "unknown");
  eq("...and nothing is marked", GitHubService.getStoredGitHubAuth()?.needsSignIn, undefined);
  GitHubService.saveGitHubAuth("fresh", user, res({ status: "approved", access_token: "fresh", refresh_token: "rf", expires_in: 8 * 3600 }));
  eq("signing in again clears the prompt", await GitHubService.checkSignIn(), "ok");
  (globalThis as any).fetch = origFetch;
  console.warn = origWarn;
}

if (failures) {
  console.log(`\n${failures} test(s) failed\n`);
  process.exit(1);
}
console.log("\nAll device-flow tests passed\n");
