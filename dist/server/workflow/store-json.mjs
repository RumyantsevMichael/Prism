// The one reader of JSON that a record store holds: every record, ledger, status record, comment, identity, and registration that Prism reads is parsed here,
// since a store sync brings files that no Prism checked, and a value nested deep enough makes any later recursive walk of it, such as JSON.stringify, a template literal,
// or Array.prototype.join, exhaust the call stack. A value nested deeper than Prism ever writes is refused as malformed JSON, so each reader treats it as it treats a damaged file.
// Both checks take memory only by the nesting depth, never by the number of values, so a wide file within its bound is read in no more memory than JSON.parse takes for it.

/** The deepest nesting of arrays and objects that a JSON value read from the store may hold; Prism's own records stay far below it. */
export const JSON_DEPTH_MAX = 64;

/**
 * Whether a JSON value nests arrays and objects deeper than max, found without recursion and with one frame per level of the path being walked,
 * so a caller can set aside a value that serializing would exhaust the call stack on.
 */
export function nestedDeeperThan(value, max = JSON_DEPTH_MAX) {
  if (!value || typeof value !== "object") return false;
  // Each frame holds one array or object, the keys of an object, and the position of the next child to visit.
  const frames = [{ item: value, keys: Array.isArray(value) ? null : Object.keys(value), at: 0 }];
  while (frames.length) {
    const frame = frames.at(-1);
    const length = frame.keys ? frame.keys.length : frame.item.length;
    if (frame.at >= length) { frames.pop(); continue; }
    const child = frame.keys ? frame.item[frame.keys[frame.at]] : frame.item[frame.at];
    frame.at += 1;
    if (!child || typeof child !== "object") continue;
    if (frames.length >= max) return true;
    frames.push({ item: child, keys: Array.isArray(child) ? null : Object.keys(child), at: 0 });
  }
  return false;
}

const OPEN_SQUARE = 0x5b, OPEN_CURLY = 0x7b, CLOSE_SQUARE = 0x5d, CLOSE_CURLY = 0x7d, QUOTE = 0x22, BACKSLASH = 0x5c;

/** Whether JSON text nests arrays and objects deeper than max, read by its brackets outside strings with one counter, so the check needs no memory beyond the text. */
function textNestedDeeperThan(text, max) {
  let depth = 0, inString = false;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (inString) {
      if (code === BACKSLASH) at += 1;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) inString = true;
    else if (code === OPEN_SQUARE || code === OPEN_CURLY) { if (++depth > max) return true; }
    else if (code === CLOSE_SQUARE || code === CLOSE_CURLY) depth -= 1;
  }
  return false;
}

/**
 * The value of JSON text or UTF-8 bytes, as JSON.parse gives it, or a SyntaxError for text that is no JSON or whose value nests arrays and objects deeper than JSON_DEPTH_MAX,
 * so every caller that sets aside a file that does not parse sets aside such a file too.
 * The depth is read from the text before it is parsed, so a value too deep is refused before any of it is built.
 */
export function parseStoreJson(source) {
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  if (typeof text === "string" && textNestedDeeperThan(text, JSON_DEPTH_MAX)) throw new SyntaxError(`The JSON nests arrays and objects deeper than ${JSON_DEPTH_MAX} levels.`);
  return JSON.parse(text);
}
