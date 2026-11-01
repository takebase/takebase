CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`role` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_identity` ON `memberships` (`provider`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_tenant_identity_role` ON `memberships` (`tenant_id`,`provider`,`subject`,`role`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	CONSTRAINT "tenants_status" CHECK("tenants"."status" in ('active', 'disabled'))
);
