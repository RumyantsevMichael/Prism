// The kit's catalog: the design values first, then one entry per element of KIT_ELEMENTS with its purpose, options, states, keys, and live specimens.
// The toolbar and the query `?theme=light|dark&density=compact|comfortable&width=narrow|wide` set the catalog's theme, density, and width without storing them;
// without them the catalog follows the stored preferences.
import { KIT_ELEMENTS } from "./kit.js";
import { applyPreferences, currentPreferences, loadPreferences } from "./preferences.js";
import { escapeHtml } from "./elements/base.js";
import { ICON_NAMES } from "./elements/prism-icon.js";

const LONG = "A caption that is far longer than the room the control gives it, so it ends early with an ellipsis";
const UNBROKEN = "a-record-name-with-no-spaces-anywhere-that-cannot-wrap-and-keeps-going-on";
const TONES = ["neutral", "accent", "danger", "warning", "success", "info"];
const html = escapeHtml;

let ids = 0;
const id = (prefix) => `${prefix}-${(ids += 1)}`;
const repeat = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("");

// A kit button and the menu it opens.
function menuFor(items, { caption = "Open the menu" } = {}) {
  const trigger = id("catalog-menu-button");
  return `<prism-button id="${trigger}">${caption}<prism-icon name="chevron-down" size="sm"></prism-icon></prism-button><prism-menu for="${trigger}">${items}</prism-menu>`;
}

const themeItems = `<prism-menu-group label="Theme"><prism-menu-item type="radio" value="system" checked>System</prism-menu-item><prism-menu-item type="radio" value="light">Light</prism-menu-item><prism-menu-item type="radio" value="dark">Dark</prism-menu-item></prism-menu-group>`;
const densityItems = `<prism-menu-group label="Density"><prism-menu-item type="radio" value="compact" checked>Compact</prism-menu-item><prism-menu-item type="radio" value="comfortable">Comfortable</prism-menu-item></prism-menu-group>`;
const tabsOf = (labels, selected = 0, extra = "") => `<prism-tabs label="Specimen tabs">${labels.map((label, index) => `<prism-tab value="t${index}"${index === selected ? " selected" : ""}${extra && index === labels.length - 1 ? ` ${extra}` : ""}>${html(label)}</prism-tab>`).join("")}</prism-tabs>`;
const choiceOf = (options, { label = "Your answer", value = "" } = {}) => `<prism-choice label="${html(label)}" name="${id("catalog-choice")}"${value ? ` value="${value}"` : ""}>${options}</prism-choice>`;
const answers = `<prism-choice-option value="accept">Accept<span slot="detail">The slices start in order.</span></prism-choice-option><prism-choice-option value="changes" tone="danger">Request changes<span slot="detail">Design revises the contract.</span></prism-choice-option>`;

const PHASES = ["requirements", "design", "frozen", "build", "review", "shipped"];
const PHASE_NAMES = ["Requirements", "Design", "Frozen", "Build", "Review", "Shipped"];

// A kit button that opens the dialog after it, through the catalog's data-opens wiring.
function opener(caption, dialog) {
  const target = id("catalog-dialog");
  return `<prism-button data-opens="${target}">${caption}</prism-button>${dialog.replace("<prism-dialog ", `<prism-dialog id="${target}" `)}`;
}

// A kit button and the popover it opens.
function popoverFor(caption, body, { heading }) {
  const trigger = id("catalog-popover-button");
  return `<prism-button id="${trigger}">${caption}</prism-button><prism-popover for="${trigger}" heading="${heading}">${body}</prism-popover>`;
}

// A kit button that shows a message in the page's toast.
function toastButton(caption, message, tone) {
  return `<prism-button data-toast="${html(message)}" data-tone="${tone}">${html(caption)}</prism-button>`;
}

// A claim whose times are set from now: `left` minutes left, or lapsed that many minutes ago when negative, on a lease of 30 minutes.
function claimOf({ variant, label = "Claude on build-2", activity = "implementation", left = 41 }) {
  const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
  return `<prism-claim variant="${variant}" label="${html(label)}" activity="${activity}" claimed-at="${at(left - 90)}" renewed-at="${at(left - 30)}" expires-at="${at(left)}"></prism-claim>`;
}

// The six phases with the first `reached` done and the next one current.
function stepper(reached) {
  return `<prism-stepper label="Lifecycle">${PHASES.map((phase, index) => `<prism-step phase="${phase}" state="${index < reached ? "done" : index === reached ? "current" : "upcoming"}">${PHASE_NAMES[index]}</prism-step>`).join("")}</prism-stepper>`;
}

const crumbs = (labels) => `<prism-breadcrumbs>${labels.map((label, index) => `<a href="#entry-prism-breadcrumbs">${label}</a>`).join("")}</prism-breadcrumbs>`;

// Each element's specimens by state; every entry also shows long text and an unbroken name, and an element that holds items shows many.
const SPECIMENS = {
  "prism-button": {
    default: `<prism-button>Apply</prism-button>`,
    primary: `<prism-button variant="primary">Accept the design</prism-button>`,
    ghost: `<prism-button variant="ghost"><prism-icon name="copy" size="sm"></prism-icon>Copy link</prism-button>`,
    danger: `<prism-button variant="danger">Request changes</prism-button>`,
    small: `<prism-button size="sm">Small</prism-button><prism-button size="sm" variant="primary">Small primary</prism-button>`,
    disabled: `<prism-button disabled>Unavailable</prism-button><prism-button variant="primary" disabled>Unavailable</prism-button>`,
    pressed: `<prism-button variant="ghost" pressed>Side panel</prism-button><prism-button pressed="false">Wrap lines</prism-button>`,
    "icon-only": `<prism-button variant="ghost" label="Close"><prism-icon name="close"></prism-icon></prism-button><prism-button label="Search" tip="Search the workspace"><prism-icon name="search"></prism-icon></prism-button>`,
    "long-text": `<prism-button>${LONG}</prism-button>`,
    "unbroken-name": `<prism-button variant="primary">${UNBROKEN}</prism-button>`
  },
  "prism-icon": {
    decorative: ICON_NAMES.map((name) => `<prism-icon name="${name}"></prism-icon>`).join(""),
    labelled: `<prism-icon name="warning" label="Warning"></prism-icon><prism-icon name="info" label="Information"></prism-icon>`,
    sizes: `<prism-icon name="agent"></prism-icon><prism-icon name="agent" size="sm"></prism-icon><prism-icon name="agent" size="xs"></prism-icon>`,
    "long-text": `<prism-chip tone="info"><prism-icon name="info" size="xs"></prism-icon>${LONG}</prism-chip>`,
    "unbroken-name": `<prism-chip><prism-icon name="file" size="xs"></prism-icon>${UNBROKEN}</prism-chip>`
  },
  "prism-chip": {
    static: `<prism-chip>Implementation</prism-chip>`,
    tones: TONES.map((tone) => `<prism-chip tone="${tone}">${tone}</prism-chip>`).join(""),
    link: `<prism-chip href="#entry-prism-chip" tone="accent">Kit controls</prism-chip>`,
    interactive: `<prism-chip interactive>Filter by status</prism-chip>`,
    pressed: `<prism-chip interactive pressed="true">api<span slot="meta">3</span></prism-chip><prism-chip interactive pressed="false">web<span slot="meta">1</span></prism-chip>`,
    meta: `<prism-chip tone="danger">Open findings<span slot="meta">3</span></prism-chip><prism-chip>Change map<span slot="meta">12 planned</span></prism-chip>`,
    "long-text": `<prism-chip tone="warning">${LONG}</prism-chip>`,
    "unbroken-name": `<prism-chip>${UNBROKEN}</prism-chip>`
  },
  "prism-badge": {
    count: `<prism-badge>3</prism-badge><prism-badge>128</prism-badge>`,
    status: `<prism-badge variant="status" tone="success">Passing</prism-badge><prism-badge variant="status" tone="danger">Failing</prism-badge>`,
    tones: TONES.map((tone) => `<prism-badge tone="${tone}">${tone}</prism-badge>`).join(""),
    "long-text": `<prism-badge variant="status" tone="info">${LONG}</prism-badge>`,
    "unbroken-name": `<prism-badge tone="neutral">${UNBROKEN}</prism-badge>`
  },
  "prism-tab": {
    selected: tabsOf(["Design", "Diagram"], 0),
    unselected: tabsOf(["Design", "Diagram"], 1),
    disabled: tabsOf(["Design", "Files"], 0, "disabled"),
    "long-text": tabsOf([LONG, "Files"]),
    "unbroken-name": tabsOf([UNBROKEN, "Files"])
  },
  "prism-tabs": {
    default: tabsOf(["Design", "Diagram", "Verification", "Review ledger", "Change map", "Files"]),
    "second-selected": tabsOf(["Design", "Diagram", "Verification"], 1),
    "disabled-tab": tabsOf(["Design", "Diagram", "Files"], 0, "disabled"),
    "many-items": tabsOf(Array.from({ length: 24 }, (_, index) => (index % 4 ? `Tab ${index + 1}` : `${UNBROKEN} ${index + 1}`))),
    "long-text": tabsOf([LONG, "Diagram"]),
    "unbroken-name": tabsOf([UNBROKEN, "Diagram"])
  },
  "prism-menu": {
    closed: menuFor(`${themeItems}${densityItems}<prism-menu-item value="catalog">Component catalog</prism-menu-item>`, { caption: "Display" }),
    actions: menuFor(`<prism-menu-item value="copy">Copy link</prism-menu-item><prism-menu-item value="open">Open in a new tab</prism-menu-item><prism-menu-item value="unavailable" disabled>Unavailable</prism-menu-item>`, { caption: "Actions" }),
    groups: menuFor(`${themeItems}${densityItems}`, { caption: "Groups" }),
    "many-items": menuFor(repeat(40, (index) => `<prism-menu-item value="i${index}">Initiative number ${index + 1}</prism-menu-item>`), { caption: "Projects" }),
    "long-text": menuFor(`<prism-menu-item value="long">${LONG}</prism-menu-item><prism-menu-item value="short">Short</prism-menu-item>`, { caption: LONG }),
    "unbroken-name": menuFor(`<prism-menu-item value="unbroken">${UNBROKEN}</prism-menu-item>`, { caption: UNBROKEN })
  },
  "prism-menu-group": {
    default: menuFor(`${themeItems}`),
    "long-text": menuFor(`<prism-menu-group label="${LONG}"><prism-menu-item value="a">First</prism-menu-item></prism-menu-group>`),
    "unbroken-name": menuFor(`<prism-menu-group label="${UNBROKEN}"><prism-menu-item value="a">First</prism-menu-item></prism-menu-group>`)
  },
  "prism-menu-item": {
    action: menuFor(`<prism-menu-item value="copy">Copy link</prism-menu-item>`),
    radio: menuFor(`<prism-menu-item type="radio" value="light">Light</prism-menu-item>`),
    checked: menuFor(`<prism-menu-item type="radio" value="dark" checked>Dark</prism-menu-item>`),
    checkbox: menuFor(`<prism-menu-item type="checkbox" value="wrap" checked>Wrap lines</prism-menu-item>`),
    disabled: menuFor(`<prism-menu-item value="off" disabled>Unavailable</prism-menu-item>`),
    hint: menuFor(`<prism-menu-item value="palette">Command palette<span slot="hint">Ctrl K</span></prism-menu-item>`),
    detail: menuFor(`<prism-menu-item type="radio" value="platform" detail="api, web · 2 checkouts" checked>Platform<span slot="hint">in use · 2 gates</span></prism-menu-item><prism-menu-item type="radio" value="long" detail="${LONG}">${UNBROKEN}</prism-menu-item>`),
    "long-text": menuFor(`<prism-menu-item value="long">${LONG}<span slot="hint">Ctrl Shift Alt K</span></prism-menu-item>`),
    "unbroken-name": menuFor(`<prism-menu-item value="unbroken">${UNBROKEN}</prism-menu-item>`)
  },
  "prism-tooltip": {
    tip: `<prism-button tip="Opens the roadmap">Roadmap</prism-button>`,
    shortened: `<div class="catalog-narrow"><prism-chip>${LONG}</prism-chip></div>`,
    "long-text": `<prism-button tip="${LONG} ${LONG}">Hover for a long tip</prism-button>`,
    "unbroken-name": `<div class="catalog-narrow"><prism-chip tone="accent">${UNBROKEN}</prism-chip></div>`
  },
  "prism-field": {
    text: `<prism-field type="text" label="Name" name="name" placeholder="Name the slice"></prism-field>`,
    search: `<prism-field type="search" label="Jump to" name="q" placeholder="Search"></prism-field>`,
    textarea: `<prism-field type="textarea" label="Note" name="note" placeholder="Write a note"></prism-field>`,
    select: `<prism-field type="select" label="Lane" name="lane"><prism-option value="a">Alpha</prism-option><prism-option value="b" selected>Beta</prism-option></prism-field>`,
    hint: `<prism-field type="text" label="Reviewer" name="reviewer" hint="Optional unless you request changes"></prism-field>`,
    invalid: `<prism-field type="text" label="Name" name="required" required invalid error="A name is required"></prism-field>`,
    disabled: `<prism-field type="text" label="Locked" name="locked" value="fixed" disabled></prism-field>`,
    "long-text": `<prism-field type="text" label="${LONG}" hint="${LONG}" value="${LONG}"></prism-field>`,
    "unbroken-name": `<prism-field type="select" label="${UNBROKEN}"><prism-option value="u">${UNBROKEN}</prism-option></prism-field>`
  },
  "prism-option": {
    default: `<prism-field type="select" label="Theme"><prism-option value="system">System</prism-option><prism-option value="light">Light</prism-option></prism-field>`,
    selected: `<prism-field type="select" label="Density"><prism-option value="compact">Compact</prism-option><prism-option value="comfortable" selected>Comfortable</prism-option></prism-field>`,
    "long-text": `<prism-field type="select" label="Long option"><prism-option value="l">${LONG}</prism-option></prism-field>`,
    "unbroken-name": `<prism-field type="select" label="Unbroken option"><prism-option value="u">${UNBROKEN}</prism-option></prism-field>`
  },
  "prism-choice": {
    unchosen: choiceOf(answers),
    chosen: choiceOf(answers, { value: "accept" }),
    "with-detail": choiceOf(`<prism-choice-option value="now">Start now<span slot="detail">The first slice starts at once and the others wait for it.</span></prism-choice-option><prism-choice-option value="later">Later<span slot="detail">Nothing starts until you come back.</span></prism-choice-option>`, { label: "When to start" }),
    "many-items": choiceOf(repeat(12, (index) => `<prism-choice-option value="v${index}">${index % 3 ? `Option ${index + 1}` : `${UNBROKEN}-${index + 1}`}</prism-choice-option>`), { label: "Pick one of many" }),
    "long-text": choiceOf(`<prism-choice-option value="long">${LONG}<span slot="detail">${LONG}</span></prism-choice-option>`, { label: LONG }),
    "unbroken-name": choiceOf(`<prism-choice-option value="u">${UNBROKEN}<span slot="detail">${UNBROKEN}</span></prism-choice-option>`, { label: UNBROKEN })
  },
  "prism-choice-option": {
    unchecked: choiceOf(`<prism-choice-option value="a">Accept</prism-choice-option>`),
    checked: choiceOf(`<prism-choice-option value="a">Accept</prism-choice-option>`, { value: "a" }),
    danger: choiceOf(`<prism-choice-option value="r" tone="danger">Request changes</prism-choice-option>`, { value: "r" }),
    disabled: choiceOf(`<prism-choice-option value="l" disabled>Later</prism-choice-option>`),
    detail: choiceOf(`<prism-choice-option value="a">Accept<span slot="detail">The slices start in order.</span></prism-choice-option>`),
    "long-text": choiceOf(`<prism-choice-option value="a">${LONG}</prism-choice-option>`),
    "unbroken-name": choiceOf(`<prism-choice-option value="a">${UNBROKEN}</prism-choice-option>`)
  },
  "prism-stat": {
    default: `<prism-stat label="Open findings" value="3" hint="2 high"></prism-stat>`,
    tone: `<prism-stat label="Failing tests" value="12" tone="danger"></prism-stat><prism-stat label="Passing" value="48" tone="success"></prism-stat>`,
    "long-text": `<prism-stat label="${LONG}" value="1284" hint="${LONG}"></prism-stat>`,
    "unbroken-name": `<prism-stat label="${UNBROKEN}" value="${UNBROKEN}"></prism-stat>`
  },
  "prism-meter": {
    empty: `<prism-meter label="Lease left" value="0"></prism-meter>`,
    partial: `<prism-meter label="Lease left" value="42"></prism-meter>`,
    full: `<prism-meter label="Lease left" value="100" tone="success"></prism-meter>`,
    unknown: `<prism-meter label="Indexing"></prism-meter>`,
    "long-text": `<prism-meter label="${LONG}" value="64" tone="warning"></prism-meter>`,
    "unbroken-name": `<prism-meter label="${UNBROKEN}" value="12" tone="danger"></prism-meter>`
  },
  "prism-spinner": {
    default: `<prism-spinner label="Loading the workspace"></prism-spinner>`,
    "long-text": `<prism-spinner label="${LONG}"></prism-spinner>`,
    "unbroken-name": `<prism-spinner label="${UNBROKEN}"></prism-spinner>`
  },
  "prism-avatar": {
    agent: `<prism-avatar kind="agent" name="Claude on build-2"></prism-avatar><prism-avatar kind="agent" name="Codex on ci" size="sm"></prism-avatar><prism-avatar kind="agent" name="Claude on vm" size="lg"></prism-avatar>`,
    person: repeat(4, (index) => `<prism-avatar kind="person" name="Ada Lovelace" hue="${index + 1}"></prism-avatar>`) + `<prism-avatar kind="person" name="Grace Hopper" hue="3" size="lg"></prism-avatar>`,
    live: `<prism-avatar kind="agent" name="Claude on build-2" live></prism-avatar><prism-avatar kind="agent" name="Codex on ci" live breathing></prism-avatar>`,
    expired: `<prism-avatar kind="agent" name="Claude on build-2" expired></prism-avatar><prism-avatar kind="agent" name="Codex on ci" size="lg" expired></prism-avatar>`,
    "long-text": `<prism-avatar kind="person" name="${LONG}" hue="1"></prism-avatar><prism-avatar kind="agent" name="${LONG}" live></prism-avatar>`,
    "unbroken-name": `<prism-avatar kind="person" name="${UNBROKEN}" hue="4"></prism-avatar><prism-avatar kind="agent" name="${UNBROKEN}" expired></prism-avatar>`
  },
  "prism-panel": {
    card: `<prism-panel heading="Design" eyebrow="Slice"><p>The contract and its frozen tests.</p></prism-panel>`,
    plain: `<prism-panel heading="Diagram" variant="plain"><p>The slice's components.</p></prism-panel>`,
    inset: `<prism-panel heading="Verification" variant="inset"><p>The last passing run.</p></prism-panel>`,
    island: `<prism-panel heading="Change map" variant="island"><p>Planned changes.</p></prism-panel>`,
    "tools-and-footer": `<prism-panel heading="Review ledger" level="3"><prism-button slot="tools" size="sm" variant="ghost">Copy link</prism-button><p>Two open findings.</p><span slot="footer"><prism-button size="sm" variant="primary">Answer</prism-button></span></prism-panel>`,
    maximizable: `<prism-panel heading="Diagram" eyebrow="Slice" maximizable><p>Maximize fills the window; Restore or Escape brings it back.</p></prism-panel>`,
    "many-items": `<prism-panel heading="Planned changes"><prism-button slot="tools" size="sm" variant="ghost">Filter</prism-button><prism-button slot="tools" size="sm" variant="ghost">Sort</prism-button><prism-button slot="tools" size="sm" variant="ghost">Copy</prism-button>${repeat(14, (index) => `<p>Change ${index + 1} of the slice.</p>`)}</prism-panel>`,
    "long-text": `<prism-panel heading="${LONG}" eyebrow="${LONG}" maximizable><prism-button slot="tools" size="sm" variant="ghost">${LONG}</prism-button><p>${LONG}</p><p slot="footer">${LONG}</p></prism-panel>`,
    "unbroken-name": `<prism-panel heading="${UNBROKEN}" eyebrow="${UNBROKEN}" variant="island"><prism-button slot="tools" size="sm" variant="ghost">${UNBROKEN}</prism-button><p>${UNBROKEN}</p></prism-panel>`
  },
  "prism-tree": {
    default: `<prism-tree label="Places"><prism-tree-item label="Attention" value="attention" selected><prism-badge slot="end">2</prism-badge></prism-tree-item><prism-tree-item label="Roadmap" value="roadmap"></prism-tree-item></prism-tree>`,
    nested: `<prism-tree label="Initiatives"><prism-tree-item label="Review app UI kit" value="kit" expanded><prism-tree-item label="Kit foundation" value="foundation"></prism-tree-item><prism-tree-item label="Kit containers" value="containers"><prism-tree-item label="Claims" value="claims"></prism-tree-item></prism-tree-item></prism-tree-item><prism-tree-item label="Harden request retries" value="retries"><prism-tree-item label="Timeout retries" value="timeout"></prism-tree-item></prism-tree-item></prism-tree>`,
    selected: `<prism-tree label="Library"><prism-tree-item label="Decisions" value="decisions"></prism-tree-item><prism-tree-item label="Requirements" value="requirements" selected><prism-badge slot="end">14</prism-badge></prism-tree-item></prism-tree>`,
    "many-items": `<prism-tree label="Many initiatives">${repeat(30, (index) => `<prism-tree-item label="${index % 5 ? `Initiative ${index + 1}` : `${UNBROKEN}-${index + 1}`}" value="i${index}"${index === 2 ? " expanded" : ""}><prism-badge slot="end">${index * 3}</prism-badge>${index === 2 ? repeat(6, (child) => `<prism-tree-item label="Slice ${child + 1} of a long initiative" value="i${index}-${child}"></prism-tree-item>`) : ""}</prism-tree-item>`)}</prism-tree>`,
    "long-text": `<prism-tree label="Long"><prism-tree-item label="${LONG}" value="long" expanded><prism-badge slot="end">128</prism-badge><prism-tree-item label="${LONG}" value="long-child"></prism-tree-item></prism-tree-item></prism-tree>`,
    "unbroken-name": `<prism-tree label="Unbroken"><prism-tree-item label="${UNBROKEN}" value="unbroken" expanded><prism-tree-item label="${UNBROKEN}" value="unbroken-child"><prism-badge slot="end">${UNBROKEN}</prism-badge></prism-tree-item></prism-tree-item></prism-tree>`
  },
  "prism-tree-item": {
    leaf: `<prism-tree label="Leaf"><prism-tree-item label="Roadmap" value="roadmap"></prism-tree-item></prism-tree>`,
    collapsed: `<prism-tree label="Collapsed"><prism-tree-item label="Harden request retries" value="retries"><prism-tree-item label="Timeout retries" value="timeout"></prism-tree-item></prism-tree-item></prism-tree>`,
    expanded: `<prism-tree label="Expanded"><prism-tree-item label="Harden request retries" value="retries" expanded><prism-tree-item label="Timeout retries" value="timeout"></prism-tree-item></prism-tree-item></prism-tree>`,
    selected: `<prism-tree label="Selected"><prism-tree-item label="Attention" value="attention" selected><prism-badge slot="end">3</prism-badge></prism-tree-item></prism-tree>`,
    "long-text": `<prism-tree label="Long item"><prism-tree-item label="${LONG}" value="long"><prism-badge slot="end">7</prism-badge></prism-tree-item></prism-tree>`,
    "unbroken-name": `<prism-tree label="Unbroken item"><prism-tree-item label="${UNBROKEN}" value="unbroken"></prism-tree-item></prism-tree>`
  },
  "prism-listbox": {
    default: `<prism-listbox label="Results"><prism-list-item value="kit">Review app UI kit<span slot="meta">Initiative</span></prism-list-item><prism-list-item value="containers">Kit containers<span slot="meta">Slice</span></prism-list-item></prism-listbox>`,
    active: `<prism-listbox label="Active result"><prism-list-item value="a" active>Roadmap<span slot="meta">Place</span></prism-list-item><prism-list-item value="b">Attention<span slot="meta">Place</span></prism-list-item></prism-listbox>`,
    selected: `<prism-listbox label="Selected result"><prism-list-item value="a">Design</prism-list-item><prism-list-item value="b" selected>Diagram</prism-list-item></prism-listbox>`,
    "with-field": `<prism-field id="catalog-listbox-field" type="search" label="Jump to" name="jump" placeholder="Type, then ArrowDown"></prism-field><prism-listbox label="Matches" for="catalog-listbox-field"><prism-list-item value="r">Roadmap<span slot="meta">Place</span></prism-list-item><prism-list-item value="t">Timeout retries<span slot="meta">Slice</span></prism-list-item></prism-listbox>`,
    "many-items": `<prism-listbox label="Many results">${repeat(40, (index) => `<prism-list-item value="r${index}">${index % 4 ? `Result ${index + 1}` : `${UNBROKEN}-${index + 1}`}<span slot="meta">${index % 3 ? "Slice" : "Decision · Proposed"}</span></prism-list-item>`)}</prism-listbox>`,
    "long-text": `<prism-listbox label="Long results"><prism-list-item value="l">${LONG}<span slot="meta">${LONG}</span></prism-list-item></prism-listbox>`,
    "unbroken-name": `<prism-listbox label="Unbroken results"><prism-list-item value="u">${UNBROKEN}<span slot="meta">${UNBROKEN}</span></prism-list-item></prism-listbox>`
  },
  "prism-list-item": {
    default: `<prism-listbox label="One result"><prism-list-item value="a">Kit controls</prism-list-item></prism-listbox>`,
    active: `<prism-listbox label="Active option"><prism-list-item value="a" active>Kit controls</prism-list-item></prism-listbox>`,
    selected: `<prism-listbox label="Selected option"><prism-list-item value="a" selected>Kit controls</prism-list-item></prism-listbox>`,
    meta: `<prism-listbox label="Option with kind"><prism-list-item value="a">Retry with a deadline<span slot="meta">Decision · Accepted</span></prism-list-item></prism-listbox>`,
    "long-text": `<prism-listbox label="Long option"><prism-list-item value="a">${LONG}<span slot="meta">Slice</span></prism-list-item></prism-listbox>`,
    "unbroken-name": `<prism-listbox label="Unbroken option"><prism-list-item value="a">${UNBROKEN}</prism-list-item></prism-listbox>`
  },
  "prism-dialog": {
    closed: opener("Open the record store", `<prism-dialog heading="Record store"><p>Records live in a shared store.</p><prism-field type="text" label="Filter" name="filter"></prism-field><prism-button slot="footer" variant="primary">Copy location</prism-button></prism-dialog>`),
    center: opener("Open a small dialog", `<prism-dialog heading="Switch project" size="sm"><p>Pick the project this page shows.</p></prism-dialog>`),
    start: opener("Open the navigation drawer", `<prism-dialog heading="Navigation" placement="start"><prism-tree label="Drawer places"><prism-tree-item label="Attention" value="attention" selected></prism-tree-item><prism-tree-item label="Roadmap" value="roadmap"></prism-tree-item></prism-tree></prism-dialog>`),
    bottom: opener("Open the bottom sheet", `<prism-dialog heading="Diagram" placement="bottom"><p>The slice's diagram on a phone.</p></prism-dialog>`),
    "long-content": opener("Open a long dialog", `<prism-dialog heading="Command palette" size="lg">${repeat(30, (index) => `<p>Paragraph ${index + 1} of a body that scrolls inside the dialog.</p>`)}</prism-dialog>`),
    "long-text": opener(LONG, `<prism-dialog heading="${LONG}"><p>${LONG} ${LONG}</p></prism-dialog>`),
    "unbroken-name": opener(UNBROKEN, `<prism-dialog heading="${UNBROKEN}"><p>${UNBROKEN}</p></prism-dialog>`)
  },
  "prism-popover": {
    closed: popoverFor("Show the working agents", `<p>Claude on build-2 · Agent · implementation · 41 min left</p>`, { heading: "Agents at work" }),
    open: popoverFor("Show the record", `<p>Opens anchored to its button and stays inside the window.</p><prism-button size="sm">Copy link</prism-button>`, { heading: "Record" }),
    "long-content": popoverFor("Show many lines", repeat(30, (index) => `<p>Line ${index + 1} of a popover that scrolls inside itself.</p>`), { heading: "Many lines" }),
    "long-text": popoverFor(LONG, `<p>${LONG} ${LONG}</p>`, { heading: LONG }),
    "unbroken-name": popoverFor(UNBROKEN, `<p>${UNBROKEN}</p>`, { heading: UNBROKEN })
  },
  "prism-disclosure": {
    closed: `<prism-disclosure summary="Earlier runs"><p>Three runs.</p></prism-disclosure>`,
    open: `<prism-disclosure summary="Raw record" open><prism-code><pre><code>{ "status": "passing" }</code></pre></prism-code></prism-disclosure>`,
    "long-text": `<prism-disclosure summary="${LONG}" open><p>${LONG}</p></prism-disclosure>`,
    "unbroken-name": `<prism-disclosure summary="${UNBROKEN}" open><p>${UNBROKEN}</p></prism-disclosure>`
  },
  "prism-empty-state": {
    default: `<prism-empty-state heading="No change map yet"><p>The slice records one when it starts.</p></prism-empty-state>`,
    "with-action": `<prism-empty-state heading="Nothing waits for you"><p>Answered gates move to Earlier.</p><prism-button size="sm">Open the roadmap</prism-button></prism-empty-state>`,
    "long-text": `<prism-empty-state heading="${LONG}"><p>${LONG}</p></prism-empty-state>`,
    "unbroken-name": `<prism-empty-state heading="${UNBROKEN}"><p>${UNBROKEN}</p></prism-empty-state>`
  },
  "prism-banner": {
    info: `<prism-banner tone="info" heading="The review app restarted"><p>This page reconnected.</p></prism-banner>`,
    warning: `<prism-banner tone="warning" heading="The claim expired"><p>Nobody holds the slice.</p></prism-banner>`,
    danger: `<prism-banner tone="danger" heading="The review app stopped"><p>This page is no longer live.</p></prism-banner>`,
    success: `<prism-banner tone="success" heading="Verification passed"><p>The slice is done.</p></prism-banner>`,
    dismissible: `<prism-banner tone="warning" heading="This page belongs to one session" dismissible><p>Another session may show this project elsewhere.</p></prism-banner>`,
    "long-text": `<prism-banner tone="info" heading="${LONG}" dismissible><p>${LONG} ${LONG}</p></prism-banner>`,
    "unbroken-name": `<prism-banner tone="danger" heading="${UNBROKEN}"><p>${UNBROKEN}</p></prism-banner>`
  },
  "prism-toast": {
    hidden: `<prism-toast></prism-toast><p class="catalog-note">The page's one toast shows a message at the bottom of the window for five seconds.</p>`,
    shown: toastButton("Show a message", "Answer sent", "success"),
    "long-text": toastButton("Show a long message", LONG, "info"),
    "unbroken-name": toastButton("Show an unbroken message", UNBROKEN, "warning")
  },
  "prism-claim": {
    avatar: claimOf({ variant: "avatar" }),
    inline: claimOf({ variant: "inline" }) + claimOf({ variant: "inline", label: "Codex on ci", activity: "design", left: 180 }),
    strip: claimOf({ variant: "strip" }),
    expired: claimOf({ variant: "inline", label: "Claude on vm", activity: "design", left: -4 }) + claimOf({ variant: "avatar", label: "Claude on vm", left: -4 }),
    "expired-strip": claimOf({ variant: "strip", label: "Claude on vm", left: -95 }),
    "long-text": claimOf({ variant: "inline", label: LONG }) + claimOf({ variant: "strip", label: LONG, left: 3000 }),
    "unbroken-name": claimOf({ variant: "inline", label: UNBROKEN }) + claimOf({ variant: "strip", label: UNBROKEN, left: -3000 })
  },
  "prism-stepper": {
    default: stepper(3),
    early: stepper(1),
    shipped: stepper(6),
    "many-items": `<prism-stepper label="Many steps">${repeat(18, (index) => `<prism-step phase="${PHASES[index % 6]}" state="${index < 7 ? "done" : index === 7 ? "current" : "upcoming"}">Step ${index + 1}</prism-step>`)}</prism-stepper>`,
    "long-text": `<prism-stepper label="Long steps">${PHASES.map((phase, index) => `<prism-step phase="${phase}" state="${index < 2 ? "done" : index === 2 ? "current" : "upcoming"}">${LONG}</prism-step>`).join("")}</prism-stepper>`,
    "unbroken-name": `<prism-stepper label="Unbroken steps">${PHASES.map((phase, index) => `<prism-step phase="${phase}" state="${index < 4 ? "done" : index === 4 ? "current" : "upcoming"}">${UNBROKEN}</prism-step>`).join("")}</prism-stepper>`
  },
  "prism-step": {
    done: `<prism-stepper label="Done step"><prism-step phase="requirements" state="done">Requirements</prism-step></prism-stepper>`,
    current: `<prism-stepper label="Current step"><prism-step phase="build" state="current">Build</prism-step></prism-stepper>`,
    upcoming: `<prism-stepper label="Upcoming step"><prism-step phase="shipped" state="upcoming">Shipped</prism-step></prism-stepper>`,
    "long-text": `<prism-stepper label="Long step"><prism-step phase="design" state="current">${LONG}</prism-step></prism-stepper>`,
    "unbroken-name": `<prism-stepper label="Unbroken step"><prism-step phase="review" state="done">${UNBROKEN}</prism-step></prism-stepper>`
  },
  "prism-breadcrumbs": {
    default: crumbs(["Roadmap", "Review app UI kit", "Kit containers"]),
    "one-crumb": crumbs(["Attention"]),
    "many-items": crumbs(Array.from({ length: 12 }, (_, index) => `Level ${index + 1}`)),
    "long-text": crumbs(["Roadmap", LONG, LONG]),
    "unbroken-name": crumbs(["Roadmap", UNBROKEN, "Retry timed-out requests until a total deadline"])
  },
  "prism-doc": {
    default: `<prism-doc><h3>Contract</h3><p>The review server serves every file under the kit folder.</p></prism-doc>`,
    rich: `<prism-doc><h2>Retries</h2><p>A request retries with <code>backoff</code> until <a href="#entry-prism-doc">a total deadline</a>.</p><ul><li>Each retry waits longer.</li><li>No retry outlives the deadline.</li></ul><blockquote><p>Retries never hide a failure.</p></blockquote><table><tr><th>Term</th><th>Meaning</th></tr><tr><td>Deadline</td><td>The time the last retry must end by.</td></tr></table><pre><code><span class="tok-keyword">const</span> deadline = <span class="tok-number">30</span>;</code></pre></prism-doc>`,
    "long-text": `<prism-doc><h3>${LONG}</h3><p>${LONG} ${LONG}</p></prism-doc>`,
    "unbroken-name": `<prism-doc><h3>${UNBROKEN}</h3><p><code>${UNBROKEN}</code></p><table><tr><th>${UNBROKEN}</th><td>${UNBROKEN}</td></tr></table></prism-doc>`
  },
  "prism-code": {
    default: `<prism-code language="js"><pre><code>export const KIT_ELEMENTS = [];</code></pre></prism-code>`,
    numbers: `<prism-code language="js" numbers start="7"><pre><code>const first = 1;
const second = 2;
const third = 3;</code></pre></prism-code>`,
    syntax: `<prism-code language="js" numbers><pre><code><span class="tok-comment">// Retry until the deadline.</span>
<span class="tok-keyword">export function</span> <span class="tok-function">retry</span>(<span class="tok-attr">task</span>: <span class="tok-type">Task</span>) {
  <span class="tok-keyword">return</span> <span class="tok-string">"done"</span> + <span class="tok-number">42</span> + <span class="tok-unknown">other</span>;
}</code></pre></prism-code>`,
    "long-text": `<prism-code numbers><pre><code>${LONG} ${LONG} ${LONG}</code></pre></prism-code>`,
    "unbroken-name": `<prism-code><pre><code>${UNBROKEN}${UNBROKEN}</code></pre></prism-code>`
  }
};

// Long text and an unbroken name for an element whose specimens do not give their own.
function fallback(tag, text) {
  return `<${tag}>${text}</${tag}>`;
}

function specimensOf(element) {
  const own = SPECIMENS[element.tag] ?? {};
  const states = element.catalog.states.map((state) => [state, own[state] ?? fallback(element.tag, html(state))]);
  const extra = ["long-text", "unbroken-name", "many-items"]
    .filter((name) => !element.catalog.states.includes(name) && (own[name] || name !== "many-items"))
    .map((name) => [name, own[name] ?? fallback(element.tag, name === "long-text" ? LONG : UNBROKEN)]);
  return [...states, ...extra];
}

function optionsList(options) {
  if (!options.length) return `<p data-doc="options" class="catalog-quiet">No options of its own.</p>`;
  return `<dl data-doc="options" class="catalog-options">${options.map((option) => `<div class="catalog-option"><dt><code>${html(option.name)}</code></dt><dd><span class="catalog-values">${option.values.map((value) => `<code>${html(value)}</code>`).join(" ")}</span>${option.default ? ` <span class="catalog-quiet">Default <code>${html(option.default)}</code>.</span>` : ""} ${html(option.description ?? "")}</dd></div>`).join("")}</dl>`;
}

function entryMarkup(element) {
  const { purpose, options, states, keyboard } = element.catalog;
  const keys = keyboard.length ? `<ul data-doc="keyboard">${keyboard.map((line) => `<li>${html(line)}</li>`).join("")}</ul>` : `<p data-doc="keyboard" class="catalog-quiet">No keys of its own.</p>`;
  const specimens = specimensOf(element).map(([state, markup]) => `<figure class="catalog-specimen" data-specimen="${html(state)}"><figcaption>${html(state)}</figcaption><div class="catalog-stage">${markup}</div></figure>`).join("");
  return `<section class="catalog-entry" data-catalog-entry="${element.tag}" id="entry-${element.tag}" aria-labelledby="entry-${element.tag}-heading">
    <header class="catalog-entry-head"><h2 id="entry-${element.tag}-heading"><code>${element.tag}</code></h2><span class="catalog-quiet">${element.styles ? "Shadow DOM" : "Light DOM"}</span></header>
    <p data-doc="purpose" class="catalog-purpose">${html(purpose)}</p>
    <div class="catalog-docs">
      <div class="catalog-doc"><h3>Options</h3>${optionsList(options)}</div>
      <div class="catalog-doc"><h3>States</h3><ul data-doc="states" class="catalog-states">${states.map((state) => `<li><code>${html(state)}</code></li>`).join("")}</ul></div>
      <div class="catalog-doc"><h3>Keyboard</h3>${keys}</div>
    </div>
    <div class="catalog-specimens">${specimens}</div>
  </section>`;
}

// ---------- Design values, read from the stylesheet the page loaded ----------

function tokenRules() {
  const found = { light: null, dark: null, root: null, comfortable: null, reduced: null };
  for (const sheet of document.styleSheets) {
    if (!sheet.href?.endsWith("/kit/tokens.css")) continue;
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule.media && /prefers-reduced-motion/.test(rule.media.mediaText)) found.reduced = [...rule.cssRules].find((inner) => inner.style)?.style ?? null;
      if (!rule.style || !rule.selectorText) continue;
      const selector = rule.selectorText.replace(/\s+/g, " ");
      if (selector.includes('[data-theme="light"]')) found.light = rule.style;
      else if (selector === '[data-theme="dark"]') found.dark = rule.style;
      else if (selector === ":root") found.root = rule.style;
      else if (selector === '[data-density="comfortable"]') found.comfortable = rule.style;
    }
  }
  return found;
}

const declared = (style) => (style ? [...style].filter((name) => name.startsWith("--prism-")) : []);
const value = (style, name) => style?.getPropertyValue(name).trim() ?? "";

function swatch(name, theme) {
  if (name.startsWith("--prism-shadow-")) return `<span class="catalog-swatch is-shadow" data-theme="${theme}" data-token="${name}"></span>`;
  if (name.startsWith("--prism-gradient-")) return `<span class="catalog-swatch is-gradient" data-theme="${theme}" data-token="${name}"></span>`;
  // A color swatch is SVG, so it paints the theme's color in either page theme.
  return `<span class="catalog-swatch" data-theme="${theme}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect class="catalog-swatch-fill" data-token="${name}" x="0.5" y="0.5" width="15" height="15" rx="3"/></svg></span>`;
}

function designValues() {
  const rules = tokenRules();
  const semantic = declared(rules.light).filter((name) => /^--prism-(color|shadow)-/.test(name) || name === "--prism-gradient-canvas");
  const rows = semantic.map((name) => `<div class="catalog-token" role="row"><code class="catalog-token-name" role="rowheader">${name}</code><span class="catalog-token-value" role="cell">${swatch(name, "light")}<code>${html(value(rules.light, name))}</code></span><span class="catalog-token-value" role="cell">${swatch(name, "dark")}<code>${html(value(rules.dark, name))}</code></span></div>`).join("");
  const others = declared(rules.root).map((name) => `<div class="catalog-token" role="row"><code class="catalog-token-name" role="rowheader">${name}</code><span class="catalog-token-value" role="cell"><code>${html(value(rules.root, name))}</code></span><span class="catalog-token-value" role="cell"><code>${html(value(rules.comfortable, name) || "same")}</code></span></div>`).join("");
  const motion = declared(rules.reduced).map((name) => `<li><code>${name}</code> <code>${html(value(rules.reduced, name))}</code></li>`).join("");
  return `<section class="catalog-entry" data-catalog-entry="design-values" id="design-values" aria-labelledby="design-values-heading">
    <header class="catalog-entry-head"><h2 id="design-values-heading">Design values</h2><span class="catalog-quiet">kit/tokens.css</span></header>
    <p class="catalog-purpose">Every color, size, radius, shadow, blur, layer, font, and motion duration of the review app is one of these custom properties. The semantic tokens are the names a theme gives a value to; they are a stable contract.</p>
    <h3>Semantic tokens</h3>
    <div class="catalog-tokens" role="table" aria-label="Semantic tokens"><div class="catalog-token is-head" role="row"><span role="columnheader">Token</span><span role="columnheader">Light</span><span role="columnheader">Dark</span></div>${rows}</div>
    <h3>Other design values</h3>
    <div class="catalog-tokens" role="table" aria-label="Other design values"><div class="catalog-token is-head" role="row"><span role="columnheader">Value</span><span role="columnheader">Compact</span><span role="columnheader">Comfortable</span></div>${others}</div>
    <h3>Reduced motion</h3>
    <ul class="catalog-motion">${motion}</ul>
  </section>`;
}

// Swatches read their token through a custom property set from script, since the page's policy refuses inline styles.
function paintSwatches(root) {
  for (const node of root.querySelectorAll("[data-token]")) node.style.setProperty("--catalog-swatch", `var(${node.dataset.token})`);
}

// ---------- Toolbar: theme, density, and width for the catalog alone ----------

const query = new URLSearchParams(location.search);
const scope = document.getElementById("catalog");
const choice = {
  theme: ["light", "dark"].includes(query.get("theme")) ? query.get("theme") : null,
  density: ["compact", "comfortable"].includes(query.get("density")) ? query.get("density") : null,
  width: query.get("width") === "narrow" ? "narrow" : "wide"
};

const GROUPS = [
  // Named so it does not read as the review page's Theme group.
  { key: "theme", label: "Color scheme", options: [["system", "System"], ["light", "Light"], ["dark", "Dark"]] },
  { key: "density", label: "Density", options: [["compact", "Compact"], ["comfortable", "Comfortable"]] },
  { key: "width", label: "Width", options: [["narrow", "Narrow"], ["wide", "Wide"]] }
];

function toolbar() {
  const tools = document.getElementById("catalog-tools");
  tools.innerHTML = GROUPS.map((group) => `<div class="catalog-tool" role="group" aria-label="${group.label}"><span class="catalog-tool-label" aria-hidden="true">${group.label}</span>${group.options.map(([value, label]) => `<prism-button size="sm" variant="ghost" pressed="false" data-key="${group.key}" data-value="${value}">${label}</prism-button>`).join("")}</div>`).join("");
  tools.addEventListener("click", (event) => {
    const button = event.target.closest("prism-button[data-key]");
    if (!button) return;
    const { key, value } = button.dataset;
    if (key === "width") choice.width = value;
    else choice[key] = value;
    apply();
  });
}

function apply() {
  const shown = applyPreferences({ ...currentPreferences(), ...(choice.theme ? { theme: choice.theme } : {}), ...(choice.density ? { density: choice.density } : {}) });
  scope.dataset.width = choice.width;
  for (const button of document.querySelectorAll("#catalog-tools prism-button")) {
    const { key, value } = button.dataset;
    const current = key === "width" ? choice.width : shown[key];
    button.pressed = current === value;
  }
}

toolbar();
apply();
await loadPreferences();
apply();
scope.innerHTML = [designValues(), ...KIT_ELEMENTS.map(entryMarkup)].join("");
paintSwatches(scope);
// Specimen buttons open their dialog or show a toast message.
scope.addEventListener("click", (event) => {
  const button = event.target.closest?.("prism-button[data-opens], prism-button[data-toast]");
  if (!button) return;
  if (button.dataset.opens) document.getElementById(button.dataset.opens)?.show();
  else document.querySelector("prism-toast")?.show(button.dataset.toast, { tone: button.dataset.tone });
});
scope.setAttribute("aria-busy", "false");
