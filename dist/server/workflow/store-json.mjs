// The one reader of JSON that a record store holds: every record, ledger, status record, comment, identity, and registration that Prism reads is parsed here,
// since a store sync brings files that no Prism checked, and a value nested deep enough makes any later recursive walk of it, such as JSON.stringify, a template literal,
// or Array.prototype.join, exhaust the call stack. A value nested deeper than Prism ever writes is refused as malformed JSON, so each reader treats it as it treats a damaged file.

/** The deepest nesting of arrays and objects that a JSON value read from the store may hold; Prism's own records stay far below it. */
export const JSON_DEPTH_MAX = 64;

/** Whether a JSON value nests arrays and objects deeper than max, found without recursion, so a caller can set aside a value that serializing would exhaust the call stack on. */
export function nestedDeeperThan(value, max = JSON_DEPTH_MAX) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item)) if (child && typeof child === "object") pending.push([child, depth + 1]);
  }
  return false;
}

/**
 * The value of JSON text or UTF-8 bytes, as JSON.parse gives it, or a SyntaxError for text that is no JSON or whose value nests arrays and objects deeper than JSON_DEPTH_MAX,
 * so every caller that sets aside a file that does not parse sets aside such a file too.
 */
export function parseStoreJson(source) {
  const value = JSON.parse(Buffer.isBuffer(source) ? source.toString("utf8") : source);
  if (nestedDeeperThan(value)) throw new SyntaxError(`The JSON nests arrays and objects deeper than ${JSON_DEPTH_MAX} levels.`);
  return value;
}
