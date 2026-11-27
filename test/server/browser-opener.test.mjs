import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const { browserOpeners, openBrowser } = await import("../../dist/server/review/browser-opener.mjs");

const URL_WITH_QUERY = "http://127.0.0.1:4100/session/abc/w/one/review?artifact=a&lane=b#write=grant";

// A stand-in for spawn whose children behave as each named command's entry says: fail to start, exit with a code, or keep running.
function fakeSpawn(behaviors) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    const behavior = behaviors[command] ?? { error: "ENOENT" };
    queueMicrotask(() => {
      if (behavior.error) child.emit("error", Object.assign(new Error(`spawn ${command} ${behavior.error}`), { code: behavior.error }));
      else if (behavior.exit !== undefined) child.emit("exit", behavior.exit, null);
    });
    return child;
  };
  return { spawnProcess, calls };
}

test("each system opens the URL through its own opener, and WSL tries the Windows URL handler before the Linux openers", () => {
  assert.deepEqual(browserOpeners(URL_WITH_QUERY, { platform: "darwin" }), [{ command: "open", args: [URL_WITH_QUERY] }]);
  assert.deepEqual(browserOpeners(URL_WITH_QUERY, { platform: "win32" }), [{ command: "rundll32", args: ["url.dll,FileProtocolHandler", URL_WITH_QUERY] }]);
  assert.deepEqual(browserOpeners(URL_WITH_QUERY, { platform: "linux", wsl: false }), [{ command: "xdg-open", args: [URL_WITH_QUERY] }]);
  assert.deepEqual(browserOpeners(URL_WITH_QUERY, { platform: "linux", wsl: true }).map(({ command }) => command), ["rundll32.exe", "wslview", "xdg-open"]);
  assert.deepEqual(browserOpeners(URL_WITH_QUERY, { platform: "linux", wsl: true })[0].args, ["url.dll,FileProtocolHandler", URL_WITH_QUERY], "the URL with its query and fragment is one argument");
});

test("an opener that exits cleanly opens the browser, from the home folder and without a window", async () => {
  const { spawnProcess, calls } = fakeSpawn({ "xdg-open": { exit: 0 } });
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: false, spawnProcess }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, "ignore");
});

test("a missing or failing opener answers false instead of reporting a browser that never opened", async () => {
  const missing = fakeSpawn({});
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: false, spawnProcess: missing.spawnProcess }), false, "xdg-open is not installed");
  const failing = fakeSpawn({ "xdg-open": { exit: 3 } });
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: false, spawnProcess: failing.spawnProcess }), false, "xdg-open found no browser");
  const thrown = (command) => { throw Object.assign(new Error(`spawn ${command} EACCES`), { code: "EACCES" }); };
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "darwin", spawnProcess: thrown }), false, "spawn itself refused");
});

test("WSL falls through to the next opener until one takes the URL", async () => {
  const { spawnProcess, calls } = fakeSpawn({ "wslview": { exit: 1 }, "xdg-open": { exit: 0 } });
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: true, spawnProcess }), true);
  assert.deepEqual(calls.map(({ command }) => command), ["rundll32.exe", "wslview", "xdg-open"]);
  const windows = fakeSpawn({ "rundll32.exe": { exit: 0 } });
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: true, spawnProcess: windows.spawnProcess }), true);
  assert.deepEqual(windows.calls.map(({ command }) => command), ["rundll32.exe"], "the Windows URL handler opens the person's Windows browser first");
});

test("an opener still running after the settle time has handed the URL to a browser, and is let go", async () => {
  const { spawnProcess, calls } = fakeSpawn({ "xdg-open": {} });
  assert.equal(await openBrowser(URL_WITH_QUERY, { platform: "linux", wsl: false, spawnProcess, settleMs: 20 }), true);
  assert.equal(calls.length, 1);
});
