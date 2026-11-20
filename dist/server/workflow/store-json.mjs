// Generated from src/server/workflow/store-json.mts by scripts/native-build/compile.mjs.
const JSON_DEPTH_MAX = 64;
function nestedDeeperThan(value, max = JSON_DEPTH_MAX) {
  if (!value || typeof value !== "object") return false;
  const frames = [{ item: value, keys: Array.isArray(value) ? null : Object.keys(value), at: 0 }];
  while (frames.length) {
    const frame = frames.at(-1);
    const length = frame.keys ? frame.keys.length : frame.item.length;
    if (frame.at >= length) {
      frames.pop();
      continue;
    }
    const child = frame.keys ? frame.item[frame.keys[frame.at]] : frame.item[frame.at];
    frame.at += 1;
    if (!child || typeof child !== "object") continue;
    if (frames.length >= max) return true;
    frames.push({ item: child, keys: Array.isArray(child) ? null : Object.keys(child), at: 0 });
  }
  return false;
}
const OPEN_SQUARE = 91, OPEN_CURLY = 123, CLOSE_SQUARE = 93, CLOSE_CURLY = 125, QUOTE = 34, BACKSLASH = 92;
function textNestedDeeperThan(text, max) {
  let depth = 0, inString = false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (inString) {
      if (code === BACKSLASH) at += 1;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) inString = true;
    else if (code === OPEN_SQUARE || code === OPEN_CURLY) {
      if (++depth > max) return true;
    } else if (code === CLOSE_SQUARE || code === CLOSE_CURLY) depth -= 1;
  }
  return false;
}
function parseStoreJson(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  if (typeof text === "string" && textNestedDeeperThan(text, JSON_DEPTH_MAX)) throw new SyntaxError(`The JSON nests arrays and objects deeper than ${JSON_DEPTH_MAX} levels.`);
  return JSON.parse(text);
}
export {
  JSON_DEPTH_MAX,
  nestedDeeperThan,
  parseStoreJson
};
