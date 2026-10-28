<script lang="ts">
import type { Readiness } from "@takebase/sdk";
import { diagnostics, loadDiagnostics, retryDead } from "#lib/stores/diagnostics.svelte.ts";
import { session } from "#lib/stores/session.svelte.ts";

// Loads again whenever another tenant is selected.
$effect(() => {
	if (session.tenant) void loadDiagnostics();
});

const workers = [
	{ key: "global", label: "Global Worker" },
	{ key: "tenant", label: "Tenant Worker" },
] as const;

const checks = (readiness: Readiness) => Object.entries(readiness.checks);
</script>

{#if !session.tenant}
	<p>Select a tenant to administer.</p>
{:else}
	<section data-testid="diagnostics" data-tenant={session.tenant.tenant.id}>
		<h2>Diagnostics: {session.tenant.tenant.name}</h2>
		<button type="button" onclick={loadDiagnostics} disabled={diagnostics.loading}>
			{diagnostics.loading ? "Refreshing…" : "Refresh"}
		</button>

		<h3>Readiness</h3>
		<table data-testid="readiness">
			<thead><tr><th>Worker</th><th>Status</th><th>Checks</th></tr></thead>
			<tbody>
				{#each workers as { key, label } (key)}
					{@const readiness = diagnostics.readiness[key]}
					<tr data-worker={key} data-status={readiness?.status ?? "unknown"}>
						<td>{label}</td>
						{#if readiness}
							<td>{readiness.status}</td>
							<td>
								{#each checks(readiness) as [name, state] (name)}
									<span class="check" data-check={name}>{name}: {state}</span>
								{/each}
							</td>
						{:else}
							<td colspan="2" class="error">{diagnostics.errors[key] ?? "…"}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>

		{#if diagnostics.notice}
			<p role="status" data-testid="diagnostics-notice">{diagnostics.notice}</p>
		{/if}
		{#if diagnostics.errors.diagnostics}
			<p class="error" role="alert" data-testid="diagnostics-error">{diagnostics.errors.diagnostics}</p>
		{/if}

		{#if diagnostics.tenant}
			{@const report = diagnostics.tenant}
			<h3>Outbox</h3>
			<dl data-testid="outbox">
				<dt>Pending</dt>
				<dd data-count="pending">{report.outbox.counts.pending}</dd>
				<dt>Delivered</dt>
				<dd data-count="delivered">{report.outbox.counts.delivered}</dd>
				<dt>Dead</dt>
				<dd data-count="dead">{report.outbox.counts.dead}</dd>
				<dt>Oldest pending</dt>
				<dd>{report.outbox.oldestPending ?? "none"}</dd>
			</dl>

			<h4>Dead events</h4>
			{#if report.outbox.dead.length > 0}
				<button type="button" onclick={() => retryDead()} data-testid="retry-all">Retry all dead events</button>
				<table data-testid="dead">
					<thead>
						<tr><th>Seq</th><th>Collection</th><th>Operation</th><th>Attempts</th><th>Created</th><th></th></tr>
					</thead>
					<tbody>
						{#each report.outbox.dead as event (event.id)}
							<tr data-event={event.id}>
								<td>{event.seq}</td>
								<td>{event.collection}</td>
								<td>{event.operation}</td>
								<td>{event.attempts}</td>
								<td>{event.created}</td>
								<td><button type="button" onclick={() => retryDead([event.id])}>Retry</button></td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p>No dead events.</p>
			{/if}

			<h3>Realtime</h3>
			<dl data-testid="realtime-diagnostics">
				<dt>Configured</dt>
				<dd>{report.realtime ? "yes" : "no"}</dd>
				<dt>Revocations owed to this tenant</dt>
				<dd data-testid="revocations">
					{#if report.revocations}
						tenant: {report.revocations.tenant ?? "none"}, members: {report.revocations.members}
					{:else}
						unknown (the global Worker did not answer)
					{/if}
				</dd>
			</dl>

			<h3>Migrations</h3>
			<ol data-testid="migrations">
				{#each report.migrations as migration (migration)}<li><code>{migration}</code></li>{/each}
			</ol>
		{/if}
	</section>
{/if}

<style>
	table {
		border-collapse: collapse;
		margin-block: 0.5rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.25rem 0.75rem 0.25rem 0;
	}
	.check {
		margin-right: 0.75rem;
	}
	dl {
		display: grid;
		grid-template-columns: max-content auto;
		gap: 0.25rem 1rem;
	}
	dd {
		margin: 0;
	}
</style>
