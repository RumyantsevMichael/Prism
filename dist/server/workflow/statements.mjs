// Generated from src/server/workflow/statements.mts by scripts/native-build/compile.mjs.
const LINK = /!?\[([^\]]*)\]\([^)\s]*\)/g;
const FIELD = /^([A-Z][A-Za-z ]*):\s+(\S.*?)\s*$/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const ANCHOR = /^\s*<a id="[^"]*"><\/a>\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const GHERKIN_KEYWORD = /^(Feature|Rule|Background|Example|Scenario|Scenario Outline|Scenario Template|Examples|Scenarios):\s*(.*)$/;
const GHERKIN_STEP = /^(Given|When|Then|And|But|\*)\s+(.*)$/;
function normalizeStatement(text) {
  return String(text).replace(LINK, "$1").replace(/[*_]/g, "").replace(/\s+/g, " ").trim();
}
function sentences(lines, extra = {}) {
  let joined = "";
  const starts = [];
  for (const { value, line } of lines) {
    if (joined) joined += " ";
    starts.push({ offset: joined.length, line });
    joined += value.trim();
  }
  const lineAt = (offset) => starts.filter((start) => start.offset <= offset).at(-1)?.line ?? lines[0].line;
  const found = [];
  let from = 0;
  const push = (to) => {
    const piece = joined.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const text = piece.trim();
    if (text) found.push({ text, line: lineAt(from + lead), ...extra });
  };
  for (const match of joined.matchAll(/[.!?](\s+)/g)) {
    push(match.index + 1);
    from = match.index + match[0].length;
  }
  push(joined.length);
  return found;
}
const tableCells = (value) => value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
function markdownStatements(text, fields) {
  const lines = text.split(/\r?\n/).map((value, index) => ({ value, line: index + 1 }));
  const found = [];
  let unit = [];
  let table = null;
  const flush = () => {
    if (unit.length) found.push(...sentences(unit, { field: null }));
    unit = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const { value } = item;
    const fence = FENCE.exec(value);
    if (fence) {
      flush();
      table = null;
      const marker = fence[1];
      const body = [];
      let end = index + 1;
      const closes = (line) => {
        const closing = /^(`{3,}|~{3,})\s*$/.exec(line.trim());
        return closing !== null && closing[1][0] === marker[0] && closing[1].length >= marker.length;
      };
      while (end < lines.length && !closes(lines[end].value)) body.push(lines[end++].value);
      const block = body.join("\n").trim();
      if (block) found.push({ text: block, line: item.line, field: null });
      index = end;
      continue;
    }
    if (value.trim() === "") {
      flush();
      table = null;
      continue;
    }
    if (HEADING.test(value) || ANCHOR.test(value) || RULE.test(value)) {
      flush();
      table = null;
      continue;
    }
    if (value.trim().startsWith("|")) {
      flush();
      if (TABLE_SEPARATOR.test(value)) {
        table = "body";
        continue;
      }
      if (table === null) {
        table = "header";
        continue;
      }
      for (const cell of tableCells(value)) if (cell) found.push(...sentences([{ value: cell, line: item.line }], { field: null }));
      continue;
    }
    table = null;
    const quote = QUOTE.exec(value);
    if (quote) {
      flush();
      if (quote[1].trim()) found.push(...sentences([{ value: quote[1], line: item.line }], { field: null }));
      continue;
    }
    const field = FIELD.exec(value.trim());
    if (field && fields.has(field[1])) {
      flush();
      found.push(...sentences([{ value: field[2], line: item.line }], { field: field[1] }));
      continue;
    }
    const listed = LIST_ITEM.exec(value);
    if (listed) {
      flush();
      unit.push({ value: listed[1], line: item.line });
      continue;
    }
    unit.push(item);
  }
  flush();
  return found;
}
function gherkinStatements(text) {
  const lines = text.split(/\r?\n/).map((value, index) => ({ value, line: index + 1 }));
  const found = [];
  let table = false;
  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const value = item.value.trim();
    if (value.startsWith('"""') || value.startsWith("```")) {
      const marker = value.slice(0, 3);
      const body = [];
      let end = index + 1;
      while (end < lines.length && !lines[end].value.trim().startsWith(marker)) body.push(lines[end++].value);
      const block = body.join("\n").trim();
      if (block) found.push({ text: block, line: item.line, field: null });
      index = end;
      table = false;
      continue;
    }
    if (value === "" || value.startsWith("#") || value.startsWith("@")) {
      table = false;
      continue;
    }
    if (value.startsWith("|")) {
      if (TABLE_SEPARATOR.test(value)) continue;
      if (!table) {
        table = true;
        continue;
      }
      for (const cell of tableCells(value)) if (cell) found.push({ text: cell, line: item.line, field: null });
      continue;
    }
    table = false;
    const keyword = GHERKIN_KEYWORD.exec(value);
    if (keyword) {
      if (keyword[2].trim()) found.push({ text: keyword[2].trim(), line: item.line, field: keyword[1] });
      continue;
    }
    const step = GHERKIN_STEP.exec(value);
    if (step) {
      found.push({ text: step[2].trim(), line: item.line, field: step[1] });
      continue;
    }
    found.push(...sentences([{ value, line: item.line }], { field: null }));
  }
  return found;
}
function splitStatements(text, { gherkin = false, fields = [] } = {}) {
  return gherkin ? gherkinStatements(String(text)) : markdownStatements(String(text), new Set(fields));
}
export {
  normalizeStatement,
  splitStatements
};
