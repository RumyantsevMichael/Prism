// prism-lib-table: a library table in light DOM, one bordered list of records: a head row of column names, rows of cells, and group heads with a count
// and where the group comes from, and details a row unfolds under itself, written with the kit's .prism-lib-* classes; the page sets the columns with --prism-lib-columns.
import { Base } from "./base.js";

export class PrismLibTable extends Base {
  static tag = "prism-lib-table";
  static catalog = {
    purpose: "A library table: one bordered list of records with a head row, rows whose cells line up in the columns the page sets in --prism-lib-columns, and group heads with a count and, when the group comes from somewhere, its source; in a phone-width window, or when the table itself is narrower than 600px, a record keeps its title on its own line and the rest on the line below.",
    options: [
      { name: ".prism-lib-row", values: ["children"], default: "", description: "A row of cells; with is-head it names the columns in small capitals and is hidden from assistive technology with aria-hidden." },
      { name: ".prism-lib-title", values: ["children"], default: "", description: "A record's title cell: a .prism-lib-kind glyph, a link that wraps when it is long, and optionally a prism-badge after it that keeps its width beside the title's first line." },
      { name: ".prism-lib-title-text", values: ["children"], default: "", description: "Inside a title cell, the link with a .prism-lib-cell is-detail line under it, such as the record's path." },
      { name: ".prism-lib-cell", values: ["children"], default: "", description: "A quiet cell in the table's smaller muted text; is-detail makes it smaller still." },
      { name: ".prism-lib-group", values: ["children"], default: "", description: "A group head: a .prism-lib-group-name heading with its count and, when the group has one, a .prism-lib-group-source at its end." },
      { name: ".prism-lib-nothing", values: ["children"], default: "", description: "The line of a group without records." },
      { name: ".prism-lib-details", values: ["children"], default: "", description: "A region the last child of a row holds, which the page unfolds under the row's cells across every column, such as a launched session's terminal command; hidden folds it." },
      { name: "--prism-lib-columns", values: ["grid columns"], default: "minmax(0, 1fr)", description: "The columns every row shares, set by the page." }
    ],
    states: ["default", "grouped", "with-detail", "empty-group", "no-source", "with-details"],
    keyboard: ["The table is not a control; Tab reaches the links in its rows."]
  };
}
