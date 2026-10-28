<script lang="ts">
import type { CollectionRecord } from "@takebase/sdk";
import { onDestroy } from "svelte";
import {
	closeCollection,
	collections,
	createRecord,
	deleteRecord,
	goToPage,
	loadCollections,
	openCollection,
	sortBy,
	updateRecord,
} from "#lib/stores/collections.svelte.ts";
import { session } from "#lib/stores/session.svelte.ts";

// The form being filled: a new record, or the record being edited.
let editing = $state<string | null>(null);
let draft = $state<Record<string, string>>({});

// Loads again whenever another tenant is selected.
$effect(() => {
	if (session.tenant) void loadCollections();
});

onDestroy(closeCollection);

// A form never outlives its collection (or tenant).
$effect(() => {
	void collections.open;
	editing = null;
	draft = {};
});

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const startNew = () => {
	editing = "new";
	draft = Object.fromEntries((collections.open?.fields ?? []).map(({ name }) => [name, ""]));
};

const startEdit = (record: CollectionRecord) => {
	editing = record.id;
	draft = Object.fromEntries((collections.open?.fields ?? []).map(({ name }) => [name, text(record[name])]));
};

const save = async (event: SubmitEvent) => {
	event.preventDefault();
	const id = editing;
	if (id === null) return;
	const saved = id === "new" ? await createRecord(draft) : await updateRecord(id, draft);
	if (saved) {
		editing = null;
		draft = {};
	}
};

const sortOptions = $derived((collections.open?.sorts ?? []).flatMap((sort) => [`-${sort}`, sort]));
</script>

{#if !session.tenant}
	<p>Select a tenant to administer.</p>
{:else}
	<section data-testid="collections" data-tenant={session.tenant.tenant.id}>
		<h2>Collections: {session.tenant.tenant.name}</h2>

		{#if collections.error}
			<p class="error" role="alert" data-testid="collections-error">{collections.error}</p>
		{/if}

		{#if collections.loaded}
			<nav aria-label="Collections">
				{#each collections.list as collection (collection.name)}
					<button
						type="button"
						aria-pressed={collections.open?.name === collection.name}
						onclick={() => openCollection(collection.name)}
					>
						{collection.name}
					</button>
				{:else}
					<p>This tenant declares no collections.</p>
				{/each}
			</nav>
		{:else if !collections.error}
			<p>Loading…</p>
		{/if}

		{#if collections.open}
			{@const open = collections.open}
			<p class="realtime" data-testid="realtime" data-live={collections.realtime.live}>
				Realtime:
				{#if !collections.realtime.subscribed}
					not subscribed
				{:else if !collections.realtime.live}
					connecting…
				{:else}
					live, revision {collections.realtime.revision}, last signal {collections.realtime.lastSignal},
					<span data-testid="refetches">{collections.realtime.refetches}</span> refetches
				{/if}
			</p>

			<div class="toolbar">
				<label>
					Sort
					<select value={collections.sort} onchange={(event) => sortBy(event.currentTarget.value)}>
						{#each sortOptions as option (option)}
							<option value={option}>{option.startsWith("-") ? `${option.slice(1)} ↓` : `${option} ↑`}</option>
						{/each}
					</select>
				</label>
				<button type="button" onclick={startNew}>New record</button>
			</div>

			{#if editing !== null}
				<form onsubmit={save} data-testid="record-form" data-editing={editing}>
					<h3>{editing === "new" ? `New ${open.name} record` : `Edit ${editing}`}</h3>
					{#each open.fields as field (field.name)}
						<label>
							{field.name}
							<input name={field.name} bind:value={draft[field.name]} title={field.rules.join("|")} />
							{#if collections.fields[field.name]}
								<span class="error" data-testid="field-error">{collections.fields[field.name]}</span>
							{/if}
						</label>
					{/each}
					<div>
						<button type="submit">Save</button>
						<button type="button" onclick={() => (editing = null)}>Cancel</button>
					</div>
				</form>
			{/if}

			{#if collections.records}
				{@const records = collections.records}
				<table data-testid="records">
					<thead>
						<tr>
							<th>id</th>
							{#each open.fields as field (field.name)}<th>{field.name}</th>{/each}
							<th>updated</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each records.items as record (record.id)}
							<tr data-id={record.id}>
								<td><code>{record.id}</code></td>
								{#each open.fields as field (field.name)}<td>{text(record[field.name])}</td>{/each}
								<td>{record.updated}</td>
								<td>
									<button type="button" onclick={() => startEdit(record)}>Edit</button>
									<button type="button" onclick={() => deleteRecord(record.id)}>Delete</button>
								</td>
							</tr>
						{:else}
							<tr><td colspan={open.fields.length + 3}>No records you may see.</td></tr>
						{/each}
					</tbody>
				</table>
				<p>
					Page {records.page} of {Math.max(records.totalPages, 1)} ({records.totalItems} records)
					<button type="button" disabled={records.page <= 1} onclick={() => goToPage(records.page - 1)}>Previous</button>
					<button type="button" disabled={records.page >= records.totalPages} onclick={() => goToPage(records.page + 1)}>
						Next
					</button>
				</p>
			{/if}
		{/if}
	</section>
{/if}

<style>
	nav,
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin-block: 0.5rem;
	}
	form {
		display: grid;
		gap: 0.5rem;
		max-width: 32rem;
		margin-block: 1rem;
	}
	form label {
		display: grid;
		gap: 0.25rem;
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
	.realtime {
		color: #555;
	}
</style>
