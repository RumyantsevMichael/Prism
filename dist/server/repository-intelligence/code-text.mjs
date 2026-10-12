// Generated from src/server/repository-intelligence/code-text.mts by scripts/native-build/compile.mjs.
function codeFamily(file) {
  const extension = file.split(".").pop().toLowerCase();
  return extension === "py" ? "python" : extension === "rs" ? "rust" : "c";
}
function codeOnly(text, family, keepStrings = false) {
  const output = text.split("");
  const blank = (start, end) => {
    for (let index2 = start; index2 < end; index2++) if (output[index2] !== "\n") output[index2] = " ";
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index], next = text[index + 1];
    if (family !== "python" && character === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      blank(index, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (family !== "python" && character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (family === "python" && character === "#") {
      const end = text.indexOf("\n", index);
      blank(index, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (family === "python" && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
      const quote = text.slice(index, index + 3), end = text.indexOf(quote, index + 3), stop = end < 0 ? text.length : end + 3;
      if (!keepStrings) blank(index + 3, stop - 3);
      index = stop;
      continue;
    }
    if (character === '"' || character === "`" || character === "'" && family !== "rust") {
      let end = index + 1;
      while (end < text.length && text[end] !== character && !(character !== "`" && text[end] === "\n")) end += text[end] === "\\" ? 2 : 1;
      if (!keepStrings) blank(index + 1, Math.min(end, text.length));
      index = end + 1;
      continue;
    }
    index++;
  }
  return output.join("");
}
const identifiers = (code) => new Set(code.match(/[A-Za-z_$][\w$]*/g) || []);
export {
  codeFamily,
  codeOnly,
  identifiers
};
