CREATE TABLE `takebase_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`collection` text NOT NULL,
	`operation` text NOT NULL,
	`record_id` text NOT NULL,
	`created` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`delivered_at` text,
	CONSTRAINT "takebase_outbox_operation" CHECK("takebase_outbox"."operation" in ('create', 'update', 'delete')),
	CONSTRAINT "takebase_outbox_status" CHECK("takebase_outbox"."status" in ('pending', 'delivered', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `takebase_outbox_id_unique` ON `takebase_outbox` (`id`);--> statement-breakpoint
CREATE INDEX `takebase_outbox_claimable` ON `takebase_outbox` (`status`,`available_at`);