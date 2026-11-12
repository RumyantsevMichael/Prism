// Revision mismatches name the likely cause, so an agent can retry with the right value instead of working around the tool.
export function revisionMismatch(label, expected, current) {
  if (expected === "null") {
    return `The expectedRevision argument is the string "null". Pass JSON null${current === null ? ` to create the ${label}` : `, or the current revision ${current} to change the existing ${label}`}.`;
  }
  if (expected === null && current !== null) {
    return `The ${label} already exists, so expectedRevision cannot be null. Read it and pass its current revision ${current}.`;
  }
  if (expected !== null && current === null) {
    return `The ${label} does not exist yet. Pass expectedRevision null to create it.`;
  }
  return `The ${label} changed since it was read. Read it again and retry with its current revision ${current}.`;
}
