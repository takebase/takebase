import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { queryD1 } from "../packages/cli/src/services/environment.ts";
import {
	databaseUrl,
	environment,
	globalUrl,
	hasPassword,
	passwordFile,
	project,
	recordPrefix,
	type Session,
	signIn,
	tenant,
	tenantUrl,
	type UserName,
	users,
} from "./production.ts";

// The production smoke (SEGU-231), run from the repository root:
//
//   pnpm production:fixtures   the synthetic users and their roles (safe to rerun)
//   pnpm production:journey    protected CRUD → RTDB signal → refetch, and refusals
//   pnpm production:cleanup    removes the PRD-* records (the rules deny delete)
//
// Only the synthetic tenant is touched. Tenant, users and outbox metadata stay.

const root = new URL("../", import.meta.url).pathname;

const takebase = (...args: string[]) =>
	execFileSync("pnpm", ["exec", "takebase", ...args, "--env", environment.name], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});

const fixtures = async () => {
	mkdirSync(`${root}ops/.production`, { recursive: true, mode: 0o700 });
	const names = Object.keys(users) as UserName[];
	for (const name of names) {
		if (hasPassword(name)) continue;
		takebase("user", "create", "--email", users[name].email, "--password-file", passwordFile(name));
		console.log(`created ${name}`);
	}
	for (const role of ["agent", "member"]) {
		const declared = takebase("role", "list", tenant.id);
		if (!new RegExp(`^\\s*${role}\\b`, "m").test(declared)) takebase("role", "create", tenant.id, role);
	}
	for (const name of names) {
		const { uid } = await signIn(name);
		for (const role of users[name].roles) {
			const members = takebase("tenant", "user", "list", tenant.id).split("\n");
			if (!members.some((line) => line.includes(uid) && line.includes(role))) {
				takebase("tenant", "user", "add", tenant.id, uid, "--role", role);
			}
		}
		console.log(`ready   ${name}: ${users[name].roles.join(", ") || "no roles"}`);
	}
};

const call = async (url: string, token: string | null, method = "GET", body?: unknown) => {
	const response = await fetch(url, {
		method,
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: response.status, json };
};

const waitFor = async (probe: () => Promise<boolean>, ms = 20_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await probe()) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
};

const journey = async () => {
	let failures = 0;
	const expect = (label: string, ok: boolean, detail: string) => {
		if (!ok) failures++;
		console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
	};
	const agent = await signIn("agent");
	const member = await signIn("member");
	const outsider = await signIn("outsider");
	const records = `${tenantUrl}/api/collections/policies/records`;
	const revision = async ({ token }: Session) => {
		const { json } = await call(`${databaseUrl}/collections/policies.json?auth=${token}`, null);
		const value = (json as { revision?: unknown } | null)?.revision;
		return typeof value === "number" ? value : 0;
	};
	const signalled = async (before: number) => {
		let after = before;
		const moved = await waitFor(async () => {
			after = await revision(agent);
			return after > before;
		});
		return { moved, detail: `${before} → ${after}` };
	};

	console.log("-- identity and discovery");
	const discovered = await call(`${globalUrl}/api/tenants`, agent.token);
	const ids = (discovered.json as { tenants?: { tenant?: { id?: string } }[] } | null)?.tenants?.map(
		(each) => each.tenant?.id,
	);
	expect("the agent discovers the tenant", ids?.join() === tenant.id, `${discovered.status} ${ids?.join()}`);
	const none = await call(`${globalUrl}/api/tenants`, outsider.token);
	const noneIds = (none.json as { tenants?: unknown[] } | null)?.tenants;
	expect("the outsider discovers no tenant", noneIds?.length === 0, `${none.status} ${noneIds?.length}`);
	const [header, payload, signature = ""] = agent.token.split(".");
	const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
	const tampered = await call(`${globalUrl}/api/tenants`, `${header}.${payload}.${flipped}`);
	expect("a tampered token is refused", tampered.status === 401, String(tampered.status));

	console.log("-- protected CRUD, realtime signal, refetch");
	const session = await call(`${tenantUrl}/api/realtime/session`, agent.token, "POST");
	const connection = (session.json as { connection?: { databaseURL?: string } } | null)?.connection;
	expect(
		"the agent opens a realtime session on the tenant's database",
		session.status === 200 && connection?.databaseURL === databaseUrl,
		`${session.status} ${connection?.databaseURL}`,
	);
	const granted = await waitFor(
		async () => (await call(`${databaseUrl}/access/members/${agent.uid}.json?auth=${agent.token}`, null)).json !== null,
	);
	expect("the Worker wrote the grant to RTDB", granted, granted ? "present" : "missing");

	const number = `${recordPrefix}${Date.now().toString(36).toUpperCase()}`;
	const beforeCreate = await revision(agent);
	const created = await call(records, agent.token, "POST", { number, holder: "Production Smoke", status: "pending" });
	expect("the agent creates a record", created.status === 201, String(created.status));
	const createSignal = await signalled(beforeCreate);
	expect("the create signals RTDB", createSignal.moved, createSignal.detail);
	const list = await call(`${records}?perPage=100&sort=-created`, agent.token);
	expect(
		"the refetch returns the record",
		list.status === 200 && JSON.stringify(list.json).includes(number),
		String(list.status),
	);

	const id = (created.json as { id?: string } | null)?.id ?? "missing";
	const beforeUpdate = await revision(agent);
	const updated = await call(`${records}/${id}`, member.token, "PATCH", { status: "active" });
	expect("a member updates the record", updated.status === 200, String(updated.status));
	const updateSignal = await signalled(beforeUpdate);
	expect("the update signals RTDB", updateSignal.moved, updateSignal.detail);
	const viewed = await call(`${records}/${id}`, agent.token);
	expect(
		"the refetch returns the update",
		(viewed.json as { status?: string } | null)?.status === "active",
		String(viewed.status),
	);

	console.log("-- refusals");
	const memberCreate = await call(records, member.token, "POST", {
		number: `${number}-M`,
		holder: "Plain Member",
		status: "pending",
	});
	expect("a member cannot create", memberCreate.status === 403, String(memberCreate.status));
	const deleted = await call(`${records}/${id}`, agent.token, "DELETE");
	expect("delete is denied by the rules", deleted.status === 403, String(deleted.status));
	const outsiderList = await call(records, outsider.token);
	expect("the outsider is refused by the tenant", outsiderList.status === 403, String(outsiderList.status));
	const outsiderSignals = await call(`${databaseUrl}/collections.json?auth=${outsider.token}`, null);
	expect("the outsider cannot read RTDB", outsiderSignals.status === 401, String(outsiderSignals.status));
	const anonymous = await call(records, null);
	expect("an anonymous request is refused", anonymous.status === 401, String(anonymous.status));

	console.log(failures === 0 ? "All production journey checks passed." : `${failures} check(s) failed.`);
	process.exitCode = failures === 0 ? 0 : 1;
};

const cleanup = () => {
	const sql = (statement: string) => queryD1(project.workers.tenant, tenant.env, environment, statement);
	// Removing the benchmark's records once failed with a transient API error (7403).
	for (let attempt = 1; ; attempt++) {
		try {
			sql(`delete from policies where number like '${recordPrefix}%'`);
			break;
		} catch (error) {
			if (attempt === 3) throw error;
		}
	}
	const [row] = sql(`select count(*) as count from policies where number like '${recordPrefix}%'`);
	const left = Number(row?.count);
	console.log(`${left === 0 ? "ok  " : "FAIL"} smoke records left on ${tenant.id}: ${left}`);
	process.exitCode = left === 0 ? 0 : 1;
};

const [command] = process.argv.slice(2);
if (command === "fixtures") await fixtures();
else if (command === "journey") await journey();
else if (command === "cleanup") cleanup();
else {
	console.error("usage: node ops/production-smoke.ts fixtures | journey | cleanup");
	process.exitCode = 2;
}
