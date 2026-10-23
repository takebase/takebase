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
	{ name: "dev", summary: "Run the application locally", status: "planned" },
	{ name: "build", summary: "Build Workers and the frontend", status: "planned" },
	{ name: "deploy", summary: "Deploy global and tenant Workers", status: "planned" },
	{ name: "doctor", summary: "Validate environment and configuration", status: "planned" },
	{ name: "user", summary: "Create, list, disable, enable, delete users; revoke sessions", status: "planned" },
	{ name: "tenant", summary: "Create, list, provision, disable, delete tenants; manage members", status: "planned" },
	{ name: "role", summary: "Manage tenant roles", status: "planned" },
	{ name: "invite", summary: "Manage tenant invitations", status: "planned" },
	{ name: "collection", summary: "Generate and inspect collections", status: "planned" },
	{ name: "migrate", summary: "Generate, inspect and apply migrations", status: "planned" },
	{ name: "wire", summary: "Test notifications and retry failed deliveries", status: "planned" },
	{ name: "secrets", summary: "Initialize, rotate, check and revoke encrypted secrets", status: "planned" },
	{ name: "backup", summary: "Create, list, verify, restore and prune backups", status: "planned" },
	{ name: "logs", summary: "Inspect request and error logs", status: "planned" },
	{ name: "health", summary: "Check Worker and database health", status: "planned" },
];

export const findCommandGroup = (name: string) => commandGroups.find((group) => group.name === name);

// Package and Worker name: lowercase letters, digits and hyphens, as Cloudflare requires.
export const projectNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
