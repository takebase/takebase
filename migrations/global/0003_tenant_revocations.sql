CREATE TABLE `tenant_revocations` (
	`tenant_id` text NOT NULL,
	`rev` integer NOT NULL,
	`created` text NOT NULL,
	`confirmed` text,
	PRIMARY KEY(`tenant_id`, `rev`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
