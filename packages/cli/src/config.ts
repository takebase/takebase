// Every command group, in the order help lists them.

export type CommandGroup = {
	name: string;
	summary: string;
};

export const commandGroups: readonly CommandGroup[] = [
	{ name: "init", summary: "Generate a project starter in an existing or new directory" },
	{ name: "create", summary: "Generate a project starter in a new directory" },
	{ name: "dev", summary: "Run the application locally" },
	{ name: "build", summary: "Build Workers and the frontend" },
	{ name: "deploy", summary: "Deploy the global Worker, tenant Workers and the app" },
	{ name: "doctor", summary: "Validate environment and configuration" },
	{ name: "user", summary: "Create, list, disable, enable, delete users; revoke sessions" },
	{
		name: "tenant",
		summary: "Create, list, provision, disable, delete tenants; manage members",
	},
	{ name: "role", summary: "Manage tenant roles" },
	{ name: "invite", summary: "Manage tenant invitations" },
	{ name: "collection", summary: "Generate and inspect collections" },
	{ name: "migrate", summary: "Generate, inspect and apply local D1 migrations" },
	{ name: "wire", summary: "Test notifications and retry failed deliveries" },
	{ name: "secrets", summary: "Initialize, check and inspect encrypted tenant secrets" },
	{ name: "backup", summary: "Create, list, verify, restore and prune backups" },
	{ name: "logs", summary: "Inspect request and error logs" },
	{ name: "health", summary: "Check Worker and database health" },
];

// Package and Worker name: lowercase letters, digits and hyphens, as Cloudflare requires.
export const projectNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
