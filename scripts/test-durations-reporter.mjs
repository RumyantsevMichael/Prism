// A node --test reporter that writes one JSON line per test file with the summed duration of its top-level tests, for scripts/test-shard.mjs --record.
import path from "node:path";

export default async function* durations(source) {
  const seconds = new Map();
  for await (const event of source) {
    if ((event.type !== "test:pass" && event.type !== "test:fail") || event.data.nesting !== 0 || !event.data.file) continue;
    const file = path.basename(event.data.file);
    // A file that fails as a whole reports itself as one top-level test named by its path, which would count its time twice.
    if (path.basename(event.data.name) === file) continue;
    seconds.set(file, (seconds.get(file) ?? 0) + (event.data.details?.duration_ms ?? 0) / 1000);
  }
  for (const [file, total] of seconds) yield `${JSON.stringify({ file, seconds: total })}\n`;
}
