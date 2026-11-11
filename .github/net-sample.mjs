// Temporary diagnostic: samples the TCP table, by state and owning process, and the memory every 15 s on Windows.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const out = process.argv[2];
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
appendFileSync(out, run("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]));
for (;;) {
  try {
    const tasks = run("tasklist", ["/FO", "CSV", "/NH"]).trim().split(/\r?\n/).map((l) => l.replace(/^"|"$/g, "").split('","'));
    const names = new Map(tasks.map((c) => [c[1], c[0]]));
    const memory = {};
    for (const c of tasks) {
      const kb = Number(c[4].replace(/[^0-9]/g, ""));
      memory[c[0]] = memory[c[0]] ?? { count: 0, mb: 0 };
      memory[c[0]].count += 1;
      memory[c[0]].mb += Math.round(kb / 1024);
    }
    const counters = run("powershell", ["-NoProfile", "-Command", "(Get-Counter '\\Memory\\Available MBytes','\\Memory\\Pool Nonpaged Bytes','\\Memory\\Committed Bytes','\\Memory\\Commit Limit').CounterSamples | ForEach-Object { $_.Path.Split('\\')[-1] + '=' + [math]::Round($_.CookedValue) }"]).trim().split(/\r?\n/).join(" ");
    const heavy = Object.entries(memory).sort((a, b) => b[1].mb - a[1].mb).slice(0, 4).map(([k, v]) => `${k}x${v.count}=${v.mb}MB`).join(" ");
    const rows = run("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c[0] === "TCP");
    const states = {}, owners = {}, waitByRemote = {};
    for (const [, local, remote, state, pid] of rows) {
      states[state] = (states[state] ?? 0) + 1;
      const key = `${names.get(pid) ?? "?"}:${pid}:${state}`;
      owners[key] = (owners[key] ?? 0) + 1;
      if (state === "TIME_WAIT") { const r = remote.split(":").pop(); waitByRemote[r] = (waitByRemote[r] ?? 0) + 1; }
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(" ");
    appendFileSync(out, `${new Date().toISOString()} memory: ${counters} | ${heavy}\n`);
    appendFileSync(out, `${new Date().toISOString()} total=${rows.length} ${top(states, 6)}\n  owners: ${top(owners, 6)}\n  time_wait by remote port: ${top(waitByRemote, 6)}\n`);
  } catch (error) {
    appendFileSync(out, `${new Date().toISOString()} sample failed: ${error.message}\n`);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
