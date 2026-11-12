// The formats of Prism's normative artifacts: requirement files, ADRs, the glossary, and feature files.
// Each format's reference under skills/ states the same version, rule ids, and defaults, and holds an example that these checks accept.

const MAX_TEXT_BYTES = 1024 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN = "unknown";
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/;
const LINK_LIST = /^\[[^\]]*\]\([^)\s]+\)(\s*,\s*\[[^\]]*\]\([^)\s]+\))*$/;
const TERM_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const finding = (rule, line, message) => ({ rule, line, message });

function validDate(value) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// The text of an artifact, or a finding of its text rule: a Buffer must be UTF-8 and any text at most 1 MiB.
function decode(type, input) {
  if (typeof input === "string") {
    return Buffer.byteLength(input, "utf8") > MAX_TEXT_BYTES ? { failure: finding(`${type}.text`, null, "The file is larger than 1 MiB.") } : { text: input };
  }
  if (input instanceof Uint8Array) {
    if (input.length > MAX_TEXT_BYTES) return { failure: finding(`${type}.text`, null, "The file is larger than 1 MiB.") };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(input) };
    } catch {
      return { failure: finding(`${type}.text`, null, "The file is not UTF-8 text.") };
    }
  }
  return { failure: finding(`${type}.text`, null, "The artifact has no text.") };
}

// Lines with their 1-based numbers, and whether each sits inside a fenced code block.
function linesOf(text) {
  const result = [];
  let fence = null;
  text.split(/\r?\n/).forEach((value, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(value);
    const inside = fence !== null;
    if (marker && (fence === null || (marker[1][0] === fence[0] && marker[1].length >= fence.length))) fence = fence === null ? marker[1] : null;
    result.push({ value, line: index + 1, fenced: inside || Boolean(marker) });
  });
  return result;
}

const blank = (item) => item.value.trim() === "";

// Groups non-blank lines into paragraphs.
function paragraphs(items) {
  const result = [];
  let current = null;
  for (const item of items) {
    if (blank(item) && !item.fenced) {
      current = null;
      continue;
    }
    if (!current) result.push(current = []);
    current.push(item);
  }
  return result;
}

// The level-two sections of a Markdown file: the lines before the first, and each heading with its body.
function markdownSections(items) {
  const sections = [];
  const head = [];
  let current = null;
  for (const [index, item] of items.entries()) {
    const heading = !item.fenced && /^##\s+(.*?)\s*$/.exec(item.value);
    if (heading) {
      current = { title: heading[1], line: item.line, index, body: [] };
      sections.push(current);
      continue;
    }
    (current ? current.body : head).push(item);
  }
  return { head, sections };
}

const bodyText = (body) => body.filter((item) => !blank(item)).map((item) => item.value.trim()).join("\n");

// A header that starts with `Label: value` lines in a fixed order; returns the values by label.
function header(type, head, labels, findings) {
  const fields = head.filter((item) => !blank(item) && item.line > 1 && !/^<a id=/.test(item.value));
  const found = fields.map((item) => ({ item, match: /^([A-Za-z][A-Za-z ]*):\s*(.*?)\s*$/.exec(item.value) }));
  const order = found.map((entry) => entry.match?.[1] ?? null);
  const values = {};
  for (const entry of found) if (entry.match && !(entry.match[1] in values)) values[entry.match[1]] = { value: entry.match[2], line: entry.item.line };
  // Further `Label: value` lines may follow the required ones, as an ADR's Accepted or Supersedes line does.
  if (order.length < labels.length || labels.some((label, index) => order[index] !== label) || order.slice(labels.length).some((label) => label === null || labels.includes(label))) {
    const missing = labels.filter((label) => !order.includes(label));
    const detail = missing.length ? `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing` : `found ${order.map((label) => label ?? "text").join(", ")}`;
    findings.push(finding(`${type}.header`, fields[0]?.line ?? 1, `The header must be ${labels.map((label) => `${label}:`).join(", then ")} before any section; ${detail}.`));
  }
  return values;
}

function title(type, items, findings, noun) {
  const first = items[0]?.value ?? "";
  if (!/^# \S/.test(first)) findings.push(finding(`${type}.title`, 1, `The first line must be "# <${noun}>".`));
}

const isLinkTo = (target, { anchor }) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) return false;
  const match = /^([^#]*)(?:#([A-Za-z0-9_-]+))?$/.exec(target);
  if (!match) return false;
  if (match[1] === "") return anchor !== "required-path" && anchor !== "optional-path" && match[2] !== undefined;
  if (!match[1].endsWith(".md")) return false;
  if (anchor === "required" || anchor === "required-path") return match[2] !== undefined;
  if (anchor === "none") return match[2] === undefined;
  return true;
};

const linkTargets = (value) => [...value.matchAll(new RegExp(LINK.source, "g"))].map((match) => match[1]);

// ---- Requirement files ----

const REQUIREMENT_SECTIONS = ["Problem", "Goals", "Non-goals", "Design questions"];
const REQUIREMENT_FIELDS = ["Pattern", "Disposition", "Requirement", "Rationale", "Related"];
const PATTERNS = ["Ubiquitous", "State-driven", "Event-driven", "Optional feature", "Unwanted behavior", "Complex"];

const requirementStatus = (value) => ["Draft", "Approved", "Withdrawn"].includes(value) || /^Superseded by .*\[[^\]]*\]\([^)\s]+\)/.test(value);
const disposition = (value) => value === "Active" || /^Withdrawn(?: \d{4}-\d{2}-\d{2})?(?::\s*\S.*)?$/.test(value) || /^Superseded by .*\[[^\]]*\]\([^)\s]+\)/.test(value);

// The numbered sections of a requirement file with their anchors and fields, as a glossary source resolves them.
export function requirementOutline(text) {
  const items = linesOf(text);
  const { head, sections } = markdownSections(items);
  const status = head.map((item) => /^Status:\s*(.*?)\s*$/.exec(item.value)?.[1]).find((value) => value !== undefined) ?? null;
  const numbered = sections.map((section) => {
    const match = /^(\d+)\.\s+\S/.exec(section.title);
    if (!match) return null;
    const field = (label) => section.body.map((item) => new RegExp(`^${label}:\\s*(.*?)\\s*$`).exec(item.value)?.[1]).find((value) => value !== undefined) ?? null;
    return { number: Number(match[1]), disposition: field("Disposition") };
  }).filter(Boolean);
  return { status, sections: numbered };
}

function inspectRequirements(text) {
  const type = "requirements";
  const findings = [], unknowns = [];
  const items = linesOf(text);
  title(type, items, findings, "capability");
  const { head, sections } = markdownSections(items);
  const values = header(type, head, ["Status", "Created", "Approved"], findings);
  const status = values.Status;
  if (status && !requirementStatus(status.value)) findings.push(finding(`${type}.status`, status.line, `Status must be Draft, Approved, Withdrawn, or Superseded by <link>, not "${status.value}".`));
  for (const label of ["Created", "Approved"]) {
    const entry = values[label];
    if (!entry) continue;
    if (entry.value === UNKNOWN) { unknowns.push({ line: entry.line, field: label }); continue; }
    if (label === "Created" && !validDate(entry.value)) findings.push(finding(`${type}.dates`, entry.line, `Created must be a YYYY-MM-DD date, not "${entry.value}".`));
    if (label === "Approved") {
      if (status?.value === "Approved" && !validDate(entry.value)) findings.push(finding(`${type}.dates`, entry.line, `Approved must be a YYYY-MM-DD date when the status is Approved, not "${entry.value}".`));
      else if (status?.value === "Draft" && entry.value !== "n/a") findings.push(finding(`${type}.dates`, entry.line, `Approved must be n/a while the status is Draft, not "${entry.value}".`));
      else if (status?.value !== "Approved" && status?.value !== "Draft" && entry.value !== "n/a" && !validDate(entry.value)) findings.push(finding(`${type}.dates`, entry.line, `Approved must be a YYYY-MM-DD date or n/a, not "${entry.value}".`));
    }
  }

  const firstNumbered = sections.findIndex((section) => /^\d+\./.test(section.title));
  const named = (firstNumbered === -1 ? sections : sections.slice(0, firstNumbered)).filter((section) => !/^\d+\./.test(section.title));
  const order = named.map((section) => section.title);
  const expected = REQUIREMENT_SECTIONS;
  const counted = expected.filter((name) => order.filter((value) => value === name).length === 1);
  const inOrder = order.filter((name) => expected.includes(name)).join("\n") === expected.join("\n");
  if (counted.length !== expected.length || !inOrder) {
    const missing = expected.filter((name) => !order.includes(name));
    findings.push(finding(`${type}.sections`, named[0]?.line ?? null, `The sections ${expected.map((name) => `## ${name}`).join(", ")} must appear once each in that order before the first numbered section${missing.length ? `; missing ${missing.map((name) => `## ${name}`).join(", ")}` : ""}.`));
  }
  for (const section of named) {
    if (!expected.includes(section.title)) continue;
    const body = bodyText(section.body);
    if (body === UNKNOWN) unknowns.push({ line: section.body.find((item) => !blank(item)).line, field: section.title });
    else if (body === "") findings.push(finding(`${type}.sections`, section.line, `The section ## ${section.title} is empty.`));
  }

  const seen = new Set();
  for (const [position, section] of sections.entries()) {
    if (firstNumbered === -1 || position < firstNumbered) continue;
    const match = /^(\d+)\.\s+\S/.exec(section.title);
    const before = items[section.index - 1];
    const anchor = before && /^<a id="([^"]*)"><\/a>\s*$/.exec(before.value);
    if (!match || Number(match[1]) < 1) {
      findings.push(finding(`${type}.numbering`, section.line, `Each section after the first numbered one must be "## <n>. <title>", not "## ${section.title}".`));
      continue;
    }
    const number = match[1];
    if (!anchor || anchor[1] !== number) findings.push(finding(`${type}.numbering`, section.line, `Section ${number} must directly follow <a id="${number}"></a>.`));
    if (seen.has(number)) findings.push(finding(`${type}.numbering`, section.line, `Section number ${number} repeats.`));
    seen.add(number);
    inspectRequirementSection(section, number, findings, unknowns);
  }
  for (const item of items) {
    if (item.fenced) continue;
    const anchor = /^<a id="([^"]*)"><\/a>\s*$/.exec(item.value);
    if (!anchor) continue;
    const next = items[item.line];
    if (!next || !/^## \d+\./.test(next.value)) findings.push(finding(`${type}.numbering`, item.line, `The anchor ${anchor[1]} must directly precede its numbered section.`));
  }
  return { findings, unknowns };
}

// Related links may end with one period, as lines written to the template before the formats did.
const relatedLinks = (value) => {
  const links = value.replace(/\.$/, "");
  return LINK_LIST.test(links) && linkTargets(links).every((target) => isLinkTo(target, { anchor: "optional" }));
};

function inspectRequirementSection(section, number, findings, unknowns) {
  const type = "requirements";
  const labels = [...REQUIREMENT_FIELDS, "Supersedes"];
  const fields = [];
  for (const item of section.body) {
    if (item.fenced) continue;
    const match = /^([A-Z][A-Za-z ]*):\s*(.*?)\s*$/.exec(item.value);
    if (match && labels.includes(match[1])) fields.push({ label: match[1], value: match[2], line: item.line });
  }
  const order = fields.map((field) => field.label);
  // One optional Supersedes: line may sit anywhere after Disposition:, as the template before the formats placed it.
  const supersedes = order.flatMap((label, index) => (label === "Supersedes" ? [index] : []));
  const valid = order.filter((label) => label !== "Supersedes").join(",") === REQUIREMENT_FIELDS.join(",")
    && supersedes.length <= 1 && supersedes.every((index) => index > order.indexOf("Disposition"));
  if (!valid) {
    const missing = REQUIREMENT_FIELDS.filter((label) => !order.includes(label));
    findings.push(finding(`${type}.fields`, section.line, `Section ${number} must hold ${REQUIREMENT_FIELDS.map((label) => `${label}:`).join(", ")} once each in that order, with at most one optional Supersedes: anywhere after Disposition:${missing.length ? `; ${missing.map((label) => `${label}:`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing` : ""}.`));
  }
  for (const field of fields) {
    if (field.label === "Supersedes") continue;
    if (field.value === UNKNOWN) { unknowns.push({ line: field.line, field: field.label }); continue; }
    if (field.value === "") findings.push(finding(`${type}.fields`, field.line, `Section ${number} has an empty ${field.label}:.`));
    else if (field.label === "Pattern" && !PATTERNS.includes(field.value)) findings.push(finding(`${type}.pattern`, field.line, `Pattern must be one of ${PATTERNS.join(", ")}, not "${field.value}".`));
    else if (field.label === "Disposition" && !disposition(field.value)) findings.push(finding(`${type}.disposition`, field.line, `Disposition must be Active, Withdrawn with an optional date and reason, or Superseded by <link>, not "${field.value}".`));
    else if (field.label === "Related" && field.value !== "n/a" && !relatedLinks(field.value)) {
      findings.push(finding(`${type}.links`, field.line, `Related must be n/a or comma-separated Markdown links to relative .md paths or #anchors, optionally followed by one period, not "${field.value}".`));
    }
  }
}

// ---- ADRs ----

const ADR_SECTIONS = ["Requirements", "Problem", "Decision", "Rationale", "Alternatives", "Consequences", "Mechanism", "Decision Log"];
const adrStatus = (value) => ["Proposed", "Accepted", "Declined"].includes(value) || /^Superseded by .*\[[^\]]*\]\([^)\s]+\)/.test(value);

export function adrStatusOf(text) {
  const { head } = markdownSections(linesOf(text));
  return head.map((item) => /^Status:\s*(.*?)\s*$/.exec(item.value)?.[1]).find((value) => value !== undefined) ?? null;
}

function inspectAdr(text) {
  const type = "adr";
  const findings = [], unknowns = [];
  const items = linesOf(text);
  title(type, items, findings, "decision");
  const { head, sections } = markdownSections(items);
  const values = header(type, head, ["Status", "Created"], findings);
  if (values.Status && !adrStatus(values.Status.value)) findings.push(finding(`${type}.status`, values.Status.line, `Status must be Proposed, Accepted, Declined, or Superseded by <link>, not "${values.Status.value}".`));
  if (values.Created) {
    if (values.Created.value === UNKNOWN) unknowns.push({ line: values.Created.line, field: "Created" });
    else if (!validDate(values.Created.value)) findings.push(finding(`${type}.dates`, values.Created.line, `Created must be a YYYY-MM-DD date, not "${values.Created.value}".`));
  }
  const order = sections.map((section) => section.title).filter((name) => ADR_SECTIONS.includes(name));
  const once = ADR_SECTIONS.every((name) => order.filter((value) => value === name).length === 1);
  if (!once || order.join("\n") !== ADR_SECTIONS.join("\n")) {
    const missing = ADR_SECTIONS.filter((name) => !order.includes(name));
    findings.push(finding(`${type}.sections`, sections[0]?.line ?? null, `The sections ${ADR_SECTIONS.map((name) => `## ${name}`).join(", ")} must appear once each in that order${missing.length ? `; missing ${missing.map((name) => `## ${name}`).join(", ")}` : ""}.`));
  }
  for (const section of sections) {
    if (!ADR_SECTIONS.includes(section.title)) continue;
    const body = bodyText(section.body);
    if (body === UNKNOWN) { unknowns.push({ line: section.body.find((item) => !blank(item)).line, field: section.title }); continue; }
    if (body === "") {
      // Only the Decision Log may be empty, as the template before the formats left it until a clarification.
      if (section.title !== "Decision Log") findings.push(finding(`${type}.sections`, section.line, `The section ## ${section.title} is empty.`));
      continue;
    }
    if (section.title !== "Requirements" || body === "n/a") continue;
    for (const item of section.body) {
      if (blank(item) || item.fenced) continue;
      const wrong = linkTargets(item.value).filter((target) => !isLinkTo(target, { anchor: "optional-path" }));
      if (wrong.length) {
        findings.push(finding(`${type}.requirements`, item.line, `Every Markdown link in the Requirements section must target a relative <path>.md with an optional #<anchor>, or the section must be n/a; found ${wrong.map((target) => `"${target}"`).join(", ")}.`));
      }
    }
  }
  return { findings, unknowns };
}

// ---- Feature files ----

function inspectFeature(text) {
  const type = "feature";
  const findings = [], unknowns = [];
  const items = text.split(/\r?\n/).map((value, index) => ({ value, trimmed: value.trim(), line: index + 1 }));
  const first = items.find((item) => item.trimmed !== "" && !item.trimmed.startsWith("#"));
  if (!first || !/^Feature:\s*\S/.test(first.trimmed)) findings.push(finding(`${type}.header`, first?.line ?? null, "The first line that is neither blank nor a comment must be \"Feature: <capability>\"."));
  const rules = [];
  let rule = null, example = null, docString = null;
  const close = () => {
    if (!example) return;
    const order = example.steps;
    const given = order.indexOf("Given"), when = order.indexOf("When"), then = order.indexOf("Then");
    const sorted = order.every((step, index) => index === 0 || ["Given", "When", "Then"].indexOf(step) >= ["Given", "When", "Then"].indexOf(order[index - 1]));
    const whens = order.filter((step) => step === "When").length;
    if (given !== 0 || when === -1 || then === -1 || whens !== 1 || !sorted || example.dangling) {
      findings.push(finding(`${type}.steps`, example.line, `The example "${example.name}" must have at least one Given, exactly one When, and at least one Then, in that order.`));
    }
    example = null;
  };
  for (const item of items) {
    const value = item.trimmed;
    if (docString) { if (value.startsWith(docString)) docString = null; continue; }
    if (value.startsWith('"""') || value.startsWith("```")) { docString = value.slice(0, 3); continue; }
    if (value === "" || value.startsWith("|") || value.startsWith("@")) continue;
    if (value.startsWith("#")) {
      if (rule && !rule.examples && /^#\s*Requirement:/.test(value)) {
        if (/^#\s*Requirement:\s*\[[^\]]+\]\(([^)\s]+)\)\s*$/.test(value) && isLinkTo(/\(([^)\s]+)\)/.exec(value)[1], { anchor: "required-path" })) rule.requirement = true;
        else findings.push(finding(`${type}.requirement`, item.line, "A requirement comment must be \"# Requirement: [<title>](<path>.md#<anchor>)\"."));
      } else if (rule && !rule.examples && /^#\s*ADR:/.test(value) && !(/^#\s*ADR:\s*\[[^\]]+\]\(([^)\s]+)\)\s*$/.test(value) && isLinkTo(/\(([^)\s]+)\)/.exec(value)[1], { anchor: "none" }))) {
        findings.push(finding(`${type}.requirement`, item.line, "An ADR comment must be \"# ADR: [<title>](<path>.md)\"."));
      }
      continue;
    }
    const keyword = /^(Feature|Rule|Background|Example|Scenario|Scenario Outline|Scenario Template|Examples|Scenarios):\s*(.*)$/.exec(value);
    if (keyword) {
      close();
      const [, word, name] = keyword;
      if (word === "Rule") rules.push(rule = { name, line: item.line, requirement: false, examples: 0 });
      else if (["Example", "Scenario", "Scenario Outline", "Scenario Template"].includes(word)) {
        if (!rule) findings.push(finding(`${type}.rules`, item.line, `The example "${name}" must sit under a Rule.`));
        else rule.examples += 1;
        example = { name, line: item.line, steps: [], dangling: false };
      }
      continue;
    }
    const step = /^(Given|When|Then|And|But|\*)\s+(.*)$/.exec(value);
    if (step && example) {
      const word = step[1];
      if (["And", "But", "*"].includes(word)) {
        if (!example.steps.length) example.dangling = true;
      } else example.steps.push(word);
      if (step[2].trim() === UNKNOWN) unknowns.push({ line: item.line, field: word });
    }
  }
  close();
  if (!rules.length) findings.push(finding(`${type}.rules`, null, "The feature must have at least one Rule."));
  for (const entry of rules) {
    if (!entry.requirement) findings.push(finding(`${type}.requirement`, entry.line, `The rule "${entry.name}" must have at least one "# Requirement: [<title>](<path>.md#<anchor>)" comment before its first example.`));
    if (!entry.examples) findings.push(finding(`${type}.examples`, entry.line, `The rule "${entry.name}" must have at least one example.`));
  }
  return { findings, unknowns };
}

// ---- Glossary ----

const LEANING = /^(It|This|That|These|They|See)\b/;

// A Source value's sources: each { kind: "requirement" | "adr" | "migration", target, id }, or null when the value is not a source list.
export function glossarySources(value, { proposal = false } = {}) {
  const sources = [];
  let rest = value.trim();
  while (rest) {
    const link = /^\[[^\]]*\]\(([^)\s]+)\)/.exec(rest);
    const migration = /^migration(?:\s+(migration-[0-9a-f]+))?(?![\w-])/.exec(rest);
    if (link) {
      const target = link[1];
      if (isLinkTo(target, { anchor: "required-path" }) && /#\d+$/.test(target)) sources.push({ kind: "requirement", target });
      else if (isLinkTo(target, { anchor: "none" }) && !target.startsWith("#")) sources.push({ kind: "adr", target });
      else return null;
      rest = rest.slice(link[0].length);
    } else if (migration && (migration[1] || proposal)) {
      sources.push({ kind: "migration", target: migration[0], id: migration[1] ?? null });
      rest = rest.slice(migration[0].length);
    } else return null;
    rest = rest.trimStart();
    if (!rest) break;
    if (!rest.startsWith(",")) return null;
    rest = rest.slice(1).trimStart();
    if (!rest) return null;
  }
  return sources.length ? sources : null;
}

const sourceLabel = (source) => source.target;

function inspectGlossary(text, context = {}) {
  const type = "glossary";
  const findings = [], unknowns = [];
  const items = linesOf(text);
  title(type, items, findings, "name");
  const firstTerm = items.findIndex((item, index) => index > 0 && !item.fenced && (/^<a id=/.test(item.value) || /^## /.test(item.value)));
  const purposeItems = items.slice(1, firstTerm === -1 ? items.length : firstTerm);
  const purpose = paragraphs(purposeItems);
  if (purpose.length !== 1) findings.push(finding(`${type}.purpose`, purpose[1]?.[0].line ?? 2, "One paragraph must follow the title before the first term."));
  else if (bodyText(purpose[0]) === UNKNOWN) unknowns.push({ line: purpose[0][0].line, field: "Purpose" });

  const { sections } = markdownSections(items);
  const terms = sections.map((section) => {
    const before = items[section.index - 1];
    const anchor = before && /^<a id="([^"]*)"><\/a>\s*$/.exec(before.value);
    return { section, id: anchor ? anchor[1] : null };
  });
  const ids = new Map();
  for (const { id } of terms) if (id !== null) ids.set(id, (ids.get(id) ?? 0) + 1);
  for (const { section, id } of terms) {
    if (id === null) findings.push(finding(`${type}.identity`, section.line, `The term "${section.title}" must directly follow <a id="<id>"></a>.`));
    else if (!TERM_ID.test(id)) findings.push(finding(`${type}.identity`, section.line, `The term id "${id}" must be lowercase letters and digits joined by single hyphens.`));
    else if (ids.get(id) > 1) findings.push(finding(`${type}.identity`, section.line, `The term id "${id}" repeats.`));
  }
  for (const item of items) {
    if (item.fenced || !/^<a id=/.test(item.value)) continue;
    const next = items[item.line];
    if (!/^<a id="[^"]*"><\/a>\s*$/.test(item.value) || !next || !/^## /.test(next.value)) findings.push(finding(`${type}.identity`, item.line, "Each anchor must be <a id=\"<id>\"></a> directly before its term's heading."));
  }

  for (const { section, id } of terms) inspectTerm(section, id, ids, findings, unknowns, context);
  return { findings, unknowns };
}

function inspectTerm(section, id, ids, findings, unknowns, context) {
  const type = "glossary";
  const body = section.body.filter((item) => !/^<a id=/.test(item.value) || item.fenced);
  const groups = paragraphs(body);
  const isField = (item) => /^(Source|Aliases|Not to be confused with):/.test(item.value);
  const definition = groups[0];
  if (!definition || isField(definition[0])) {
    findings.push(finding(`${type}.definition`, section.line, `The term "${section.title}" must start with a definition paragraph.`));
  } else {
    const joined = definition.map((item) => item.value.trim()).join(" ");
    if (joined === UNKNOWN) unknowns.push({ line: definition[0].line, field: "Definition" });
    else {
      const sentence = joined.split(/(?<=[.!?])\s+/)[0];
      if (!sentence.endsWith(".") || LEANING.test(sentence)) findings.push(finding(`${type}.definition`, definition[0].line, `The first sentence of "${section.title}" must end with a period and stand on its own, starting with none of It, This, That, These, They, or See.`));
    }
  }
  const lines = body.filter((item) => !blank(item));
  const sourceIndex = lines.findIndex((item) => /^Source:/.test(item.value));
  if (sourceIndex === -1) {
    findings.push(finding(`${type}.fields`, section.line, `The term "${section.title}" has no Source: line.`));
    return;
  }
  const fields = lines.slice(sourceIndex);
  let stage = 0;
  for (const [position, item] of fields.entries()) {
    if (position === 0) continue;
    if (/^Aliases:\s*\S/.test(item.value) && stage < 1) { stage = 1; continue; }
    const distinction = /^Not to be confused with:\s*\[[^\]]+\]\(#([^)\s]+)\):\s*\S/.exec(item.value);
    if (distinction) {
      stage = 2;
      if (distinction[1] === id || !ids.has(distinction[1])) findings.push(finding(`${type}.fields`, item.line, `The distinction of "${section.title}" must link another term of the glossary, not #${distinction[1]}.`));
      continue;
    }
    findings.push(finding(`${type}.fields`, item.line, `After the definition of "${section.title}" come one Source: line, an optional Aliases: line, and optional Not to be confused with: lines, and nothing else; found "${item.value.trim()}".`));
  }
  const sourceLine = fields[0];
  const value = /^Source:\s*(.*?)\s*$/.exec(sourceLine.value)[1];
  if (value === UNKNOWN) { unknowns.push({ line: sourceLine.line, field: "Source" }); return; }
  const sources = glossarySources(value, { proposal: context.proposal === true });
  if (!sources) {
    findings.push(finding(`${type}.source`, sourceLine.line, `The Source of "${section.title}" must be comma-separated Markdown links to a requirement section <path>.md#<n> or an ADR file, or migration <id>; found "${value}".`));
    return;
  }
  if (typeof context.resolveSource !== "function") return;
  const resolved = sources.map((source) => ({ source, ...context.resolveSource(source) }));
  const undecided = resolved.filter((entry) => !entry.decided);
  if (undecided.length) {
    findings.push(finding(`${type}.source-decided`, sourceLine.line, `The term "${section.title}" cites sources that are not decided: ${undecided.map((entry) => `${sourceLabel(entry.source)} (${entry.reason})`).join(", ")}.`));
    return;
  }
  if (!resolved.some((entry) => entry.inForce)) {
    findings.push(finding(`${type}.source-withdrawn`, sourceLine.line, `Every source of the term "${section.title}" is withdrawn or superseded: ${resolved.map((entry) => `${sourceLabel(entry.source)} (${entry.reason})`).join(", ")}.`));
  }
}

// ---- The formats ----

function format(type, version, reference, rules, defaults, inspect) {
  const run = (input, context) => {
    const decoded = decode(type, input);
    if (decoded.failure) return { findings: [decoded.failure], unknowns: [] };
    return inspect(decoded.text, context);
  };
  return Object.freeze({ type, version, reference, rules: Object.freeze(rules), defaults: Object.freeze(defaults), inspect: run, check: (input) => run(input, {}).findings });
}

/** Prism's own formats, in the order every result lists them, each the newest version of its type. */
export const ARTIFACT_FORMATS = Object.freeze([
  format("requirements", 1, "skills/write-requirements/references/requirement-format.md",
    ["requirements.text", "requirements.title", "requirements.header", "requirements.status", "requirements.dates", "requirements.sections", "requirements.numbering", "requirements.fields", "requirements.pattern", "requirements.disposition", "requirements.links"],
    { Status: "Draft", Approved: "n/a", "Design questions": "n/a", Disposition: "Active", Related: "n/a" }, inspectRequirements),
  format("adr", 1, "skills/write-adr/references/adr-format.md",
    ["adr.text", "adr.title", "adr.header", "adr.status", "adr.dates", "adr.sections", "adr.requirements"],
    { Status: "Proposed", Requirements: "n/a", "Decision Log": "n/a" }, inspectAdr),
  format("glossary", 1, "skills/workflow/references/glossary-format.md",
    ["glossary.text", "glossary.title", "glossary.purpose", "glossary.identity", "glossary.definition", "glossary.fields", "glossary.source", "glossary.source-decided", "glossary.source-withdrawn"],
    { Title: "Glossary" }, inspectGlossary),
  format("feature", 1, "skills/write-feature/references/feature-format.md",
    ["feature.text", "feature.header", "feature.rules", "feature.requirement", "feature.examples", "feature.steps"],
    {}, inspectFeature)
]);

export const ARTIFACT_TYPES = Object.freeze(ARTIFACT_FORMATS.map((entry) => entry.type));

/** The formats of one type, oldest first, from the given list. */
const formatsOf = (type, formats) => formats.filter((entry) => entry.type === type).sort((a, b) => a.version - b.version);

/**
 * Checks an artifact against the newest format of its type and, when it breaks that one, finds the newest earlier version it conforms to.
 * Returns { conforms, findings, unknowns, earlierFormat, version }.
 */
export function inspectArtifact(type, input, { formats = ARTIFACT_FORMATS, context } = {}) {
  const versions = formatsOf(type, formats);
  if (!versions.length) throw new Error(`No format of the type ${type}.`);
  const current = versions.at(-1);
  const run = (entry) => typeof entry.inspect === "function" ? entry.inspect(input, context ?? {}) : { findings: entry.check(input), unknowns: [] };
  const { findings, unknowns } = run(current);
  if (!findings.length) return { conforms: true, findings: [], unknowns, earlierFormat: null, version: current.version };
  const earlier = versions.slice(0, -1).reverse().find((entry) => run(entry).findings.length === 0);
  return { conforms: false, findings, unknowns, earlierFormat: earlier ? { version: earlier.version } : null, version: current.version };
}

/** Checks an artifact's text against its format: { conforms, findings, earlierFormat }. */
export function checkArtifactText(type, text, { formats = ARTIFACT_FORMATS } = {}) {
  const { conforms, findings, earlierFormat } = inspectArtifact(type, text, { formats });
  return { conforms, findings, earlierFormat };
}
