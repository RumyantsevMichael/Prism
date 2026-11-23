import assert from "node:assert/strict";
import test from "node:test";
import { claudePrompt, codexTurnRequest } from "../../dist/server/session/launch-hosts.mjs";

// Only the first run of a resumed asker tells it that its gate has an answer; a later run gets the start of any other resume.

const initiativeAsker = { gate: "gate-0123abcd", initiative: "late-answers", artifact: null };
const artifactAsker = { gate: "approval-0123abcd", initiative: null, artifact: "docs/requirements/x.md" };
const answered = "Prism: the person answered your question gate-0123abcd of the initiative late-answers in the review app. Read the answer from Prism's records and continue.";

test("the first run of a resumed asker names its answered gate", () => {
  assert.equal(claudePrompt("late-answers", null, initiativeAsker).message.content, answered);
  assert.equal(codexTurnRequest({ threadId: "t", initiative: "late-answers", asker: initiativeAsker }).params.input[0].text, answered);
});

test("a later run of a resumed asker of an initiative gets the orchestrate start", () => {
  assert.equal(claudePrompt("late-answers", null, initiativeAsker, false).message.content, "/prism:orchestrate late-answers");
  assert.equal(codexTurnRequest({ threadId: "t", initiative: "late-answers", asker: initiativeAsker, askerAnswered: false }).params.input[0].text, "$prism:orchestrate late-answers");
});

test("a later run of a resumed asker of an approval gate without an initiative continues its artifact", () => {
  for (const text of [claudePrompt(null, null, artifactAsker, false).message.content, codexTurnRequest({ threadId: "t", initiative: null, asker: artifactAsker, askerAnswered: false }).params.input[0].text]) {
    assert.equal(text, "Prism: continue your work on docs/requirements/x.md.");
    assert.doesNotMatch(text, /answered/);
  }
});
