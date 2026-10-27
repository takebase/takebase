-- Custom SQL migration file, put your code below! --
-- Administration invariants (SEGU-220), enforced inside the writing statement
-- so the CLI, the admin API and any future path all obey them:
--   * every tenant declares its roles; `admin` is built in;
--   * a membership or invitation can only use a declared role;
--   * a tenant that has admins always keeps at least one;
--   * a user who loses their last role in a tenant, or whose identity is
--     disabled, deleted or has its sessions revoked, gets a realtime
--     revocation to deliver, at an access revision newer than any grant;
--   * audit events are append-only.
-- Tenant deletion cascades through all of it: the guards check that the
-- tenant still exists, and cascaded rows are gone with the tenant.

-- Existing tenants get the built-in role and every role already in use.
INSERT OR IGNORE INTO `tenant_roles` (`tenant_id`, `name`, `created`)
SELECT `id`, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `tenants`;
--> statement-breakpoint
INSERT OR IGNORE INTO `tenant_roles` (`tenant_id`, `name`, `created`)
SELECT DISTINCT `tenant_id`, `role`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `memberships`;
--> statement-breakpoint
CREATE TRIGGER `takebase_tenant_admin_role` AFTER INSERT ON `tenants`
BEGIN
	INSERT OR IGNORE INTO `tenant_roles` (`tenant_id`, `name`, `created`)
	VALUES (NEW.`id`, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_membership_role_declared` BEFORE INSERT ON `memberships`
WHEN NOT EXISTS (SELECT 1 FROM `tenant_roles` WHERE `tenant_id` = NEW.`tenant_id` AND `name` = NEW.`role`)
BEGIN
	SELECT RAISE(ABORT, 'role is not declared for this tenant');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_membership_role_declared_update` BEFORE UPDATE OF `tenant_id`, `role` ON `memberships`
WHEN NOT EXISTS (SELECT 1 FROM `tenant_roles` WHERE `tenant_id` = NEW.`tenant_id` AND `name` = NEW.`role`)
BEGIN
	SELECT RAISE(ABORT, 'role is not declared for this tenant');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_invitation_role_declared` BEFORE INSERT ON `invitations`
WHEN NOT EXISTS (SELECT 1 FROM `tenant_roles` WHERE `tenant_id` = NEW.`tenant_id` AND `name` = NEW.`role`)
BEGIN
	SELECT RAISE(ABORT, 'role is not declared for this tenant');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_tenant_role_builtin` BEFORE DELETE ON `tenant_roles`
WHEN OLD.`name` = 'admin' AND EXISTS (SELECT 1 FROM `tenants` WHERE `id` = OLD.`tenant_id`)
BEGIN
	SELECT RAISE(ABORT, 'the admin role is built in');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_tenant_role_in_use` BEFORE DELETE ON `tenant_roles`
WHEN EXISTS (SELECT 1 FROM `memberships` WHERE `tenant_id` = OLD.`tenant_id` AND `role` = OLD.`name`)
	AND EXISTS (SELECT 1 FROM `tenants` WHERE `id` = OLD.`tenant_id`)
BEGIN
	SELECT RAISE(ABORT, 'role is still assigned');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_last_admin_delete` BEFORE DELETE ON `memberships`
WHEN OLD.`role` = 'admin'
	AND EXISTS (SELECT 1 FROM `tenants` WHERE `id` = OLD.`tenant_id`)
	AND (SELECT count(*) FROM `memberships` WHERE `tenant_id` = OLD.`tenant_id` AND `role` = 'admin') = 1
BEGIN
	SELECT RAISE(ABORT, 'a tenant must keep at least one admin');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_last_admin_update` BEFORE UPDATE OF `tenant_id`, `role` ON `memberships`
WHEN OLD.`role` = 'admin'
	AND (NEW.`role` IS NOT 'admin' OR NEW.`tenant_id` IS NOT OLD.`tenant_id`)
	AND (SELECT count(*) FROM `memberships` WHERE `tenant_id` = OLD.`tenant_id` AND `role` = 'admin') = 1
BEGIN
	SELECT RAISE(ABORT, 'a tenant must keep at least one admin');
END;
--> statement-breakpoint
-- Replaces 0002's trigger: the revision bump and the revocation row must run in
-- this order, so the revocation outranks every grant made before the removal.
DROP TRIGGER `takebase_access_membership_delete`;
--> statement-breakpoint
CREATE TRIGGER `takebase_access_membership_delete` AFTER DELETE ON `memberships`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` = OLD.`tenant_id`;
	INSERT OR IGNORE INTO `member_revocations` (`tenant_id`, `provider`, `subject`, `rev`, `created`)
	SELECT `id`, OLD.`provider`, OLD.`subject`, `access_revision`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `tenants`
	WHERE `id` = OLD.`tenant_id`
		AND NOT EXISTS (
			SELECT 1 FROM `memberships`
			WHERE `tenant_id` = OLD.`tenant_id` AND `provider` = OLD.`provider` AND `subject` = OLD.`subject`
		);
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_identity_revocation_insert` AFTER INSERT ON `identities`
WHEN NEW.`status` IS NOT 'active' OR NEW.`sessions_valid_after` IS NOT NULL
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
	INSERT OR IGNORE INTO `member_revocations` (`tenant_id`, `provider`, `subject`, `rev`, `created`)
	SELECT `id`, NEW.`provider`, NEW.`subject`, `access_revision`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `tenants`
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
	-- The memberships are unchanged, so move past the revocation: a fresh sign-in
	-- (re-enabled, or after a session revoke) must be granted at a newer revision.
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_identity_revocation_update` AFTER UPDATE OF `status`, `sessions_valid_after` ON `identities`
WHEN (NEW.`status` IS NOT OLD.`status` AND NEW.`status` IS NOT 'active')
	OR NEW.`sessions_valid_after` IS NOT OLD.`sessions_valid_after`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
	INSERT OR IGNORE INTO `member_revocations` (`tenant_id`, `provider`, `subject`, `rev`, `created`)
	SELECT `id`, NEW.`provider`, NEW.`subject`, `access_revision`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `tenants`
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
	-- The memberships are unchanged, so move past the revocation: a fresh sign-in
	-- (re-enabled, or after a session revoke) must be granted at a newer revision.
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1
	WHERE `id` IN (SELECT `tenant_id` FROM `memberships` WHERE `provider` = NEW.`provider` AND `subject` = NEW.`subject`);
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_audit_no_update` BEFORE UPDATE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_audit_no_delete` BEFORE DELETE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'audit events are append-only');
END;
