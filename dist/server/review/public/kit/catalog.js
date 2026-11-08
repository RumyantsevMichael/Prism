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
    tone: `<prism-stat label="Failing tests" value="12" tone="danger"></prism-stat>`
  },
  "prism-meter": {
    empty: `<prism-meter label="Lease left" value="0"></prism-meter>`,
    partial: `<prism-meter label="Lease left" value="42"></prism-meter>`,
    full: `<prism-meter label="Lease left" value="100" tone="success"></prism-meter>`,
    unknown: `<prism-meter label="Indexing"></prism-meter>`
  },
  "prism-spinner": { default: `<prism-spinner label="Loading the workspace"></prism-spinner>` },
  "prism-avatar": {
    agent: `<prism-avatar kind="agent" name="Claude on build-2"></prism-avatar>`,
    person: `<prism-avatar kind="person" name="Ada Lovelace" hue="2"></prism-avatar>`,
    live: `<prism-avatar kind="agent" name="Claude on build-2" live></prism-avatar>`,
    expired: `<prism-avatar kind="agent" name="Claude on build-2" expired></prism-avatar>`
  },
  "prism-panel": {
    card: `<prism-panel heading="Design" variant="card"><p>The contract and its frozen tests.</p></prism-panel>`,
    plain: `<prism-panel heading="Diagram" variant="plain"><p>The slice's components.</p></prism-panel>`,
    inset: `<prism-panel heading="Verification" variant="inset"><p>The last passing run.</p></prism-panel>`,
    island: `<prism-panel heading="Change map" variant="island"><p>Planned changes.</p></prism-panel>`
  },
  "prism-tree": { default: `<prism-tree label="Specimen tree"><prism-tree-item label="Roadmap" value="roadmap"></prism-tree-item></prism-tree>` },
  "prism-tree-item": { default: `<prism-tree label="Specimen tree"><prism-tree-item label="Attention" value="attention"></prism-tree-item></prism-tree>` },
  "prism-listbox": { default: `<prism-listbox label="Specimen results"><prism-list-item value="a">Review app UI kit</prism-list-item></prism-listbox>` },
  "prism-list-item": { default: `<prism-listbox label="Specimen results"><prism-list-item value="a" selected>Kit controls</prism-list-item></prism-listbox>` },
  "prism-dialog": { closed: `<prism-dialog heading="Command palette"><p>Search the workspace.</p></prism-dialog><p class="catalog-note">A closed dialog shows nothing.</p>` },
  "prism-popover": { closed: `<prism-popover heading="Who's working"><p>Live claims.</p></prism-popover><p class="catalog-note">A closed popover shows nothing.</p>` },
  "prism-disclosure": { closed: `<prism-disclosure summary="Earlier runs"><p>Three runs.</p></prism-disclosure>` },
  "prism-empty-state": { default: `<prism-empty-state heading="No change map yet"><p>The slice records one when it starts.</p></prism-empty-state>` },
  "prism-banner": {
    info: `<prism-banner tone="info" heading="The review app restarted"><p>This page reconnected.</p></prism-banner>`,
    warning: `<prism-banner tone="warning" heading="The claim expired"><p>Nobody holds the slice.</p></prism-banner>`,
    danger: `<prism-banner tone="danger" heading="The review app stopped"><p>This page is no longer live.</p></prism-banner>`,
    success: `<prism-banner tone="success" heading="Verification passed"><p>The slice is done.</p></prism-banner>`
  },
  "prism-toast": { hidden: `<prism-toast></prism-toast><p class="catalog-note">A toast shows a message for a few seconds.</p>` },
  "prism-claim": { inline: `<prism-claim label="Claude on build-2" activity="implementation"></prism-claim>` },
  "prism-stepper": { default: `<prism-stepper label="Lifecycle"><prism-step phase="requirements" state="done">Requirements</prism-step><prism-step phase="design" state="current">Design</prism-step></prism-stepper>` },
  "prism-step": {
    done: `<prism-stepper label="Lifecycle"><prism-step phase="requirements" state="done">Requirements</prism-step></prism-stepper>`,
    current: `<prism-stepper label="Lifecycle"><prism-step phase="build" state="current">Build</prism-step></prism-stepper>`,
    upcoming: `<prism-stepper label="Lifecycle"><prism-step phase="shipped" state="upcoming">Shipped</prism-step></prism-stepper>`
  },
  "prism-breadcrumbs": { default: `<prism-breadcrumbs><a href="#entry-prism-breadcrumbs">Roadmap</a> <a href="#entry-prism-breadcrumbs">Review app UI kit</a></prism-breadcrumbs>` },
  "prism-doc": { default: `<prism-doc><h3>Contract</h3><p>The review server serves every file under the kit folder.</p></prism-doc>` },
  "prism-code": { default: `<prism-code language="js"><pre><code>export const KIT_ELEMENTS = [];</code></pre></prism-code>` }
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
scope.setAttribute("aria-busy", "false");
