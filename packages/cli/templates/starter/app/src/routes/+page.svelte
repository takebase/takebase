<script lang="ts">
import type { CollectionRecord, TenantMembership } from "@takebase/sdk";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { onMount } from "svelte";
import { useTakebase } from "#lib/takebase.ts";

type Note = { title: string; done: boolean };

let signedIn = $state<string | null>(null);
let tenants = $state<TenantMembership[]>([]);
let selected = $state<string | null>(null);
let notes = $state<CollectionRecord<Note>[]>([]);
let error = $state<string | null>(null);
let email = $state("");
let password = $state("");
let title = $state("");
let unsubscribe: (() => void) | null = null;

const failed = (cause: unknown) => {
	error = cause instanceof Error ? cause.message : String(cause);
};
const collection = () => useTakebase().client.collection<Note>("notes");

// Records are never read from the realtime signal: it only says "refetch".
const refetch = async () => {
	try {
		notes = (await collection().getList({ sort: "-created" })).items;
	} catch (cause) {
		failed(cause);
	}
};

const clear = () => {
	unsubscribe?.();
	unsubscribe = null;
	notes = [];
	selected = null;
};

onMount(() => {
	const { auth, client } = useTakebase();
	const stopSignedOut = client.auth.onSignedOut(() => {
		clear();
		tenants = [];
		signedIn = null;
	});
	const stopAuth = onAuthStateChanged(auth, async (user) => {
		signedIn = user?.email ?? null;
		if (!user) return;
		try {
			tenants = await client.auth.getTenants();
		} catch (cause) {
			failed(cause);
		}
	});
	return () => {
		stopAuth();
		stopSignedOut();
		clear();
	};
});

const signIn = async (event: SubmitEvent) => {
	event.preventDefault();
	error = null;
	await signInWithEmailAndPassword(useTakebase().auth, email, password).catch(failed);
};

const select = async (id: string) => {
	clear();
	error = null;
	try {
		await useTakebase().client.useTenant(id);
		selected = id;
		unsubscribe = collection().subscribe("*", refetch);
	} catch (cause) {
		failed(cause);
	}
};

const create = async (event: SubmitEvent) => {
	event.preventDefault();
	error = null;
	try {
		// No refetch here: the list changes when the realtime signal arrives.
		await collection().create({ title, done: false });
		title = "";
	} catch (cause) {
		failed(cause);
	}
};
</script>

<svelte:head><title>{{name}}</title></svelte:head>

<main>
	<h1>{{name}}</h1>
	{#if error}<p role="alert">{error}</p>{/if}

	{#if signedIn === null}
		<form onsubmit={signIn} data-testid="sign-in">
			<label>Email <input type="email" bind:value={email} autocomplete="username" /></label>
			<label>Password <input type="password" bind:value={password} autocomplete="current-password" /></label>
			<button type="submit">Sign in</button>
		</form>
	{:else}
		<p>
			<span data-testid="user">{signedIn}</span>
			<button type="button" onclick={() => useTakebase().client.auth.signOut()}>Sign out</button>
		</p>
		<nav aria-label="Tenants" data-testid="tenants">
			{#each tenants as membership (membership.tenant.id)}
				<button type="button" onclick={() => select(membership.tenant.id)}>{membership.tenant.name}</button>
			{:else}
				<p>You belong to no tenants.</p>
			{/each}
		</nav>
		{#if selected}
			<section data-testid="notes" data-tenant={selected}>
				<form onsubmit={create} data-testid="create-note">
					<label>Title <input bind:value={title} /></label>
					<button type="submit">Add</button>
				</form>
				<ul data-testid="note-list">
					{#each notes as note (note.id)}
						<li>{note.title}</li>
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
	form,
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-block: 1rem;
	}
	[role="alert"] {
		color: #b00020;
	}
</style>
