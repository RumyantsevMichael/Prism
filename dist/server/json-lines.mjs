// Generated from src/server/json-lines.mts by scripts/native-build/compile.mjs.
import { EventEmitter } from "node:events";
function readJsonLines(stream) {
  const reader = new EventEmitter();
  let parts = [];
  let closed = false;
  const emitLine = (line) => reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  const close = () => {
    if (closed) return;
    closed = true;
    const rest = parts.join("");
    parts = [];
    if (rest) emitLine(rest);
    reader.emit("close");
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
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
function jsonLine(value) {
  return `${JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) => character === "\u2028" ? "\\u2028" : "\\u2029")}
`;
}
export {
  jsonLine,
  readJsonLines
};
