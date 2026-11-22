// Generated from src/server/workflow/skill-files.mts by scripts/native-build/compile.mjs.
import { readdirSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pluginPath } from "../plugin-root.mjs";
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const GET_SKILL_TOOL = Object.freeze({
  name: "get_skill",
  description: "Read a Prism skill file for an agent that has Prism's tools but not its skills installed. name is a Prism skill name, with or without the prism: prefix, and path is a file relative to that skill's folder, SKILL.md by default, such as a reference that the skill links. Answers { name, path, text }. An unknown skill is refused with the list of skill names, and a path that is absolute, holds .., or names no file of the skill's folder is refused.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      path: { type: "string", minLength: 1, maxLength: 500 }
    }
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});
class SkillFileError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = "SkillFileError";
    this.code = code;
    this.data = { code, ...data };
  }
}
const skillsFolder = () => pluginPath("skills");
function skillNames() {
  try {
    return readdirSync(skillsFolder(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && SKILL_NAME.test(entry.name)).map((entry) => entry.name).filter((name) => {
      try {
        return readdirSync(path.join(skillsFolder(), name)).includes("SKILL.md");
      } catch {
        return false;
      }
    }).sort();
  } catch {
    return [];
  }
}
async function getSkill({ name, path: file = "SKILL.md" }) {
  const names = skillNames();
  const bare = typeof name === "string" ? name.replace(/^prism:/, "") : "";
  if (!names.includes(bare)) throw new SkillFileError("unknown_skill", `Prism has no skill ${String(name)}; its skills are ${names.join(", ")}.`, { skills: names });
  if (typeof file !== "string" || !file || path.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new SkillFileError("invalid_path", "path must be a file relative to the skill's folder, without .. parts.");
  }
  const folder = await realpath(path.join(skillsFolder(), bare));
  const missing = () => new SkillFileError("unknown_file", `The skill ${bare} has no file ${file}.`);
  let target;
  try {
    target = await realpath(path.join(folder, file));
  } catch {
    throw missing();
  }
  if (!target.startsWith(`${folder}${path.sep}`)) throw missing();
  const stats = await stat(target);
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw missing();
  return { name: bare, path: path.relative(folder, target).split(path.sep).join("/"), text: await readFile(target, "utf8") };
}
export {
  GET_SKILL_TOOL,
  SkillFileError,
  getSkill,
  skillNames
};
