import assert from "node:assert/strict";
import test from "node:test";
import { acpReasons } from "../../dist/server/session/host-adapters/acp.mjs";

// Requirements: docs/requirements/acp-agents.md §16.
// The sign-in reason names each method an agent answered, and keeps a method's description only when it says more than the name.

test("a description that restates its method's name is left out, and one that says more is kept", () => {
  const methods = [
    { id: "oauth", name: "Log in with Example", description: "Log in with your Example account" },
    { id: "key", name: "Example API key", description: "Use an API key with the Example API." },
    { id: "cloud", name: "Cloud", description: "Use an API key with Cloud GenAI" },
    { id: "gateway", name: "API Gateway", description: "Use a custom API Gateway" },
    { id: "bare", name: "Token" }
  ];
  assert.equal(acpReasons.signIn("Example agent", methods), "Example agent needs you to sign in before it can run: Log in with Example, Example API key, Cloud (Use an API key with Cloud GenAI), API Gateway, Token.");
});

test("an agent that names no method is told to sign in with its own command", () => {
  assert.equal(acpReasons.signIn("Example agent", []), "Example agent needs you to sign in before it can run: sign in with the agent's own command.");
});
