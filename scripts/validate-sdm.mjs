#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const supportedVersions = new Set(["0.3"]);

function sourceLines(document) {
  const lines = document.split(/\r?\n/);
  let fence = null;

  return lines.map((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (fence === null) {
        fence = match[1][0];
      } else if (fence === match[1][0]) {
        fence = null;
      }
      return "";
    }
    return fence === null ? line : "";
  });
}

function frontmatter(document) {
  const lines = document.split(/\r?\n/);
  if (lines[0] !== "---") {
    return null;
  }

  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return null;
  }

  return lines.slice(1, end);
}

function headingWarnings(lines) {
  const warnings = [];
  const roots = new Map();
  const stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) {
      continue;
    }

    const level = match[1].length;
    while (stack.length > 0 && stack.at(-1).level >= level) {
      stack.pop();
    }
    const parent = stack.at(-1)?.children ?? roots;
    const entry = {
      children: new Map(),
      line: index + 1,
      numbered: /^\d+(?:\.\d+)*\.\s/.test(match[2])
    };
    const siblings = parent.get(level) ?? [];
    siblings.push(entry);
    parent.set(level, siblings);
    stack.push({ level, children: entry.children });
  }

  function check(groups) {
    for (const siblings of groups.values()) {
      if (siblings.some((heading) => heading.numbered) && siblings.some((heading) => !heading.numbered)) {
        warnings.push({
          line: siblings[0].line,
          message: "sibling headings mix numbered and unnumbered forms"
        });
      }
      for (const heading of siblings) {
        check(heading.children);
      }
    }
  }

  check(roots);
  return warnings;
}

function doBlockWarnings(lines) {
  const warnings = [];
  const marker = /^(\s*)(?:[-*+]|\d+[.)])\s+(Do|Don't)\s*$/;
  const child = /^(\s+)(?:[-*+]|\d+[.)])\s+/;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(marker);
    if (!match) {
      continue;
    }

    let next = index + 1;
    while (next < lines.length && lines[next].trim() === "") {
      next += 1;
    }
    const nested = lines[next]?.match(child);
    if (!nested || nested[1].length <= match[1].length) {
      warnings.push({
        line: index + 1,
        message: `\`${match[2]}\` needs a nested list`
      });
    }
  }

  return warnings;
}

function negativeActionWarnings(lines) {
  const warnings = [];
  const action = /^\s*(?:[-*+]|\d+[.)])\s+Do not\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    if (action.test(lines[index])) {
      warnings.push({
        line: index + 1,
        message: "use a declarative prohibition or a `Don't` block instead of a `Do not` action"
      });
    }
  }

  return warnings;
}

export function validateSkillDocument(document) {
  const errors = [];
  const warnings = [];
  const metadata = frontmatter(document);

  if (metadata === null) {
    errors.push({ line: 1, message: "a skill needs YAML frontmatter" });
    return { errors, warnings };
  }

  const sdm = metadata.find((line) => /^sdm:\s*/.test(line));
  const version = sdm?.match(/^sdm:\s*"([^"]+)"\s*$/)?.[1];
  if (version === undefined) {
    errors.push({ line: 1, message: "a skill needs a quoted `sdm` version" });
  } else if (!supportedVersions.has(version)) {
    errors.push({ line: 1, message: `unsupported SDM version \`${version}\`` });
  }

  const lines = sourceLines(document);
  warnings.push(...headingWarnings(lines));
  warnings.push(...doBlockWarnings(lines));
  warnings.push(...negativeActionWarnings(lines));
  return { errors, warnings };
}

export async function validateRepositorySkills(root) {
  const skillsDirectory = path.join(root, "skills");
  const entries = await readdir(skillsDirectory, { withFileTypes: true });
  const results = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(skillsDirectory, entry.name, "SKILL.md");
    try {
      const document = await readFile(file, "utf8");
      results.push({ file: path.relative(root, file), ...validateSkillDocument(document) });
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return results;
}

async function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const results = await validateRepositorySkills(root);
  let errorCount = 0;
  let warningCount = 0;

  for (const result of results) {
    for (const issue of result.errors) {
      errorCount += 1;
      console.error(`${result.file}:${issue.line}: error: ${issue.message}`);
    }
    for (const issue of result.warnings) {
      warningCount += 1;
      console.warn(`${result.file}:${issue.line}: warning: ${issue.message}`);
    }
  }

  console.log(`SDM validation checked ${results.length} skill files with ${warningCount} warnings.`);
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
