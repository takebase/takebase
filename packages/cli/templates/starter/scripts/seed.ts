import { spawnSync } from "node:child_process";

// Run by `pnpm dev` once the tenants are provisioned. The Auth emulator forgets
// its users on every start, so the demo user is created again each time. Local
// emulators only: this address and password exist nowhere else.

const email = "demo@example.test";
const localOnly = "local-only-password";

const takebase = (...args: string[]) => {
	const result = spawnSync("node_modules/.bin/takebase", args, { encoding: "utf8" });
	return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
};

const response = await fetch(
	`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password: localOnly, returnSecureToken: false }),
	},
);
if (!response.ok) throw new Error(`The Auth emulator did not create ${email}: ${await response.text()}`);
const { localId } = (await response.json()) as { localId: string };

// Already declared on any start after the first.
takebase("role", "create", "demo", "editor");
const added = takebase("tenant", "user", "add", "demo", localId, "--role", "editor");
if (!added.ok) throw new Error(added.output);
console.log(`Sign in as ${email} with password ${localOnly}.`);
