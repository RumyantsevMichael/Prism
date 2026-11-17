import assert from "node:assert/strict";
import test from "node:test";
import { withoutCredentials } from "../../src/server/workflow/remote-url.mjs";

// A Git error names the remote it failed on, and every part of that URL that can carry a token stays out of the message.
test("a Git error loses the query string and fragment of a remote URL", () => {
  const message = "fatal: unable to access 'https://github.com/acme/store.git?access_token=secret/': The requested URL returned error: 403";
  assert.equal(withoutCredentials(message), "fatal: unable to access 'https://github.com/acme/store.git': The requested URL returned error: 403");
  assert.equal(withoutCredentials("fatal: repository 'https://host.example/store#token=secret' not found"), "fatal: repository 'https://host.example/store' not found");
  assert.equal(withoutCredentials("remote https://host.example/store?a=1#b=2 failed"), "remote https://host.example/store failed");
});

test("a Git error loses the whole user information of a remote URL", () => {
  assert.equal(withoutCredentials("fatal: could not read from https://user:token@github.com/acme/store.git"), "fatal: could not read from https://github.com/acme/store.git");
  // A password may itself hold an '@', so the user information runs to the last '@' before the path.
  assert.equal(withoutCredentials("fatal: could not read from https://user:p@ss@github.com/acme/store.git"), "fatal: could not read from https://github.com/acme/store.git");
  assert.equal(withoutCredentials("fatal: https://user:tok?en@github.com/acme/store.git?access_token=secret"), "fatal: https://github.com/acme/store.git");
});

test("a Git error keeps every URL without a credential and the text around it as they are", () => {
  const message = "fatal: unable to access 'https://github.com/acme/store.git/': Could not resolve host, see file:///tmp/store and ssh://git@github.com/acme/store.git.";
  assert.equal(withoutCredentials(message), message.replace("ssh://git@", "ssh://"));
  assert.equal(withoutCredentials("no url here"), "no url here");
  assert.equal(withoutCredentials(undefined), undefined);
});
