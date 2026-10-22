// Wave 1-1 bootstrap checks for the local Firebase Auth/RTDB emulator setup.
// Run inside the emulators (see firebase/README.md):
//   firebase emulators:exec --only auth,database --project demo-takebase 'node --test tests/firebase/bootstrap.test.ts'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const projectId = "demo-takebase";
const namespace = `${projectId}-default-rtdb`;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const databaseHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? "127.0.0.1:9000";

const databaseUrl = (path: string, idToken?: string) => {
  const url = new URL(`http://${databaseHost}/${path}.json`);
  url.searchParams.set("ns", namespace);
  if (idToken) url.searchParams.set("auth", idToken);
  return url;
};

const signUpAnonymous = async () => {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  assert.equal(response.status, 200, "auth emulator should issue an anonymous ID token");
  const body = (await response.json()) as { idToken: string };
  return body.idToken;
};

test("firebase.json configures only Auth/RTDB emulators and the rules file", () => {
  const config = readJson("firebase.json");
  assert.deepEqual(Object.keys(config).sort(), ["database", "emulators"]);
  assert.equal(config.database.rules, "database.rules.json");
  assert.deepEqual(Object.keys(config.emulators).sort(), ["auth", "database", "singleProjectMode", "ui"]);
  assert.equal(config.emulators.ui.enabled, false);
});

test(".firebaserc only aliases demo projects", () => {
  const aliases = Object.values(readJson(".firebaserc").projects) as string[];
  assert.ok(aliases.length > 0);
  for (const projectAlias of aliases) assert.match(projectAlias, /^demo-/);
});

test("database rules deny everything by default", () => {
  assert.deepEqual(readJson("database.rules.json"), { rules: { ".read": false, ".write": false } });
});

test("unauthenticated RTDB reads and writes are denied", async () => {
  const read = await fetch(databaseUrl(""));
  assert.equal(read.status, 401);
  const write = await fetch(databaseUrl("probe"), { method: "PUT", body: JSON.stringify({ ok: true }) });
  assert.equal(write.status, 401);
});

test("authenticated RTDB reads and writes are still denied until the authorization wave", async () => {
  const idToken = await signUpAnonymous();
  const read = await fetch(databaseUrl("", idToken));
  assert.equal(read.status, 401);
  const write = await fetch(databaseUrl("probe", idToken), { method: "PUT", body: JSON.stringify({ ok: true }) });
  assert.equal(write.status, 401);
});
