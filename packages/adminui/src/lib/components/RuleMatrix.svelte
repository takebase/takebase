<script lang="ts">
import type { AdminCollection, CollectionOperation } from "@takebase/sdk";

// Read-only: which rule each collection applies to each operation, as the
// tenant Worker declares it. Rules change in code, never here.
let { list }: { list: AdminCollection[] } = $props();

const operations: CollectionOperation[] = ["list", "view", "create", "update", "delete"];
</script>

<table data-testid="rule-matrix">
	<thead>
		<tr>
			<th>Collection</th>
			{#each operations as operation (operation)}<th>{operation}</th>{/each}
		</tr>
	</thead>
	<tbody>
		{#each list as collection (collection.name)}
			<tr data-collection={collection.name}>
				<td>{collection.name}</td>
				{#each operations as operation (operation)}
					<td data-operation={operation}><code>{collection.rules[operation] ?? "none (denied)"}</code></td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

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
</style>
