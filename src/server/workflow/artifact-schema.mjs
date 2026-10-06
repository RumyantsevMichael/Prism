const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code, message, details) => Object.assign(new Error(message), { code, ...details });
export function checkSchema(schema, value, field, errors) {
  const fail = (message) => errors.push(`${field}: ${message}`);
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => { const problems = []; checkSchema(branch, value, field, problems); return problems; });
    if (!branches.some((problems) => problems.length === 0)) {
      // Select the operation branch to keep diagnostics specific to its fields.
      const branch = schema.oneOf.findIndex((item) => item.properties?.op?.const === value?.op);
      if (branch >= 0) errors.push(...branches[branch]);
      else fail("must match one supported input form");
    }
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail(`must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(", ")}`);
  if (schema.type === "object") {
    if (!isObject(value)) return fail("must be an object");
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`contains an unknown property: ${key}`);
      else checkSchema(schema.properties[key], value[key], `${field}.${key}`, errors);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${field}.${key}: is required`);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) fail("must contain at least one field");
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return fail("must be an array");
    if (schema.minItems && value.length < schema.minItems) fail(`must contain at least ${schema.minItems} item`);
    if (schema.maxItems && value.length > schema.maxItems) return fail(`must contain at most ${schema.maxItems} items`);
    value.forEach((item, index) => checkSchema(schema.items, item, `${field}[${index}]`, errors));
  } else if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength && !value.trim())) return fail("must be a non-empty string");
    if (schema.maxLength && value.length > schema.maxLength) fail("exceeds the field length limit");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail("must be a SHA-256 revision");
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < schema.minimum || (schema.maximum && value > schema.maximum)) fail("must be an integer within the supported limits");
  } else if (schema.type === "boolean" && typeof value !== "boolean") fail("must be a boolean");
  else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) fail("must be a finite number");
  else if (schema.type === "null" && value !== null) fail("must be null");
}

export function assertInput(schema, input) {
  const errors = [];
  checkSchema(schema, input, "arguments", errors);
  if (errors.length) throw failure("validation_failed", "The concept delta arguments are invalid.", { errors });
}
