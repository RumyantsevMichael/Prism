import assert from "node:assert/strict";
import test from "node:test";
import { addressWithoutCredentials, isRemoteStore, storeIdentity } from "../../src/server/workflow/remote-url.mjs";

// Taking a credential out of a store address never turns it into another store.
test("a token URL loses only its user information and names the same store", async () => {
  const value = "https://x-access-token:secret@github.com/acme/store.git";
  const address = addressWithoutCredentials(value);
  assert.equal(address, "https://github.com/acme/store.git");
  assert.equal(await storeIdentity(address), await storeIdentity(value));
});

test("an scp-form value whose user information holds a second '@' is dropped, not turned into another remote", () => {
  assert.equal(addressWithoutCredentials("u:p@a@github.com:x"), null);
});

test("a user information spelling inside a URL's path stays in the path", async () => {
  const value = "https://h.com/a/https://u@b/c?x";
  const address = addressWithoutCredentials(value);
  assert.equal(address, "https://h.com/a/https://u@b/c");
  assert.equal(isRemoteStore(address), true);
  assert.equal(await storeIdentity(address), await storeIdentity(value));
});
