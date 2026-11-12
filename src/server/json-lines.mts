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
  // The chunks of the unfinished line. Each chunk is searched once and joined once, so a line of many megabytes costs time in proportion
  // to its length; appending to one string and searching it again from the start after each chunk took minutes for a large index.
  let parts: string[] = [];
  let closed = false;
  const emitLine = (line: string) => reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  const close = () => {
    if (closed) return;
    closed = true;
    const rest = parts.join("");
    parts = [];
    if (rest) emitLine(rest);
    reader.emit("close");
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    let end = chunk.indexOf("\n");
    while (end !== -1) {
      parts.push(chunk.slice(start, end));
      const line = parts.join("");
      parts = [];
      emitLine(line);
      start = end + 1;
      end = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
  stream.on("end", close);
  stream.on("close", close);
  return reader;
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) => (character === "\u2028" ? "\\u2028" : "\\u2029"))}\n`;
}
