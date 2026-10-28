<script lang="ts">
import { onMount } from "svelte";
import favicon from "#lib/assets/favicon.svg";
import { selectTenant, session, signIn, signOut, startSession } from "#lib/stores/session.svelte.ts";
import { resolve } from "$app/paths";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();

let email = $state("");
let password = $state("");

onMount(startSession);

const login = (event: SubmitEvent) => {
	event.preventDefault();
	void signIn(email, password);
	password = "";
};
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Takebase admin</title>
</svelte:head>

<main>
	<h1>Takebase admin</h1>

	{#if session.notice}
		<p class="notice" role="status" data-testid="notice">{session.notice}</p>
	{/if}
	{#if session.error}
		<p class="error" role="alert" data-testid="session-error">{session.error}</p>
	{/if}

	{#if session.phase === "starting"}
		<p>Starting…</p>
	{:else if session.phase === "signed-out"}
		<form onsubmit={login} data-testid="sign-in">
			<label>Email <input name="email" type="email" bind:value={email} autocomplete="username" required /></label>
			<label>
				Password
				<input name="password" type="password" bind:value={password} autocomplete="current-password" required />
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

		<nav aria-label="Screens">
			<a href={resolve("/")}>Overview</a>
			<a href={resolve("/access")}>Members, roles and invitations</a>
			<a href={resolve("/collections")}>Collections</a>
			<a href={resolve("/diagnostics")}>Diagnostics</a>
		</nav>

		{@render children()}
	{/if}
</main>

<style>
	main {
		max-width: 60rem;
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
	:global(button[aria-pressed="true"]) {
		font-weight: bold;
	}
	:global(.error) {
		color: #b00020;
	}
	.notice {
		color: #8a5a00;
	}
</style>
