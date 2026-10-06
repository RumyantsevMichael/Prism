import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const WORKFLOW_CONFIG_RELATIVE_PATH = path.join(".prism", "workflow.md");
const WORKFLOW_CONFIG_MAX_BYTES = 256 * 1024;
const REPOSITORY_INTELLIGENCE_HEADING = "Repository intelligence";

export class RepositoryIntelligenceConfigError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RepositoryIntelligenceConfigError";
    this.code = "invalid-config";
  }
}

function isWithinDirectory(directoryPath, filePath) {
  const relativePath = path.relative(directoryPath, filePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function invalidConfig(message, cause) {
  return new RepositoryIntelligenceConfigError(message, { cause });
}

function parseCodeNibCommand(markdown) {
  let inSection = false;
  let sectionCount = 0;
  let fence = null;
  const commandValues = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const closingFence = line.trim().match(/^(`{3,}|~{3,})\s*$/);
      if (closingFence && closingFence[1][0] === fence.character && closingFence[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const openingFence = line.match(/^\s*(`{3,}|~{3,})/);
    if (openingFence) {
      fence = { character: openingFence[1][0], length: openingFence[1].length };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (heading[1].length <= 2) {
        inSection = heading[1].length === 2 && heading[2].trim() === REPOSITORY_INTELLIGENCE_HEADING;
        if (inSection) sectionCount += 1;
      }
      continue;
    }

    if (!inSection) continue;
    const commandField = line.match(/^-\s+CodeNib command:\s*(.*?)\s*$/);
    if (commandField) commandValues.push(commandField[1]);
  }

  if (sectionCount > 1) {
    throw invalidConfig("The Prism workflow config has more than one Repository intelligence section.");
  }
  if (commandValues.length > 1) {
    throw invalidConfig("The Prism workflow config has more than one CodeNib command setting.");
  }
  if (sectionCount === 0 || commandValues.length === 0) return null;

  let command = commandValues[0];
  if (command.startsWith("`") && command.endsWith("`") && command.length >= 2) {
    command = command.slice(1, -1);
  } else if (command.includes("`")) {
    throw invalidConfig("The CodeNib command setting has invalid Markdown quoting.");
  }

  if (command === "n/a") return null;
  if (!command || !path.isAbsolute(command) || command.includes("\0")) {
    throw invalidConfig("The CodeNib command setting must be an absolute executable path or n/a.");
  }
  return command;
}

export async function readCodeNibCommand(projectRoot) {
  const canonicalRoot = await realpath(projectRoot);
  const workflowConfigPath = path.join(canonicalRoot, WORKFLOW_CONFIG_RELATIVE_PATH);
  let canonicalConfigPath;
  try {
    canonicalConfigPath = await realpath(workflowConfigPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw invalidConfig("The Prism workflow config could not be resolved.", error);
  }

  if (!isWithinDirectory(canonicalRoot, canonicalConfigPath)) {
    throw invalidConfig("The Prism workflow config resolves outside the requested project root.");
  }

  let details;
  try {
    details = await stat(canonicalConfigPath);
  } catch (error) {
    throw invalidConfig("The Prism workflow config could not be read.", error);
  }
  if (!details.isFile() || details.size > WORKFLOW_CONFIG_MAX_BYTES) {
    throw invalidConfig("The Prism workflow config is not a supported regular file.");
  }

  let markdown;
  try {
    markdown = await readFile(canonicalConfigPath, "utf8");
  } catch (error) {
    throw invalidConfig("The Prism workflow config could not be read.", error);
  }
  return parseCodeNibCommand(markdown);
}
