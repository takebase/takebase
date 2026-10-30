<script lang="ts">
import { backups, loadBackups, pruneCommand, reviewRestore, verifyBackup } from "#lib/stores/backups.svelte.ts";
import { session } from "#lib/stores/session.svelte.ts";

// Loads again whenever another tenant is selected.
$effect(() => {
	if (session.tenant) void loadBackups();
});

let reviewingPrune = $state(false);

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`);
</script>

{#if !session.tenant}
	<p>Select a tenant to administer.</p>
{:else}
	<section data-testid="backups" data-tenant={session.tenant.tenant.id}>
		<h2>Backups: {session.tenant.tenant.name}</h2>
		<p>
			Backups that hold this tenant, from their manifests. Only this tenant's parts are shown and no backup content
			reaches this page. Creating, restoring and pruning backups are operator commands.
		</p>
		<button type="button" onclick={loadBackups} disabled={backups.loading}>
			{backups.loading ? "Refreshing…" : "Refresh"}
		</button>

		{#if backups.error}
			<p class="error" role="alert" data-testid="backups-error">{backups.error}</p>
		{/if}

		{#if backups.list}
			{#if backups.list.length > 0}
				<table data-testid="backup-list">
					<thead>
						<tr><th>Backup</th><th>Created</th><th>Scope</th><th>Parts</th><th>Schema</th><th>Keys</th><th>Check</th></tr>
					</thead>
					<tbody>
						{#each backups.list as backup (backup.backupId)}
							{@const check = backups.checks[backup.backupId]}
							<tr data-backup={backup.backupId} data-status={check?.status ?? "unchecked"}>
								<td><code>{backup.backupId}</code></td>
								<td>{backup.created}</td>
								<td>{backup.scope}</td>
								<td>
									{#each backup.parts as part (part.kind)}
										<span class="part">{part.kind} {size(part.bytes)}</span>
									{/each}
								</td>
								<td>{backup.schemaVersion ?? "none"}</td>
								<td>{backup.keyVersions.length > 0 ? backup.keyVersions.map((v) => `v${v}`).join(", ") : "none"}</td>
								<td>
									<button
										type="button"
										onclick={() => verifyBackup(backup.backupId)}
										disabled={backups.checking !== null}
									>
										{backups.checking === backup.backupId ? "Verifying…" : "Verify"}
									</button>
									<button
										type="button"
										onclick={() => reviewRestore(backup.backupId)}
										disabled={backups.planning !== null}
									>
										{backups.planning === backup.backupId ? "Reading…" : "Review restore"}
									</button>
									{#if check}
										<span data-testid="check-status">{check.status}</span>
									{/if}
								</td>
							</tr>
							{#if check}
								<tr class="detail" data-check={backup.backupId}>
									<td colspan="7">
										{#if check.problems.length > 0}
											<ul class="error">
												{#each check.problems as problem (problem)}<li>{problem}</li>{/each}
											</ul>
										{/if}
										<ul>
											{#each check.checked as item (item)}<li>{item}</li>{/each}
										</ul>
										<p>The SQL export is not replayed here: <code>takebase backup verify {backup.backupId}</code> does that.</p>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			{:else}
				<p>No backup holds this tenant.</p>
			{/if}

			{#if backups.plan}
				{@const plan = backups.plan}
				<div data-testid="restore-plan" data-backup={plan.backupId} data-ready={plan.problems.length === 0}>
					<h3>Restore review: <code>{plan.backupId}</code></h3>
					<p>This review creates nothing. A restore never touches this tenant's own database or secrets.</p>
					<dl>
						<dt>Tenant</dt>
						<dd data-testid="plan-tenant">{plan.tenantId}</dd>
						<dt>Environment</dt>
						<dd data-testid="plan-env">{plan.environment}</dd>
						<dt>New database</dt>
						<dd data-testid="plan-database"><code>{plan.target?.database ?? "unknown"}</code></dd>
						<dt>New secrets namespace</dt>
						<dd data-testid="plan-namespace"><code>{plan.target?.namespace ?? "unknown"}</code></dd>
						<dt>Schema</dt>
						<dd>{plan.schemaVersion ?? "none"}</dd>
						<dt>Encrypted secrets</dt>
						<dd data-testid="plan-secrets">{plan.secrets}</dd>
						<dt>Key versions needed</dt>
						<dd>{plan.keyVersions.map((v) => `v${v}`).join(", ") || "none"}</dd>
					</dl>
					{#if plan.problems.length > 0}
						<p>This backup cannot be restored as it stands:</p>
						<ul class="error" data-testid="plan-problems">
							{#each plan.problems as problem (problem)}<li>{problem}</li>{/each}
						</ul>
					{:else}
						<p data-testid="plan-ok">The checks possible here pass. Only the operator's dry-run also replays the SQL export and opens every secret.</p>
					{/if}
					<p>This page cannot restore. The operator checks with the first command and confirms with the second:</p>
					<ol>
						<li><code data-testid="plan-dry-run">{plan.commands.dryRun}</code></li>
						<li><code data-testid="plan-restore">{plan.commands.restore}</code></li>
					</ol>
				</div>
			{/if}

			{#if backups.list.length > 0}
				{@const environment = backups.list[0]?.environment ?? "local"}
				<h3>Pruning</h3>
				<button type="button" onclick={() => (reviewingPrune = !reviewingPrune)} aria-expanded={reviewingPrune}>
					Review pruning
				</button>
				{#if reviewingPrune}
					<div data-testid="prune-review">
						<p>
							Pruning deletes old backups of the whole <strong>{environment}</strong> environment, not only this tenant's,
							so this page cannot do it. It always keeps the newest verified backup of each subject and any backup a
							recorded restore refers to. The operator lists what would go, then confirms there.
						</p>
						<code data-testid="prune-command">{pruneCommand(environment)}</code>
					</div>
				{/if}
			{/if}
		{/if}
	</section>
{/if}

<style>
	dl {
		display: grid;
		grid-template-columns: max-content auto;
		gap: 0.25rem 1rem;
	}
	dd {
		margin: 0;
	}
	table {
		border-collapse: collapse;
		margin-block: 0.5rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.25rem 0.75rem 0.25rem 0;
		vertical-align: top;
	}
	.part {
		margin-right: 0.5rem;
	}
	.error {
		color: #b00020;
	}
</style>
