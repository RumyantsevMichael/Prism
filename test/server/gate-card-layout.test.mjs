import assert from "node:assert/strict";
import test from "node:test";

// A gate's card puts what happened first and lists its documents once, records before documents before code, and the answer panel says who asked and who receives the answer.

const { gateDetail } = await import("../../dist/server/review/public/views/attention.js");
const ctx = { renderMarkdown: null, hasArtifact: () => true };
const initiative = { id: "reports", title: "Export reports" };
const slice = { slug: "sign", title: "Sign exported reports" };
const asker = { known: true, harness: "Claude Code", machine: "vm", checkout: "api/main", state: "unknown", cloud: true };
const file = (path, record) => ({ path, available: true, ...(record ? { record } : {}) });
const gate = (kind, extra = {}) => ({ type: "gate", id: `gate-${kind}`, kind, question: `A ${kind} question?`, context: "What happened first.", askedAt: "2026-11-24T00:00:00.000Z", initiative, slice, phase: { status: "in-progress", designed: false }, artifacts: [], asker, ...extra });

test("the phase gate tag shows on review gates only, and no gate repeats it as a lifecycle", () => {
  for (const kind of ["visual-review", "correctness"]) { const card = gateDetail(gate(kind), ctx); assert.match(card, /<div class="gate-chips"><prism-chip>[^]*?<\/prism-chip><prism-phase variant="tag"/, `${kind} names its kind, then its phase gate`); assert.doesNotMatch(card, /prism-stepper/, `${kind} shows no lifecycle`); }
  for (const kind of ["decision", "assistance"]) {
    const card = gateDetail(gate(kind, { options: [{ id: "a", label: "A", consequence: "A happens." }, { id: "b", label: "B", consequence: "B happens." }], recommended: { option: "a", reason: "Because." } }), ctx);
    assert.doesNotMatch(card, /variant="tag"|prism-stepper/, `${kind} shows no phase gate`);
    assert.match(card, /<prism-phase slot="kind" phase="design">Design<\/prism-phase>/, `${kind} shows the slice phase in its work row`);
    assert.match(card, /class="prism-rows gate-work"[^]*Sign exported reports[^]*Slice of [^]*Export reports/, `${kind} names its work as a row under the question`);
  }
});

test("a gate of an initiative without a slice names the initiative alone", () => {
  const card = gateDetail(gate("assistance", { slice: null }), ctx);
  assert.match(card, /<prism-row wrap icon="roadmap"[^>]*>[^]*Export reports[^]*<span slot="description">Initiative<\/span>/);
});

test("a gate without documents leaves the Documents list out", () => {
  assert.doesNotMatch(gateDetail(gate("visual-review"), ctx), /Documents ·/);
});

test("documents list records, then documents, then code, the first five shown and the rest behind a disclosure, each with a side-panel button", () => {
  const artifacts = [
    file("src/export/sign.ts"),
    file("docs/notes.md"),
    file("docs/adrs/signing.md", { kind: "decision", title: "Sign reports", status: "Proposed" }),
    file("src/export/keys.ts"),
    file("docs/plans/reports/sign/slice.md", { kind: "design", title: "Sign exported reports", clauses: 3, frozenTests: 1 }),
    file("src/export/verify.ts"),
    { path: "src/export/gone.ts", available: false }
  ];
  const card = gateDetail(gate("visual-review", { artifacts }), ctx);
  assert.match(card, /Documents · 7/);
  const [shown, more] = card.split("<prism-disclosure");
  assert.ok(more, "the rest sit behind a disclosure");
  assert.match(more, /2 more/);
  const order = [...shown.matchAll(/data-side-artifact="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order.slice(0, 2), ["docs/plans/reports/sign/slice.md", "docs/adrs/signing.md"], "records come first");
  assert.equal(order.indexOf("docs/notes.md"), 2, "a document comes before code");
  assert.match(card, /label="Open Sign reports in the side panel"/);
  assert.match(card, /Not found/, "a missing file says so");
  assert.equal(card.split('data-side-artifact="src/export/gone.ts"').length, 1, "a missing file offers no side-panel button");
  assert.doesNotMatch(card, /gate-evidence|inspect-tile/, "no stat tiles repeat the counts");
});

test("an approval names its document once, as a row with its title and kind", () => {
  const card = gateDetail({ ...gate("approval"), artifact: { path: "docs/requirements/billing.md", scope: "payments", kind: "requirements", title: "Billing" } }, ctx);
  assert.match(card, /Billing/);
  assert.match(card, /Requirements · /);
  assert.equal(card.split('<span data-code-subject>docs/requirements/billing.md</span>').length - 1, 1, "the path shows once as text");
  assert.doesNotMatch(card, /<dt>File<\/dt>/, "no File row repeats it");
  assert.match(card, /data-side-artifact="docs\/requirements\/billing.md"/);
});

test("an approval names the work it serves under its question, as other gates do", () => {
  const workItem = { initiative: { id: "reports", title: "Export reports", known: true }, slice: { slug: "sign", title: "Sign exported reports", known: true } };
  const card = gateDetail({ ...gate("approval"), workItem, artifact: { path: "docs/requirements/billing.md", scope: "payments", kind: "requirements", title: "Billing" } }, ctx);
  const head = card.slice(0, card.indexOf("</header>"));
  assert.match(head, /class="prism-rows gate-work approval-work"[^]*Sign exported reports[^]*Slice of [^]*Export reports/, "the work sits under the question as a row");
  assert.doesNotMatch(card, /Asked for/, "no metadata row repeats it");
});

test("the answer panel says who asked with a warning icon whose tooltip explains, and the Send button shows who receives the answer", () => {
  const card = gateDetail(gate("visual-review"), ctx);
  const panel = card.slice(card.indexOf('class="gate-answer"'));
  assert.match(panel, /aria-label="Asked by"/);
  assert.match(panel, /<strong>Claude Code on vm<\/strong><prism-icon class="gate-asker-state" name="warning"[^>]*label="Prism can&#39;t see this session|<strong>Claude Code on vm<\/strong><prism-icon class="gate-asker-state" name="warning"[^>]*label="Prism can't see this session/);
  assert.match(panel, /tip="Prism can(&#39;|')t see this session\. It runs in the cloud/);
  assert.doesNotMatch(card, /Prism cannot tell/);
});
