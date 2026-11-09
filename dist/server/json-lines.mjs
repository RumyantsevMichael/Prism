// Generated from src/server/json-lines.mts by scripts/native-build/compile.mjs.
import { EventEmitter } from "node:events";
function readJsonLines(stream) {
  const reader = new EventEmitter();
  let pending = "";
  let closed = false;
  const emitLine = (line) => reader.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  const close = () => {
    if (closed) return;
    closed = true;
    if (pending) emitLine(pending);
    pending = "";
    reader.emit("close");
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
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
function jsonLine(value) {
  return `${JSON.stringify(value).replace(/[\u2028\u2029]/g, (character) => character === "\u2028" ? "\\u2028" : "\\u2029")}
`;
}
export {
  jsonLine,
  readJsonLines
};
