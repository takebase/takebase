import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { databaseRules } from "../packages/adapter-firebase/src/rules.ts";
import {
	databaseUrl,
	dispatcherEmail,
	ensureUser,
	opsPath,
	password,
	projectId,
	type Session,
	signIn,
	type Tenant,
	tenants,
	type UserName,
	users,
} from "./staging.ts";

// Firebase side of staging (SEGU-218 Section B), run from the repository root:
//
//   node ops/staging-firebase.ts setup   users plus rendered rules in ops/.staging/
//   pnpm staging:firebase:rules          deploys those rules (firebase deploy --config)
//   node ops/staging-firebase.ts check   proves the rules and the dispatcher work
//
// The check writes as the dispatcher over plain REST with the adapter's layout.
// The adapter itself (from @takebase/firebase-rtdb, which ships TypeScript that
// Node will not strip inside node_modules) is proven against these databases by
// the tenant Worker in Section C.
//
// Both commands can be run again safely. The rules and their firebase.json live in
// the untracked ops/.staging/ directory, so the root firebase.json keeps
// configuring the emulators only.

const stagingDir = opsPath(".staging");

const setup = async () => {
	for (const [name, { email }] of Object.entries(users)) {
		const { uid, created } = await ensureUser(email, password(name));
		console.log(`${created ? "created" : "exists "} ${name} ${email} ${uid}`);
	}
	mkdirSync(stagingDir, { recursive: true });
	const database: { instance: string; rules: string }[] = [];
	for (const tenant of tenants) {
		const { uid, created } = await ensureUser(dispatcherEmail(tenant), password(`dispatcher-${tenant.id}`));
		console.log(`${created ? "created" : "exists "} dispatcher ${tenant.id} ${uid}`);
		const rules = `database.rules.${tenant.id}.json`;
		writeFileSync(`${stagingDir}/${rules}`, `${JSON.stringify(databaseRules(uid), null, 2)}\n`);
		database.push({ instance: tenant.instance, rules });
	}
	writeFileSync(`${stagingDir}/firebase.json`, `${JSON.stringify({ database }, null, 2)}\n`);
	console.log(`Rules rendered in ops/.staging/. Deploy them with: pnpm staging:firebase:rules`);
};

// One REST call as a signed-in user (or anonymously); returns the HTTP status.
const rest = async (tenant: Tenant, path: string, session: Session | null, method = "GET", body?: unknown) => {
	const auth = session ? `?auth=${session.token}` : "";
	const response = await fetch(`${databaseUrl(tenant)}/${path}.json${auth}`, {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	await response.body?.cancel();
	return response.status;
};

let failures = 0;
const expectStatus = (label: string, actual: number, expected: number) => {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
};

const user = (name: UserName) => signIn(users[name].email, password(name));

const check = async () => {
	const alice = await user("alice");
	const probe = await user("probe");
	for (const tenant of tenants) {
		console.log(`-- ${tenant.id} (${databaseUrl(tenant)})`);
		const dispatcher = await signIn(dispatcherEmail(tenant), password(`dispatcher-${tenant.id}`));
		console.log(`ok   dispatcher ${tenant.id} signs in`);
		// The live rules, read back with the operator's Firebase CLI login.
		const live = execFileSync(
			"firebase",
			["database:get", "/.settings/rules", "--instance", tenant.instance, "--project", projectId],
			{ encoding: "utf8" },
		);
		const rendered = readFileSync(`${stagingDir}/database.rules.${tenant.id}.json`, "utf8");
		const same = JSON.stringify(JSON.parse(live)) === JSON.stringify(JSON.parse(rendered));
		if (!same) failures++;
		console.log(`${same ? "ok  " : "FAIL"} live rules equal ops/.staging/database.rules.${tenant.id}.json`);
		expectStatus("anonymous read of the root is denied", await rest(tenant, "", null), 401);
		expectStatus("anonymous read of collections is denied", await rest(tenant, "collections", null), 401);

		const publish = await rest(tenant, "collections/_smoke", dispatcher, "PUT", { revision: Date.now() });
		expectStatus("dispatcher publishes a revision", publish, 200);
		const other = tenants.find(({ id }) => id !== tenant.id) ?? tenant;
		const outsider = await signIn(dispatcherEmail(other), password(`dispatcher-${other.id}`));
		expectStatus(
			`the ${other.id} dispatcher cannot publish here`,
			await rest(tenant, "collections/_smoke", outsider, "PUT", { revision: Date.now() + 5_000 }),
			401,
		);
		expectStatus("dispatcher reads collections", await rest(tenant, "collections", dispatcher), 200);

		expectStatus("a user without a grant cannot read collections", await rest(tenant, "collections", alice), 401);
		expectStatus(
			"a user cannot write a revision",
			await rest(tenant, "collections/_smoke", alice, "PUT", { revision: Date.now() + 1 }),
			401,
		);
		expectStatus(
			"a user cannot grant themself",
			await rest(tenant, `access/members/${alice.uid}`, alice, "PUT", { rev: 1 }),
			401,
		);

		// Grant cycle on the probe user only: granted reads, then revoked reads fail.
		const rev = Date.now();
		const grant = () => rest(tenant, `access/members/${probe.uid}`, dispatcher, "PUT", { rev });
		expectStatus("dispatcher grants the probe user", await grant(), 200);
		expectStatus("a granted user reads collections", await rest(tenant, "collections", probe), 200);
		expectStatus(
			"a granted user reads only their own grant",
			await rest(tenant, `access/members/${probe.uid}`, probe),
			200,
		);
		expectStatus("a granted user cannot read other grants", await rest(tenant, "access/members", probe), 401);
		const revoke = { [`members/${probe.uid}`]: null, [`revoked/${probe.uid}`]: rev };
		expectStatus("dispatcher revokes the probe user", await rest(tenant, "access", dispatcher, "PATCH", revoke), 200);
		expectStatus("a revoked user cannot read collections", await rest(tenant, "collections", probe), 401);
		expectStatus("a grant not newer than the revocation is rejected", await grant(), 401);
	}
	console.log(failures === 0 ? `All checks passed for ${projectId}.` : `${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
};

const command = process.argv[2];
if (command === "setup") await setup();
else if (command === "check") await check();
else {
	console.error("usage: node ops/staging-firebase.ts setup|check");
	process.exitCode = 2;
}
