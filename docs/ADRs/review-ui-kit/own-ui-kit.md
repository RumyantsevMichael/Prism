# Build the review app on its own UI kit

Status: Proposed
Created: 2026-11-07

## Requirements

- [review-app-ui-kit.md§1](../../requirements/review-app-ui-kit.md#1)
- [review-app-ui-kit.md§2](../../requirements/review-app-ui-kit.md#2)
- [review-app-ui-kit.md§3](../../requirements/review-app-ui-kit.md#3)
- [review-app-ui-kit.md§4](../../requirements/review-app-ui-kit.md#4)
- [review-app-ui-kit.md§5](../../requirements/review-app-ui-kit.md#5)
- [review-app-ui-kit.md§6](../../requirements/review-app-ui-kit.md#6)
- [review-app-ui-kit.md§7](../../requirements/review-app-ui-kit.md#7)
- [review-app-ui-kit.md§8](../../requirements/review-app-ui-kit.md#8)
- [review-app-ui-kit.md§9](../../requirements/review-app-ui-kit.md#9)
- [review-app-ui-kit.md§10](../../requirements/review-app-ui-kit.md#10)
- [review-app-ui-kit.md§11](../../requirements/review-app-ui-kit.md#11)
- [review-app-ui-kit.md§12](../../requirements/review-app-ui-kit.md#12)
- [review-app-ui-kit.md§13](../../requirements/review-app-ui-kit.md#13)

## Problem

Every screen of the review app styles its own controls, so the same control looks and behaves differently from screen to screen, and dark mode is patched area by area.
The app must become one dense, quiet, IDE-like tool that keeps its palette, lets the person choose a theme and a density, and stays consistent as screens are added.
The review page runs under a content security policy that refuses inline styles and inline scripts, ships without a build step, and is served from a port that can change between runs.

## Decision

The review app MUST draw every color, font size, spacing, corner radius, shadow, motion duration, and stacking layer from one file of named design values, and no other file of the app MAY hold such a raw value.
Each kind of control MUST have exactly one shared component, a browser-native custom element named with the `prism-` prefix, written as plain JavaScript modules and CSS files that the server sends as they are, with no build step and no external component library.
A self-contained control MUST render its internals in shadow DOM and take its styles from constructed stylesheets that it adopts, because the page's policy refuses style elements.
A component that holds Markdown, code, or other caller content MUST use light DOM, so that content stays reachable by page scripts, search, and selection, and the kit's document stylesheet MUST style it.
A component that wraps a native form control MUST create that control itself in light DOM, so forms, events, and assistive technology see a native control.
Outside the kit, screens MUST compose kit components and MAY add only layout: placement, sizes, and arrangement.
A theme MUST be one complete set of values for the semantic tokens, selected by an attribute, and the light and dark themes MUST be two instances of that one mechanism rather than special cases, so a further theme can be added later by supplying another value set.
Every color, including code highlighting, diff lines, status tones, and the diagram sheet, MUST come from a semantic token, and shadow-DOM controls MUST read the same tokens.
The semantic token names MUST stay a stable contract that the catalog lists.
The contrast guarantee MUST hold for every shipped theme and covers only shipped themes.
A theme MAY also restate the island and glass shape values, so a theme can flatten the islands into plain panes.
Text and field boundaries on a translucent, blurring surface MUST reach their contrast with that surface composed over pure black and over pure white, because anything can show through it.
Fields and choice controls MUST draw a boundary that reaches 3:1, while buttons, cards, rows, and avatars MAY rely on the contrast of their text.
Diagrams MUST follow the theme by mapping only the colors the vendored PlantUML runtime paints by default to diagram tokens, so every color an author set survives, and the table of those defaults MUST be pinned to the vendored runtime and checked against it.
Navigation MUST have one model at every width: one sidebar, which becomes a drawer on narrow windows, and pages reached through back and forward rather than a strip of open tabs.
The app MUST show who holds a claim wherever the claimed slice appears, from the claim data Prism already serves, and the kit MUST NOT offer claim actions until a decision adds them.
The app MUST name Prism's own records by title and kind, and MAY show a repository path only where the code is the subject.
The theme and density MUST be attributes on a root element that select design values, so any subtree, including a catalog specimen, can render in another theme or density.
The theme and density choices MUST be stored by the review app for the operating-system user, beside the app's other per-user state, and every page MUST also keep the last choice it saw in browser storage only to apply it before the first paint.
The interface font and the monospace font MUST ship with Prism under an open font license and load from the review app itself.
The app MUST serve a catalog page that renders every kit component from the kit's own registry and documentation, so the catalog cannot drift from what ships.
The test suite MUST refuse a raw design value outside the design values file and control styling or native control markup outside the kit.

## Rationale

One set of values and one component per control is what lets a theme, a density, or a contrast fix move every screen at once.
Native custom elements need no framework and no build step, which matches how the review app ships today and how a later desktop shell can host it.
Shadow DOM stops page styles from reaching a control's internals, but it would hide Markdown and code from page scripts and the document stylesheet, so content-holding components stay in light DOM.
A preference stored only in browser storage belongs to one origin, and the review app's origin changes with its port, so the choice would be lost when the port changes; the review app's per-user state survives that and is shared by every project and session.
Shipping the fonts makes every machine render the same text without network access.
Measuring glass against pure black and pure white makes its contrast independent of what the window happens to show behind it.
PlantUML's own default colors are a small, fixed set per runtime version, so mapping only them themes every diagram while leaving an author's deliberate colors alone; injecting a dark style instead would need a selector for every element kind of every diagram type and would override authored skin parameters.
Prism's record files are an implementation detail of the workflow, so a person reviewing work reads titles and kinds, and a path keeps meaning only where code is under review.

## Alternatives

- An external component library: it brings its own look, a build step or a large bundle, and styling that fights the content security policy; rejected by the maintainer.
- Utility-class CSS with no components: values would be shared, but the same control would still be assembled differently on each screen.
- Shadow DOM for every component: Markdown views, links, and code selection would need slots and duplicated content styles.
- Browser storage alone for preferences: the choice is lost whenever the review app binds another port.
- Inline style elements in shadow roots: the page's content security policy refuses them.
- A light sheet behind every diagram in the dark theme: the brightest surface on the screen becomes the diagram, and the sheet ignores the theme.
- An injected dark PlantUML style: it reaches only the element kinds it names, changes between runtime versions, and loses to or overrides authored colors unpredictably.
- An activity rail with an editor tab strip: two navigation models, and a row of file names where people look for titles.

## Consequences

- Every screen's markup changes to kit elements, and tests that matched the old markup change with it.
- Contributors add a value to the design values file or a component to the kit instead of styling in place, and the guard test tells them so.
- Kit controls that render their own internals cannot be restyled by screens, so a missing variant becomes a kit change.
- Shadow-DOM controls are undefined until their module loads, so the kit stylesheet must reserve their space to avoid a flash of unstyled controls.
- The guard is a static check, so it can refuse a legitimate value until the design values file names it.
- Renaming a semantic token breaks any theme written against it, so a rename needs the same care as a breaking interface change.
- Upgrading the vendored PlantUML runtime fails a test until its default colors are checked against the diagram mapping again.
- Backdrop blur costs paint time on low-end hardware; a theme can turn glass opaque by giving it an opaque fill.
- Claims show no person as holder until Prism's claim records say whether a person holds them.

## Mechanism

The design values file declares light values on the root and on any element marked light, dark values on any element marked dark, comfortable spacing and sizes on any element marked comfortable, and zero motion durations when the operating system asks for reduced motion.
A small classic script in the page head applies the last choice this browser saw, then the page asks the review app for the stored choice and applies it; while the choice is system, the page follows the operating system's setting as it changes.
The kit module loads each shadow control's stylesheet once, builds one constructed stylesheet per control, and only then defines the elements, so every instance shares one parsed sheet.
The catalog page reads the registry of kit elements and each element's documentation of its purpose, options, states, and keyboard behavior, and renders specimens for each state together with long text, unbroken names, and many items.
The layout check opens the catalog at each checked width and theme and fails on an entry that escapes its container, cuts off a control, or scrolls the page.
After the runtime draws a diagram, the page keeps the drawn SVG text and recolors a copy of it from the diagram tokens computed where it is shown, again on every theme change, giving each text the ground it sits on and lifting an authored text or line color only until it reaches its ratio.

## Decision Log
