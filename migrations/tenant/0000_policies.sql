CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`holder` text NOT NULL,
	`status` text NOT NULL,
	`agent_id` text,
	`premium` integer,
	`notes` text,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policies_number_unique` ON `policies` (`number`);