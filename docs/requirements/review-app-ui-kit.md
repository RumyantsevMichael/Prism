# Review app UI kit

Status: Approved
Created: 2026-11-07
Approved: 2026-11-07

## Problem

Every screen of the review app styles its own controls, so the same kind of control looks and behaves differently from screen to screen.
On 7 November 2026 the stylesheet held 44 font sizes, 30 corner radii, 88 raw hex colors, about 30 separate chip and badge styles, and four unrelated button styles, while only part of the colors came from named values.
Dark mode is patched area by area, the top bar stays dark in the light theme, the person cannot choose a theme, and the named UI font is never loaded, so each machine shows a different font.
Michael wants the review app to become a professional tool with an IDE-like look that later runs as a desktop app, and a new screen today has no shared parts or rules to keep it consistent.

## Goals

- Give every screen one shared set of design values and one shared form for each kind of control.
- Move the overall look toward a dense, quiet IDE-like tool while keeping the current color palette.
- Let the person choose the theme and the density, with the theme applied to every surface.
- Keep one catalog that shows and documents every shared control as shipped, and that serves as the place to try to break it.
- Make a contributor's change fail its checks when it bypasses the shared values or controls.

## Non-goals

- A new color palette or brand.
- Publishing the kit as a separate package for use outside Prism.
- Changing what the screens show or how review, gates, and navigation behave, beyond the visual changes that aligning them with the kit brings.
- A desktop app shell.
- A themable kit for third-party extensions of the review app.

## Design questions

- What the IDE-like look means concretely for the top bar, cards, panels, spacing, and borders, shown in a mockup before implementation.
- Where the theme and density choices are kept: in the browser, or with the review app for all browsers of that user.
- Which shades of the current palette need adjusting to meet the contrast obligation while keeping its hues.
- Michael decided on 7 November 2026 that Prism builds its own kit rather than adopting an external component library, following the structure of a design system he maintains elsewhere (tokens, browser-native custom elements, and a catalog, with no build step), that shadow DOM is used only for self-contained controls while elements that hold Markdown or code use light DOM, and that one UI font ships with the app; design records these choices in an ADR.

<a id="1"></a>
## 1. Draw every screen from one set of design values

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall take every color, font size, spacing, corner radius, shadow, motion duration, and stacking layer on every screen from one named set of design values.

Rationale: One set of values is what keeps screens consistent and lets a theme or density change move every screen together.

Related: [review-app-ui-kit.md§10](#10)

<a id="2"></a>
## 2. Show each kind of control in one shared form

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall render each kind of control, including buttons, chips, badges, tabs, menus, trees, dialogs, tooltips, panels, fields, and empty states, through one shared component, so the control looks and behaves the same on every screen.

Rationale: The same control drawn differently on different screens makes the app read as a set of pages instead of one tool.

Related: [review-app-ui-kit.md§10](#10)

<a id="3"></a>
## 3. Let the person choose the theme

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses the light, dark, or system theme in the review app, the review app shall apply that theme to every surface, including the top bar, the status bar, panels, dialogs, and rendered content, and keep the choice when the page reloads or the app restarts.

Rationale: A professional tool lets its user pick the theme, and a surface that ignores the theme breaks the look.

Related: [review-app-ui-kit.md§4](#4)

<a id="4"></a>
## 4. Follow the operating system theme by default

Pattern: State-driven

Disposition: Active

Requirement: While the system theme is chosen, which is the default, the review app shall follow the operating system's light or dark setting and switch when that setting changes, without a reload.

Rationale: Most people expect an app to match their system until they choose otherwise.

Related: [review-app-ui-kit.md§3](#3)

<a id="5"></a>
## 5. Let the person choose the density

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses the compact or comfortable density in the review app, the review app shall apply that density to every screen and keep the choice when the page reloads or the app restarts, with compact as the default.

Rationale: Michael chose compact as the default for a dense IDE-like tool, while some people need more room.

Related: [review-app-ui-kit.md§3](#3)

<a id="6"></a>
## 6. Ship the interface font with the app

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall render interface text in one font that ships with Prism and loads without network access, and render code in one monospace font.

Rationale: A named font that is never loaded makes the app look different on every machine.

Related: n/a

<a id="7"></a>
## 7. Make every control usable from the keyboard

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall make every interactive shared component operable from the keyboard, show a visible focus indicator in both themes, and expose its role, name, and state to assistive technology.

Rationale: A tool people work in all day must work without a mouse, and a shared component fixes this once for every screen.

Related: [review-app-ui-kit.md§2](#2)

<a id="8"></a>
## 8. Keep text readable in both themes

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall give text and the boundaries of interactive controls at least the contrast that WCAG 2.2 level AA requires, in both themes and both densities.

Rationale: A dense, quiet look tempts low-contrast text, and a fixed bar keeps it readable.

Related: [review-app-ui-kit.md§1](#1)

<a id="9"></a>
## 9. Keep layout intact with long or many items

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a shared component receives text longer than its space, an unbroken name, or more items than fit, then the review app shall keep the component inside its container, shorten or wrap the text, and show the full text on hover and on keyboard focus.

Rationale: Michael verifies UI by trying to break it with long captions and different widths, so every shared component must survive that by itself.

Related: [review-app-ui-kit.md§10](#10)

<a id="10"></a>
## 10. Serve a catalog of the shared components

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall serve a catalog page that shows every shared component in each of its states, in both themes and both densities, with long text, unbroken names, many items, and narrow and wide widths, together with each component's purpose, options, states, and keyboard behavior.

Rationale: A catalog served by the app shows exactly what ships, so it documents the kit without drifting and gives one place to try to break it.

Related: [review-app-ui-kit.md§11](#11)

<a id="11"></a>
## 11. Check the catalog layout

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a catalog entry escapes its container, cuts off a control, or scrolls the whole page at a checked width in either theme, then Prism's layout check shall fail and name the entry, the width, and the theme.

Rationale: The catalog turns manual break-it testing into a repeatable check.

Related: [review-app-ui-kit.md§10](#10)

<a id="12"></a>
## 12. Refuse styling that bypasses the kit

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a change to the review app uses a raw color, font size, spacing, corner radius, shadow, or stacking value outside the design values, or styles a kind of control outside its shared component, then Prism's test suite shall fail and name the file and the value or control.

Rationale: Without a guard the stylesheet drifts back into one-off values, which is how it reached 88 raw colors.

Related: [review-app-ui-kit.md§1](#1), [review-app-ui-kit.md§2](#2)

<a id="13"></a>
## 13. Respect reduced motion

Pattern: Optional feature

Disposition: Active

Requirement: Where the operating system asks for reduced motion, the review app shall replace its animations and transitions with instant changes.

Rationale: Shared motion values make this one rule instead of one per screen.

Related: [review-app-ui-kit.md§1](#1)

<a id="14"></a>
## 14. Show who holds each claim

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show each live or expired claim on a slice, with its holder, whether the holder is a person or an agent, its activity in words, and its time left or time since expiry, wherever that slice appears, and shall offer no action that changes a claim.

Rationale: Several people and agents share one workspace, so the person needs to see at a glance who works on what before acting, while claim actions are separate work.

Related: [review-app-ui-kit.md§2](#2), [review-app-ui-kit.md§8](#8)

<a id="15"></a>
## 15. Name Prism's records by title and kind

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall name each of Prism's own records by its title and kind instead of its file name or storage path, and shall show a repository path only where the repository's code is the subject.

Rationale: Record files are how Prism stores its workflow, not what the person reviews, so file names add noise and change when storage moves, while a path still matters where code is under review.

Related: [review-app-ui-kit.md§2](#2)

<a id="16"></a>
## 16. Keep text on translucent surfaces readable over anything

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall give text and the boundaries of fields and choice controls on a translucent surface at least the contrast that WCAG 2.2 level AA requires whether pure black or pure white shows through that surface, in every shipped theme.

Rationale: A frosted overlay shows whatever lies behind it, so only a worst-case measure keeps its text readable on every screen.

Related: [review-app-ui-kit.md§8](#8)

<a id="17"></a>
## 17. Keep the person's preferences everywhere

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses how a part of the review app shows, such as the theme, the density, the roadmap, initiative, or change map view, the archive toggle, the collapsed roadmap lanes, the collapsed sidebar, or the side panel's width, the review app shall keep that choice for every project, port, window, and restart of that person's review app on the machine, while the folds, filters, and drafts of one page stay with that page's open tab.

Rationale: The review app runs on a port that changes, and browser storage is separate for every port, so a choice kept only in the browser or the page is lost on the next start, which Michael reported for the roadmap view on 10 November 2026.

Related: [review-app-ui-kit.md§3](#3), [review-app-ui-kit.md§5](#5)

## 18. Group the tabs that belong to one piece of work

Pattern: Event-driven

Disposition: Active

Requirement: When an agent presents tabs under a group name, the review app shall show those tabs side by side in one named tab group of the tab strip that every window shares, add later tabs presented under the same name to that group, and let the person collapse the group, close it with its tabs, and move a tab into, out of, or within a group, or a whole group, by dragging or with the keyboard.

Rationale: An agent working on one initiative or task opens several tabs over a session, and among the person's own tabs they read as unrelated, which Michael reported on 10 November 2026 and answered by letting agents name the group.

Related: [review-app-ui-kit.md§2](#2), [single-review-app.md§1](single-review-app.md#1)
