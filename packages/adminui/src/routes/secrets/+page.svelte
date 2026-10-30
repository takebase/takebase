<script lang="ts">
import { loadSecrets, rotationCommand, secrets } from "#lib/stores/secret-status.svelte.ts";
import { session } from "#lib/stores/session.svelte.ts";

// Loads again whenever another tenant is selected.
$effect(() => {
	if (session.tenant) void loadSecrets();
});

const states = {
	ok: "The installed key opens the stored secrets.",
	unconfigured: "No data key is configured for this tenant.",
	missing_key: "A key version is configured but its key is not installed.",
	mismatch: "The installed key does not open what is stored.",
} as const;

let reviewing = $state(false);
</script>

{#if !session.tenant}
	<p>Select a tenant to administer.</p>
{:else}
	<section data-testid="secrets" data-tenant={session.tenant.tenant.id}>
		<h2>Secrets: {session.tenant.tenant.name}</h2>
		<p>Values and keys never reach this page: it shows key state and metadata only.</p>
		<button type="button" onclick={loadSecrets} disabled={secrets.loading}>
			{secrets.loading ? "Refreshing…" : "Refresh"}
		</button>

		{#if secrets.error}
			<p class="error" role="alert" data-testid="secrets-error">{secrets.error}</p>
		{/if}

		{#if secrets.report}
			{@const report = secrets.report}
			{@const behind = report.secrets.filter(({ keyVersion }) => keyVersion !== report.activeKeyVersion).length}
			<dl data-testid="secrets-state" data-state={report.state}>
				<dt>State</dt>
				<dd>{report.state}: {states[report.state]}</dd>
				<dt>Active key version</dt>
				<dd data-testid="active-key">{report.activeKeyVersion ?? "none"}</dd>
				<dt>Installed key versions</dt>
				<dd data-testid="installed-keys">{report.installedKeyVersions.join(", ") || "none"}</dd>
				<dt>On an older key</dt>
				<dd data-testid="behind">{behind}</dd>
			</dl>

			<h3>Stored secrets</h3>
			{#if report.secrets.length > 0}
				<table data-testid="secret-list">
					<thead><tr><th>Purpose</th><th>Name</th><th>Key version</th><th>Updated</th></tr></thead>
					<tbody>
						{#each report.secrets as secret (`${secret.purpose}/${secret.name}`)}
							<tr data-secret={`${secret.purpose}/${secret.name}`}>
								<td>{secret.purpose}</td>
								<td>{secret.name}</td>
								<td>{secret.keyVersion}</td>
								<td>{secret.updated}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p>No secrets are stored.</p>
			{/if}

			<h3>Key rotation</h3>
			<button type="button" onclick={() => (reviewing = !reviewing)} aria-expanded={reviewing}>
				Review rotation
			</button>
			{#if reviewing}
				<div data-testid="rotation-review">
					<dl>
						<dt>Tenant</dt>
						<dd data-testid="rotation-tenant">{report.tenantId}</dd>
						<dt>Environment</dt>
						<dd data-testid="rotation-env">{report.environment ?? "local"}</dd>
						<dt>Effect</dt>
						<dd>
							A new key replaces version {report.activeKeyVersion ?? "none"}, every secret is re-encrypted and verified,
							then the old key is retired.
						</dd>
					</dl>
					<p>
						This page cannot rotate keys: the operator runs the rotation with the keys file and escrow, and confirms
						it there.
					</p>
					<code data-testid="rotation-command">{rotationCommand(report)}</code>
				</div>
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
	}
	.error {
		color: #b00020;
	}
</style>
