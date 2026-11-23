import assert from "node:assert/strict";
import test from "node:test";
import { AUTHORIZED_LABEL, checkContribution, counted, linkedIssues, ownership, signedOff } from "./check-contribution.mjs";

const signed = (sha, email = "ada@example.com") => ({ sha, authorEmail: email, parents: 1, message: `fix: typo\n\nSigned-off-by: Ada Lovelace <${email}>` });
const own = "- [x] I own this contribution, and no employer or client can claim it.\n- [ ] My employer or a client may own this contribution.";
const employer = "- [ ] I own this contribution, and no employer or client can claim it.\n- [x] My employer or a client may own this contribution.";
const outside = (overrides = {}) => ({
  owner: "RumyantsevMichael",
  pull: { author: "ada", authorType: "User", title: "fix: correct a typo", body: own, labels: [], ...overrides.pull },
  commits: overrides.commits ?? [signed("aaaaaaa1")],
  files: overrides.files ?? [{ path: "README.md", additions: 2 }],
  issues: overrides.issues ?? []
});

test("the owner's and bots' pull requests are exempt", () => {
  assert.equal(checkContribution(outside({ pull: { author: "RumyantsevMichael", body: "" }, commits: [] })).exempt, true);
  assert.equal(checkContribution(outside({ pull: { author: "release-bot", authorType: "Bot", body: "" } })).exempt, true);
});

test("a signed-off typo fix by its owner passes", () => {
  assert.deepEqual(checkContribution(outside()).problems, []);
});

test("a sign-off must name the commit's author email, and merge commits need none", () => {
  assert.equal(signedOff({ authorEmail: "Ada@Example.com", message: "x\n\nSigned-off-by: Ada <ada@example.com>" }), true);
  assert.equal(signedOff({ authorEmail: "ada@example.com", message: "x\n\nSigned-off-by: Bob <bob@example.com>" }), false);
  const result = checkContribution(outside({ commits: [{ sha: "bbbbbbb2", authorEmail: "ada@example.com", parents: 1, message: "fix: typo" }, { sha: "ccccccc3", authorEmail: "ada@example.com", parents: 2, message: "Merge main" }] }));
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /bbbbbbb.*Signed-off-by/);
});

test("exactly one ownership box must be checked", () => {
  assert.deepEqual(ownership(own), ["own"]);
  assert.deepEqual(ownership("- [X] I am not sure who owns this contribution."), ["unsure"]);
  assert.match(checkContribution(outside({ pull: { body: "" } })).problems.join(), /Ownership/);
  assert.match(checkContribution(outside({ pull: { body: `${own}\n- [x] I am not sure who owns this contribution.` } })).problems.join(), /Ownership/);
});

test("a feature needs a linked proposal with the accepted label", () => {
  assert.match(checkContribution(outside({ pull: { title: "feat: new view", body: `${own}\nCloses #4` }, issues: [{ number: 4, labels: ["needs-design"] }] })).problems.join(), /accepted/);
  assert.deepEqual(checkContribution(outside({ pull: { title: "feat(review): new view", body: `${own}\nCloses #4` }, issues: [{ number: 4, labels: ["accepted"] }] })).problems, []);
});

test("issue links are read outside comments", () => {
  assert.deepEqual(linkedIssues("<!-- Closes #1 -->\nCloses #2\nrefs #3, fixes #2"), [2, 3]);
});

test("tests and generated files do not count toward the size", () => {
  assert.equal(counted("src/server/a.ts"), true);
  assert.equal(["test/server/a.test.mjs", "scripts/x.test.mjs", "package-lock.json", "dist/a.js"].some(counted), false);
});

test("a non-trivial change an employer may own needs the authorization label", () => {
  const big = { files: [{ path: "src/a.ts", additions: 21 }, { path: "test/a.test.mjs", additions: 300 }] };
  assert.deepEqual(checkContribution(outside({ ...big })).problems, []);
  assert.match(checkContribution(outside({ ...big, pull: { body: employer } })).problems.join(), new RegExp(AUTHORIZED_LABEL));
  assert.deepEqual(checkContribution(outside({ ...big, pull: { body: employer, labels: [AUTHORIZED_LABEL] } })).problems, []);
  assert.deepEqual(checkContribution(outside({ files: [{ path: "src/a.ts", additions: 20 }], pull: { body: employer } })).problems, []);
});

test("a feature an employer may own needs the authorization label at any size", () => {
  const result = checkContribution(outside({ pull: { title: "feat: tiny", body: `${employer}\nCloses #4` }, issues: [{ number: 4, labels: ["accepted"] }] }));
  assert.match(result.problems.join(), new RegExp(AUTHORIZED_LABEL));
});
