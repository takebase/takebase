import { env, exports } from "cloudflare:workers";

// Unsigned tokens in the Auth emulator's format. The global test Worker trusts
// them only because its test bindings enable local-only emulator trust for the
// demo-takebase project; production verification is covered in packages/core.
// `authTime` (Unix seconds) is when the user signed in; it defaults to now.
export const emulatorToken = (subject: string, authTime?: number) => {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
	const seconds = Math.floor(Date.now() / 1000);
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({
		iss: "https://securetoken.google.com/demo-takebase",
		aud: "demo-takebase",
		iat: seconds,
		auth_time: authTime ?? seconds,
		exp: seconds + 3600,
		sub: subject,
	})}.`;
};

const timestamp = () => new Date().toISOString();

export const addTenant = (id: string, status = "active") =>
	env.DB.prepare("insert into tenants (id, name, url, status, created, updated) values (?, ?, ?, ?, ?, ?)")
		.bind(id, `Tenant ${id}`, `https://${id}.example.test`, status, timestamp(), timestamp())
		.run();

// Declares the role first: global D1 refuses a membership with an undeclared role.
export const addMember = (tenantId: string, subject: string, role: string) =>
	env.DB.batch([
		env.DB.prepare("insert or ignore into tenant_roles (tenant_id, name, created) values (?, ?, ?)").bind(
			tenantId,
			role,
			timestamp(),
		),
		env.DB.prepare(
			"insert into memberships (id, tenant_id, provider, subject, role, created, updated) values (?, ?, 'firebase', ?, ?, ?, ?)",
		).bind(crypto.randomUUID(), tenantId, subject, role, timestamp(), timestamp()),
	]);

export const listTenants = (token?: string) =>
	exports.default.fetch("https://global.local/api/tenants", {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
