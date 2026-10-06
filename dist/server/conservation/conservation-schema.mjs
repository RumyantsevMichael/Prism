// Generated from src/server/conservation/conservation-schema.mts by scripts/native-build/compile.mjs.
const textField = { type: "string", minLength: 1, maxLength: 8192 };
const hashField = { type: "string", pattern: "^[a-f0-9]{64}$" };
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const arraySchema = (items, maxItems = 100) => ({ type: "array", items, maxItems });
const selectorSchema = { oneOf: [
  textField,
  objectSchema({ type: { enum: ["symbol", "heading", "text", "json-pointer", "yaml-key"] }, value: textField }),
  objectSchema({ type: { const: "span" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 }, sourceHash: hashField })
] };
const referenceSchema = objectSchema({ path: textField, selector: selectorSchema }, ["path"]);
const justificationSchema = objectSchema({ dimensions: arraySchema(textField), conceptIds: arraySchema(textField), requirements: arraySchema(referenceSchema), reason: textField });
const deltaMetadata = {
  baselineId: hashField,
  requirements: arraySchema(referenceSchema),
  growthJustifications: arraySchema(justificationSchema),
  growthThresholds: arraySchema(objectSchema({ dimension: textField, maximumIncrease: { type: "integer", minimum: 0 } })),
  expectedGrowth: arraySchema(objectSchema({ dimension: textField, increase: { oneOf: [{ type: "number" }, { type: "null" }] }, reason: textField }))
};
export {
  arraySchema,
  deltaMetadata,
  hashField,
  justificationSchema,
  objectSchema,
  referenceSchema,
  selectorSchema,
  textField
};
