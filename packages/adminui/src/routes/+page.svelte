<script lang="ts">
import { isTenantAdmin, session } from "#lib/stores/session.svelte.ts";
</script>

{#if session.tenant}
	<section data-testid="tenant" data-tenant={session.tenant.tenant.id}>
		<h2>{session.tenant.tenant.name}</h2>
		<p>Your roles here: {session.tenant.roles.join(", ")}.</p>
		{#if !isTenantAdmin()}
			<p data-testid="not-admin">
				You are not an admin of this tenant, so its Workers refuse administration requests from you.
			</p>
		{/if}
	</section>
{:else}
	<p>Select a tenant to administer.</p>
{/if}
