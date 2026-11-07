import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §5, §6, §8, §13.
// The design values file is read as shipped and compared with the proposed values of the design.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KIT = path.join(ROOT, "src/server/review/public/kit");
const PROPOSED = path.join(ROOT, "docs/plans/review-app-ui-kit/mockup/tokens.css");

// Parses top-level rules and rules inside @media into { selector, media, declarations }, and @font-face blocks into faces.
function parse(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  const faces = [];
  const block = (body, media) => {
    let index = 0;
    while (index < body.length) {
      const open = body.indexOf("{", index);
      if (open < 0) break;
      const head = body.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      while (depth && close < body.length) {
        if (body[close] === "{") depth += 1;
        if (body[close] === "}") depth -= 1;
        close += 1;
      }
      const inner = body.slice(open + 1, close - 1);
      if (head.startsWith("@media")) block(inner, head.slice(6).trim());
      else {
        const declarations = {};
        for (const part of inner.split(";")) {
          const colon = part.indexOf(":");
          if (colon > 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
        }
        if (head === "@font-face") faces.push(declarations);
        else rules.push({ selector: head.split(",").map((item) => item.trim()).join(", "), media: media ?? null, declarations });
      }
      index = close;
    }
  };
  block(source);
  return { rules, faces };
}

async function tokens() {
  return parse(await readFile(path.join(KIT, "tokens.css"), "utf8"));
}

const ruleOf = (parsed, selector, media = null) => parsed.rules.find((rule) => rule.selector === selector && rule.media === media);

function themeColors(parsed, theme) {
  const rule = ruleOf(parsed, theme === "light" ? ':root, [data-theme="light"]' : '[data-theme="dark"]');
  assert.ok(rule, `tokens.css has no rule for the ${theme} theme`);
  const colors = {};
  for (const [name, value] of Object.entries(rule.declarations)) {
    if (name.startsWith("--prism-color-")) colors[name.slice("--prism-color-".length)] = value;
  }
  return colors;
}

const luminance = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("tokens.css declares every proposed design value under the same selector", async () => {
  const proposed = parse(await readFile(PROPOSED, "utf8"));
  const shipped = await tokens();
  for (const rule of proposed.rules) {
    const match = ruleOf(shipped, rule.selector, rule.media);
    assert.ok(match, `tokens.css has no rule ${rule.media ? `@media ${rule.media} ` : ""}${rule.selector}`);
    for (const name of Object.keys(rule.declarations).filter((key) => key.startsWith("--"))) {
      assert.ok(Object.hasOwn(match.declarations, name), `${rule.selector} in tokens.css does not declare ${name}`);
    }
  }
});

test("compact sizes sit on the root and the themes and comfortable density sit on attribute selectors", async () => {
  const parsed = await tokens();
  const root = ruleOf(parsed, ":root");
  assert.ok(root, "tokens.css has no :root rule");
  assert.equal(root.declarations["--prism-control-height"], "24px");
  assert.equal(root.declarations["--prism-row-height"], "22px");
  assert.equal(root.declarations["--prism-font-size-md"], "13px");
  const comfortable = ruleOf(parsed, '[data-density="comfortable"]');
  assert.ok(comfortable, 'tokens.css has no [data-density="comfortable"] rule');
  assert.equal(comfortable.declarations["--prism-control-height"], "30px");
  assert.equal(comfortable.declarations["--prism-row-height"], "28px");
  assert.equal(comfortable.declarations["--prism-font-size-md"], "14px");
  const steps = Object.keys(root.declarations).filter((name) => /^--prism-space-\d+$/.test(name));
  assert.ok(steps.length >= 6, "the root declares at least six spacing steps");
  for (const step of steps) {
    assert.ok(parseFloat(comfortable.declarations[step]) > parseFloat(root.declarations[step]), `comfortable density raises ${step}`);
  }
  for (const theme of ["light", "dark"]) {
    const colors = themeColors(parsed, theme);
    for (const [name, value] of Object.entries(colors)) {
      if (["ink", "ink-muted", "accent-text", "bg", "chrome", "surface", "sunken", "raised", "hover", "selected", "line-control", "focus", "accent", "on-accent"].includes(name) || /-soft$|^syntax-|^(danger|warning|success|info)$/.test(name)) {
        assert.match(value, /^#[0-9a-f]{6}$/i, `--prism-color-${name} in the ${theme} theme is a six-digit hex color`);
      }
    }
  }
});

test("every text and boundary pair reaches the WCAG AA contrast in both themes", async () => {
  const parsed = await tokens();
  const surfaces = ["bg", "chrome", "surface", "sunken", "raised", "hover", "selected"];
  const failures = [];
  for (const theme of ["light", "dark"]) {
    const colors = themeColors(parsed, theme);
    const check = (foreground, background, minimum) => {
      assert.ok(colors[foreground], `the ${theme} theme declares --prism-color-${foreground}`);
      assert.ok(colors[background], `the ${theme} theme declares --prism-color-${background}`);
      const value = contrast(colors[foreground], colors[background]);
      if (value < minimum) failures.push(`${theme}: ${foreground} on ${background} is ${value.toFixed(2)}:1, under ${minimum}:1`);
    };
    for (const surface of surfaces) {
      for (const text of ["ink", "ink-muted", "accent-text"]) check(text, surface, 4.5);
      for (const boundary of ["line-control", "focus"]) check(boundary, surface, 3);
    }
    for (const tone of ["danger", "warning", "success", "info"]) {
      for (const surface of ["surface", "raised", "sunken", `${tone}-soft`]) check(tone, surface, 4.5);
    }
    for (const soft of Object.keys(colors).filter((name) => name.endsWith("-soft"))) check("ink", soft, 4.5);
    check("accent-text", "accent-soft", 4.5);
    check("on-accent", "accent", 4.5);
    for (const diff of ["diff-added", "diff-removed"]) {
      for (const surface of ["surface", `${diff}-soft`]) check(diff, surface, 4.5);
    }
    const syntax = Object.keys(colors).filter((name) => name.startsWith("syntax-"));
    assert.ok(syntax.length >= 13, `the ${theme} theme declares the syntax colors`);
    for (const name of syntax) {
      for (const surface of ["surface", "sunken"]) check(name, surface, 4.5);
    }
  }
  assert.deepEqual(failures, []);
});

test("each shipped theme is one complete value set for the same semantic tokens, declared nowhere else", async () => {
  const parsed = await tokens();
  const semantic = (rule) => Object.keys(rule.declarations).filter((name) => /^--prism-(color|shadow)-/.test(name)).sort();
  const light = ruleOf(parsed, ':root, [data-theme="light"]');
  const dark = ruleOf(parsed, '[data-theme="dark"]');
  assert.ok(light && dark, "both shipped themes have a rule");
  assert.ok(semantic(light).length >= 40, "the light theme gives the semantic tokens");
  assert.deepEqual(semantic(dark), semantic(light), "the dark theme gives exactly the light theme's semantic tokens");
  for (const name of ["--prism-color-brand", "--prism-color-diagram-paper", "--prism-color-diff-added", "--prism-color-diff-removed", "--prism-color-syntax-keyword", "--prism-color-danger", "--prism-shadow-popup"]) {
    assert.ok(semantic(light).includes(name), `a theme gives ${name}`);
  }
  for (const rule of parsed.rules) {
    if (rule === light || rule === dark) continue;
    assert.deepEqual(semantic(rule), [], `${rule.selector} declares no semantic token, since only a theme rule does`);
  }
});

test("reduced motion sets every motion duration to zero", async () => {
  const parsed = await tokens();
  const root = ruleOf(parsed, ":root");
  const durations = Object.keys(root.declarations).filter((name) => name.startsWith("--prism-duration-"));
  assert.ok(durations.length >= 3, "the root declares motion durations");
  const reduced = parsed.rules.find((rule) => rule.media?.replace(/\s+/g, " ") === "(prefers-reduced-motion: reduce)" && rule.selector === ":root");
  assert.ok(reduced, "tokens.css has a :root rule for reduced motion");
  for (const name of durations) assert.equal(reduced.declarations[name], "0ms", `${name} is 0ms under reduced motion`);
});

test("the interface and code fonts ship beside the design values", async () => {
  const parsed = await tokens();
  const root = ruleOf(parsed, ":root");
  assert.match(root.declarations["--prism-font-ui"], /^"Prism UI",/);
  assert.match(root.declarations["--prism-font-code"], /^"Prism Code",/);
  for (const family of ["Prism UI", "Prism Code"]) {
    const faces = parsed.faces.filter((face) => face["font-family"]?.replace(/["']/g, "") === family);
    assert.ok(faces.length, `tokens.css declares @font-face ${family}`);
    for (const face of faces) {
      const urls = [...face.src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
      assert.ok(urls.length, `${family} names a source`);
      for (const url of urls) {
        assert.doesNotMatch(url, /^(?:[a-z]+:)?\/\//i, `${family} loads ${url} from the review app`);
        assert.match(url, /\.woff2$/, `${family} loads a WOFF2 file`);
        await access(path.join(KIT, url));
        assert.equal((await readFile(path.join(KIT, url))).subarray(0, 4).toString("latin1"), "wOF2", `${url} is a WOFF2 file`);
      }
    }
  }
  for (const license of ["OFL-Inter.txt", "OFL-JetBrains-Mono.txt"]) {
    assert.match(await readFile(path.join(KIT, "fonts", license), "utf8"), /SIL OPEN FONT LICENSE/i, `kit/fonts/${license} holds the license text`);
  }
});

test("the build copies the kit to dist unchanged", async () => {
  for (const file of ["tokens.css", "kit.css", "kit.js", "boot.js"]) {
    assert.equal(await readFile(path.join(ROOT, "dist/server/review/public/kit", file), "utf8"), await readFile(path.join(KIT, file), "utf8"), `dist holds kit/${file} as in src`);
  }
});
