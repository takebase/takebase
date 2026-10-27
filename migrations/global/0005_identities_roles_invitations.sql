CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`tenant_id` text,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_tenant` ON `audit_events` (`tenant_id`,`created`);--> statement-breakpoint
CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sessions_valid_after` integer,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	CONSTRAINT "identities_status" CHECK("identities"."status" in ('active', 'disabled', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`expires` text NOT NULL,
	`redeemed_by` text,
	`redeemed_at` text,
	`revoked_at` text,
	`created` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_tenant` ON `invitations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `member_revocations` (
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`rev` integer NOT NULL,
	`created` text NOT NULL,
	`confirmed` text,
	PRIMARY KEY(`tenant_id`, `provider`, `subject`, `rev`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_revocations_pending` ON `member_revocations` (`tenant_id`,`confirmed`);--> statement-breakpoint
CREATE TABLE `tenant_roles` (
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `name`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tenant_roles_name" CHECK(length("tenant_roles"."name") between 1 and 64)
);
