import path from "node:path";
import { readArtifactText } from "./record-store.mjs";

// A design view explains contract clauses to the person at the design gate, and its slice.md declares it in a Views section by kind, question, and the clauses it explains.
export const VIEW_KINDS = Object.freeze(["sequence", "activity", "state", "component", "data-model", "deployment", "wireframe", "code", "api"]);

// The drawn kinds that each declared kind accepts.
const ACCEPTS = Object.freeze({
  sequence: ["sequence"],
  activity: ["activity"],
  state: ["state"],
  component: ["component", "deployment"],
  deployment: ["deployment"],
  code: ["component", "deployment", "class"],
  "data-model": ["class"],
  wireframe: ["wireframe"],
  api: ["api"]
});

/** A level-two section of a Markdown design, without its heading, or null when the design has none. */
export function section(source, title) {
  const match = new RegExp(`^## ${title}[ \\t]*$`, "m").exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + match[0].length);
  const next = /^#{1,2} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Top-level list items of a section; an indented or wrapped line belongs to the item above it. */
export function listItems(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) result.push(item[1].trim());
    else if (line.trim() && result.length && /^\s/.test(line)) result[result.length - 1] += ` ${line.trim()}`;
  }
  return result;
}

/** The numbered clauses of a design's Contract section. */
export function contractClauses(source) {
  const text = section(source, "Contract");
  return text === null ? [] : listItems(text);
}

const VIEW_LINE = /^`([^`]+)`\s+([A-Za-z][\w-]*)(?:\s*\(([^)]*)\))?\s*:\s*(.*)$/;

/**
 * The views that a folder's slice.md declares: `` `<file>` <kind> (§<n>[, §<n>…]): <question> ``, one top-level item of its Views section each.
 * Each view's path is the file in the folder, or for an api view a project-relative path with a `/`; problems name every declaration that breaks the form.
 * Returns { views: [{ path, file, kind, clauses, question }], problems: string[] }.
 */
export function readViews(source, folder, { plans = null } = {}) {
  const text = section(source ?? "", "Views");
  const views = [], problems = [];
  if (text === null) return { views, problems };
  for (const line of listItems(text)) {
    const parsed = VIEW_LINE.exec(line);
    if (!parsed) {
      problems.push(`${folder}/slice.md has the Views line ${JSON.stringify(line)}, which is not of the form \`<file>\` <kind> (§<n>, …): <question?>.`);
      continue;
    }
    const [, raw, kind, cited, question] = parsed;
    const file = raw.trim();
    const outside = file.includes("/");
    const viewPath = outside ? file : `${folder}/${file}`;
    const own = [];
    if (!VIEW_KINDS.includes(kind)) own.push(`${viewPath} declares the kind ${kind}, which is none of ${VIEW_KINDS.join(", ")}.`);
    if (!question.trim() || !question.trim().endsWith("?")) own.push(`${viewPath} states no question: its Views line ends with the question it answers for the person at the design gate, ending in "?".`);
    const clauses = [...new Set([...(cited ?? "").matchAll(/§\s*(\d+)/g)].map((match) => Number(match[1])))];
    if (!clauses.length) own.push(`${viewPath} cites no clause: its Views line names the contract clauses it explains, such as (§1, §3).`);
    if (outside) {
      const normalized = path.posix.normalize(file);
      if (kind !== "api") own.push(`${viewPath} names a file outside its folder, which only an api view may do.`);
      else if (normalized !== file || path.posix.isAbsolute(file) || normalized.startsWith("../")) own.push(`${viewPath} is not a normalized project-relative path.`);
      else if (plans && (normalized === plans || normalized.startsWith(`${plans}/`))) own.push(`${viewPath} is inside the Plans folder, so it is declared by its name in its own folder.`);
    }
    problems.push(...own);
    views.push({ path: viewPath, file, kind, clauses, question: question.trim(), valid: own.length === 0 });
  }
  return { views, problems };
}

const C4_ELEMENT = /^\s*(?:Person|System|SystemDb|SystemQueue|Container|ContainerDb|ContainerQueue|Component|ComponentDb|ComponentQueue|Boundary|Enterprise_Boundary|System_Boundary|Container_Boundary)(?:_Ext)?\s*\(/m;

/** The kind a view draws, read from its source by the first drawn-kind rule that matches. */
export function drawnKind(file, source) {
  if (!file.endsWith(".puml")) return "api";
  const text = source ?? "";
  const start = /^\s*@start([a-z]+)/im.exec(text)?.[1]?.toLowerCase();
  if (start === "salt") return "wireframe";
  if (start && start !== "uml") return start;
  if (/\[\*\]/.test(text) || /^\s*state\s+\S/m.test(text)) return "state";
  if (/^\s*(?:start|stop)\s*$/m.test(text) || /^\s*:[^;]*;/m.test(text) || /^\s*(?:if|while)\s*\(/m.test(text) || /^\s*(?:repeat|fork|partition)\b/m.test(text) || /\(\*\)/.test(text)) return "activity";
  if (/^\s*(?:node|cloud)\b/m.test(text) || /^\s*Deployment_Node(?:_[LR])?\s*\(/m.test(text) || /^\s*!include\s+<C4\/C4_Deployment>/m.test(text)) return "deployment";
  if (/^\s*(?:component|artifact)\b/m.test(text) || /^\s*\[(?![ox]?[-.=<])[^\]\n]+\]/m.test(text) || /^\s*!include\s+<C4\//m.test(text) || C4_ELEMENT.test(text)) return "component";
  if (/^\s*(?:class|abstract|enum|annotation|interface)\b/m.test(text) || /^\s*entity\b[^\n]*\{/m.test(text) || /[|}][|o](?:-+|\.+)[|o][|{]/.test(text)) return "class";
  if (/^\s*(?:package|folder|frame|rectangle)\b/m.test(text)) return "component";
  return "sequence";
}

/** Whether a view of the declared kind may draw the drawn kind. */
export const acceptsDrawn = (declared, drawn) => (ACCEPTS[declared] ?? []).includes(drawn);

const clauseList = (clauses) => {
  const named = clauses.map((number) => `§${number}`);
  if (named.length < 3) return named.join(" and ");
  return `${named.slice(0, -1).join(", ")}, and ${named.at(-1)}`;
};

/** The sentence that tells a reader of a view that the contract decides. */
export function viewNote(clauses, contract) {
  return `This view explains ${clauseList(clauses)} of the contract in ${contract}; where the view and the contract differ, the contract decides.`;
}

/**
 * The governing contract of a folder: the nearest slice.md with a Contract in the folder or a folder above it, up to and including top.
 * Returns { path, clauses } or null.
 */
export async function governingContract(root, folder, top) {
  for (let current = folder; ; current = path.posix.dirname(current)) {
    const file = `${current}/slice.md`;
    const text = await readArtifactText(root, file).catch(() => null);
    const clauses = text === null ? [] : contractClauses(text);
    if (clauses.length) return { path: file, clauses: clauses.length };
    if (current === top || !current.includes("/") || !top || !current.startsWith(`${top}/`)) return null;
  }
}

/** The view that a file's folder declares for it, with the governing contract and the note, or null when the folder declares none. */
export async function declaredView(root, file, { plans }) {
  if (!plans || !file.startsWith(`${plans}/`) || path.posix.basename(file) === "slice.md") return null;
  const folder = path.posix.dirname(file);
  const design = await readArtifactText(root, `${folder}/slice.md`).catch(() => null);
  if (design === null) return null;
  const view = readViews(design, folder, { plans }).views.find((item) => item.path === file);
  if (!view || !VIEW_KINDS.includes(view.kind)) return null;
  const contract = await governingContract(root, folder, plans);
  const contractPath = contract?.path ?? `${folder}/slice.md`;
  return { kind: view.kind, question: view.question, clauses: view.clauses, contract: contractPath, note: viewNote(view.clauses, contractPath) };
}
