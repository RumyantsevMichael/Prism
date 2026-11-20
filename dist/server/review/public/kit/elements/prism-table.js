// Generated from src/server/review/public/kit/elements/prism-table.ts by scripts/native-build/compile.mjs.
import { Base } from "./base.js";
class PrismTable extends Base {
  static tag = "prism-table";
  static catalog = {
    purpose: "A compact table of figures around a native table: row headers at the start, values at the end in tabular numbers, and a header that may group columns. In a narrow column each body row becomes a block of named values, so nothing scrolls sideways.",
    options: [
      { name: "<table>", values: ["child"], default: "", description: 'The native table, with a thead, row headers in th scope="row", and a data-label on each value cell that names it in the narrow layout.' },
      { name: "prism-table-mark", values: ["class"], default: "", description: "A span before a cell's value, such as \u2248 for an approximate figure, drawn in the warning color." },
      { name: "prism-table-note", values: ["class"], default: "", description: "A cell that spans a row with a sentence instead of figures, such as No run recorded yet." }
    ],
    states: ["default", "grouped", "narrow", "marked"],
    keyboard: []
  };
}
export {
  PrismTable
};
