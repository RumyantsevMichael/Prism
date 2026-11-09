import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

// JSON allows U+2028 and U+2029 raw inside strings, but Node 24.19's readline also ends a line at them.
// So a message is framed by "\n" alone, and every written message escapes both characters.

export interface JsonLineReader extends EventEmitter {
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

export function readJsonLines(stream: Readable): JsonLineReader {
  const reader = new EventEmitter() as JsonLineReader;
  let pending = "";
  let closed = false;
  const emitLine = (line: string) => reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  const close = () => {
    if (closed) return;
    closed = true;
    if (pending) emitLine(pending);
    pending = "";
    reader.emit("close");
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let start = 0;
    let end = pending.indexOf("\n");
    while (end !== -1) {
      emitLine(pending.slice(start, end));
      start = end + 1;
      end = pending.indexOf("\n", start);
    }
    pending = pending.slice(start);
  });
  stream.on("end", close);
  stream.on("close", close);
  return reader;
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) => (character === "\u2028" ? "\\u2028" : "\\u2029"))}\n`;
}
