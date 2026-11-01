-- Custom SQL migration file, put your code below! --
-- A disabled tenant must lose every realtime grant, reliably. Whenever a
-- disabled tenant's access revision moves (the status change itself, or a
-- membership change while disabled), record a tenant-wide revocation at that
-- revision. The row is written by the same statement that changed access, so
-- no code path can disable a tenant without leaving a revocation to deliver.
CREATE TRIGGER `takebase_tenant_revocation` AFTER UPDATE OF `access_revision` ON `tenants`
WHEN NEW.`status` = 'disabled'
BEGIN
	INSERT OR IGNORE INTO `tenant_revocations` (`tenant_id`, `rev`, `created`)
	VALUES (NEW.`id`, NEW.`access_revision`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
