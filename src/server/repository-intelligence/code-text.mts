// Source text helpers for analyses that count code tokens: comments and string contents must not count as code.

export type CodeFamily = "c" | "python" | "rust";

export function codeFamily(file: string): CodeFamily {
  const extension = file.split(".").pop()!.toLowerCase();
  return extension === "py" ? "python" : extension === "rs" ? "rust" : "c";
}

// Replace comments and the contents of string literals with spaces, so that offsets and line breaks stay in place.
// Rust uses a single quote for lifetimes, so only double quotes start a Rust string.
// With keepStrings, only comments are replaced, for analyses that read literal values.
export function codeOnly(text: string, family: CodeFamily, keepStrings = false) {
  const output = text.split("");
  const blank = (start: number, end: number) => { for (let index = start; index < end; index++) if (output[index] !== "\n") output[index] = " "; };
  let index = 0;
  while (index < text.length) {
    const character = text[index], next = text[index + 1];
    if (family !== "python" && character === "/" && next === "/") { const end = text.indexOf("\n", index); blank(index, end < 0 ? text.length : end); index = end < 0 ? text.length : end; continue; }
    if (family !== "python" && character === "/" && next === "*") { const end = text.indexOf("*/", index + 2); const stop = end < 0 ? text.length : end + 2; blank(index, stop); index = stop; continue; }
    if (family === "python" && character === "#") { const end = text.indexOf("\n", index); blank(index, end < 0 ? text.length : end); index = end < 0 ? text.length : end; continue; }
    if (family === "python" && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
      const quote = text.slice(index, index + 3), end = text.indexOf(quote, index + 3), stop = end < 0 ? text.length : end + 3;
      if (!keepStrings) blank(index + 3, stop - 3);
      index = stop; continue;
    }
    if (character === '"' || character === "`" || (character === "'" && family !== "rust")) {
      let end = index + 1;
      while (end < text.length && text[end] !== character && !(character !== "`" && text[end] === "\n")) end += text[end] === "\\" ? 2 : 1;
      if (!keepStrings) blank(index + 1, Math.min(end, text.length));
      index = end + 1; continue;
    }
    index++;
  }
  return output.join("");
}

// Identifier tokens of a code text, for set comparisons between units.
export const identifiers = (code: string) => new Set(code.match(/[A-Za-z_$][\w$]*/g) || []);
