-- Custom SQL migration file, put your code below! --
-- tenants.access_revision moves forward whenever who may enter the tenant can
-- change: a membership is added, removed or rewritten, or the tenant's status
-- changes. The triggers run inside the writing statement, so no code path can
-- change access without bumping the revision.
CREATE TRIGGER `takebase_access_membership_insert` AFTER INSERT ON `memberships`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` = NEW.`tenant_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_access_membership_delete` AFTER DELETE ON `memberships`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` = OLD.`tenant_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_access_membership_update` AFTER UPDATE OF `tenant_id`, `provider`, `subject`, `role` ON `memberships`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` IN (OLD.`tenant_id`, NEW.`tenant_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_access_tenant_status` AFTER UPDATE OF `status` ON `tenants`
WHEN OLD.`status` IS NOT NEW.`status`
BEGIN
	UPDATE `tenants` SET `access_revision` = `access_revision` + 1 WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `takebase_access_revision_monotonic` BEFORE UPDATE OF `access_revision` ON `tenants`
WHEN NEW.`access_revision` < OLD.`access_revision`
BEGIN
	SELECT RAISE(ABORT, 'access_revision never decreases');
END;
