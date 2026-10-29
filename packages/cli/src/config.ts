// Every planned command group, in roadmap order. Help output and the README
// roadmap both come from this list, so unsupported commands are never implied.

export type CommandStatus = "implemented" | "planned";

export type CommandGroup = {
	name: string;
	summary: string;
	status: CommandStatus;
};

export const commandGroups: readonly CommandGroup[] = [
	{ name: "init", summary: "Generate a project starter in an existing or new directory", status: "implemented" },
	{ name: "create", summary: "Generate a project starter in a new directory", status: "implemented" },
	{ name: "dev", summary: "Run the application locally", status: "implemented" },
	{ name: "build", summary: "Build Workers and the frontend", status: "implemented" },
	{ name: "deploy", summary: "Deploy the global Worker, tenant Workers and the app", status: "implemented" },
	{ name: "doctor", summary: "Validate environment and configuration", status: "implemented" },
	{ name: "user", summary: "Create, list, disable, enable, delete users; revoke sessions", status: "implemented" },
	{
		name: "tenant",
		summary: "Create, list, provision, disable, delete tenants; manage members",
		status: "implemented",
	},
	{ name: "role", summary: "Manage tenant roles", status: "implemented" },
	{ name: "invite", summary: "Manage tenant invitations", status: "implemented" },
	{ name: "collection", summary: "Generate and inspect collections", status: "implemented" },
	{ name: "migrate", summary: "Generate, inspect and apply local D1 migrations", status: "implemented" },
	{ name: "wire", summary: "Test notifications and retry failed deliveries", status: "implemented" },
	{ name: "secrets", summary: "Initialize, check and inspect encrypted tenant secrets", status: "implemented" },
	{ name: "backup", summary: "Create, list and verify backups (restore and prune are planned)", status: "implemented" },
	{ name: "logs", summary: "Inspect request and error logs", status: "implemented" },
	{ name: "health", summary: "Check Worker and database health", status: "implemented" },
];

export const findCommandGroup = (name: string) => commandGroups.find((group) => group.name === name);

// Package and Worker name: lowercase letters, digits and hyphens, as Cloudflare requires.
export const projectNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
