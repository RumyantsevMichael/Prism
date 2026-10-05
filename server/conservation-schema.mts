export const textField = { type: "string", minLength: 1, maxLength: 8192 };
export const hashField = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
export const arraySchema = (items: unknown, maxItems = 100) => ({ type: "array", items, maxItems });
export const selectorSchema = { oneOf: [textField,
  objectSchema({ type: { enum: ["symbol", "heading", "text", "json-pointer", "yaml-key"] }, value: textField }),
  objectSchema({ type: { const: "span" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 }, sourceHash: hashField })
] };
export const referenceSchema = objectSchema({ path: textField, selector: selectorSchema }, ["path"]);
export const justificationSchema = objectSchema({ dimensions: arraySchema(textField), conceptIds: arraySchema(textField), requirements: arraySchema(referenceSchema), reason: textField });
export const deltaMetadata = {
  baselineId: hashField,
  requirements: arraySchema(referenceSchema),
  growthJustifications: arraySchema(justificationSchema),
  growthThresholds: arraySchema(objectSchema({ dimension: textField, maximumIncrease: { type: "integer", minimum: 0 } })),
  expectedGrowth: arraySchema(objectSchema({ dimension: textField, increase: { oneOf: [{ type: "number" }, { type: "null" }] }, reason: textField }))
};
