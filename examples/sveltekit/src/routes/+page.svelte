<script lang="ts">
import type { TakebaseError } from "@takebase/sdk";
import { onMount } from "svelte";
import { createPolicy, type PolicyFields, policies } from "#lib/stores/policies/store.svelte.ts";
import { selectTenant, session, signIn, signOut, startSession } from "#lib/stores/session.svelte.ts";

// The local milestone: sign in, pick a tenant, create a policy and watch the
// list follow realtime signals. All state lives in the stores.

let email = $state("alice@example.test");
let password = $state("local-only-password");
let draft = $state<PolicyFields>({ number: "", holder: "", status: "pending" });
let createError = $state<string | null>(null);
let fieldErrors = $state<Record<string, string>>({});

onMount(startSession);

const create = async (event: SubmitEvent) => {
	event.preventDefault();
	createError = null;
	fieldErrors = {};
	try {
		await createPolicy(draft);
		draft = { number: "", holder: "", status: "pending" };
	} catch (error) {
		const failure = error as TakebaseError;
		createError = failure.message;
		fieldErrors = failure.fields ?? {};
	}
};

const login = (event: SubmitEvent) => {
	event.preventDefault();
	void signIn(email, password);
};
</script>

<main>
	<h1>Takebase local milestone</h1>

	{#if session.notice}
		<p class="notice" data-testid="notice">{session.notice}</p>
	{/if}
	{#if session.error}
		<p class="error" data-testid="session-error">{session.error}</p>
	{/if}

	{#if session.phase === "starting"}
		<p>Starting…</p>
	{:else if session.phase === "signed-out"}
		<form onsubmit={login} data-testid="sign-in">
			<label>Email <input name="email" type="email" bind:value={email} autocomplete="username" /></label>
			<label>
				Password
				<input name="password" type="password" bind:value={password} autocomplete="current-password" />
			</label>
			<button type="submit">Sign in</button>
		</form>
	{:else}
		<header>
			<span data-testid="user">{session.email}</span>
			<button type="button" onclick={signOut}>Sign out</button>
		</header>

		<nav aria-label="Tenants" data-testid="tenants">
			{#each session.tenants as membership (membership.tenant.id)}
				<button
					type="button"
					aria-pressed={session.tenant?.tenant.id === membership.tenant.id}
					onclick={() => selectTenant(membership.tenant.id)}
				>
					{membership.tenant.name} ({membership.roles.join(", ")})
				</button>
			{:else}
				<p>You belong to no tenants.</p>
			{/each}
		</nav>

		{#if session.tenant}
			<section data-testid="policies" data-tenant={session.tenant.tenant.id}>
				<h2>Policies in {session.tenant.tenant.name}</h2>

				<form onsubmit={create} data-testid="create-policy">
					<label>Number <input name="number" bind:value={draft.number} /></label>
					<label>Holder <input name="holder" bind:value={draft.holder} /></label>
					<label>
						Status
						<select name="status" bind:value={draft.status}>
							<option value="pending">pending</option>
							<option value="active">active</option>
							<option value="cancelled">cancelled</option>
						</select>
					</label>
					<button type="submit">Create</button>
					{#if createError}
						<p class="error" data-testid="create-error">{createError}</p>
					{/if}
					{#each Object.entries(fieldErrors) as [field, text] (field)}
						<p class="error">{field}: {text}</p>
					{/each}
				</form>

				{#if policies.error}
					<p class="error">{policies.error}</p>
				{/if}
				<p data-testid="policy-count">{policies.total} {policies.total === 1 ? "policy" : "policies"}</p>
				<ul data-testid="policy-list">
					{#each policies.items as policy (policy.id)}
						<li>{policy.number} · {policy.status}</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 2rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
	}
	header,
	nav,
	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin-block: 1rem;
	}
	button[aria-pressed="true"] {
		font-weight: bold;
	}
	.error {
		color: #b00020;
	}
	.notice {
		color: #8a5a00;
	}
</style>
