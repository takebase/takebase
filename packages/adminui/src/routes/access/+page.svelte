<script lang="ts">
import RuleMatrix from "#lib/components/RuleMatrix.svelte";
import {
	access,
	addMember,
	createInvite,
	createRole,
	deleteRole,
	dismissInvite,
	loadAccess,
	removeMember,
	revokeInvite,
} from "#lib/stores/access.svelte.ts";
import { collections, loadCollections } from "#lib/stores/collections.svelte.ts";
import { session } from "#lib/stores/session.svelte.ts";

let memberUid = $state("");
let memberRole = $state("");
let roleName = $state("");
let inviteRole = $state("");
let inviteHours = $state("");

// Loads again whenever another tenant is selected.
$effect(() => {
	if (session.tenant) {
		void loadAccess();
		void loadCollections();
	}
});

const submit = (action: () => Promise<void>) => (event: SubmitEvent) => {
	event.preventDefault();
	void action();
};

const hours = () => (inviteHours.trim() === "" ? undefined : Number(inviteHours));
</script>

{#if !session.tenant}
	<p>Select a tenant to administer.</p>
{:else}
	<section data-testid="access" data-tenant={session.tenant.tenant.id}>
		<h2>Access: {session.tenant.tenant.name}</h2>

		{#if access.error}
			<p class="error" role="alert" data-testid="access-error">{access.error}</p>
		{/if}
		{#if access.notice}
			<p role="status" data-testid="access-notice">{access.notice}</p>
		{/if}

		{#if access.loaded}
			<h3>Members</h3>
			<table data-testid="members">
				<thead><tr><th>User</th><th>Roles</th><th></th></tr></thead>
				<tbody>
					{#each access.members as member (member.uid)}
						<tr data-uid={member.uid}>
							<td><code>{member.uid}</code></td>
							<td>
								{#each member.roles as role (role)}
									<span class="chip">
										{role}
										<button type="button" title="Remove this role" onclick={() => removeMember(member.uid, role)}>×</button>
									</span>
								{/each}
							</td>
							<td><button type="button" onclick={() => removeMember(member.uid)}>Remove</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
			<form onsubmit={submit(() => addMember(memberUid.trim(), memberRole))} data-testid="add-member">
				<label>User id <input bind:value={memberUid} required /></label>
				<label>
					Role
					<select bind:value={memberRole} required>
						{#each access.roles as role (role.name)}<option value={role.name}>{role.name}</option>{/each}
					</select>
				</label>
				<button type="submit">Add member</button>
			</form>

			<h3>Roles</h3>
			<table data-testid="roles">
				<thead><tr><th>Role</th><th>Members</th><th></th></tr></thead>
				<tbody>
					{#each access.roles as role (role.name)}
						<tr data-role={role.name}>
							<td>{role.name}</td>
							<td>{role.members}</td>
							<td><button type="button" onclick={() => deleteRole(role.name)}>Delete</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
			<form
				onsubmit={submit(async () => {
					await createRole(roleName.trim());
					if (!access.error) roleName = "";
				})}
				data-testid="create-role"
			>
				<label>Name <input bind:value={roleName} required /></label>
				<button type="submit">Create role</button>
			</form>

			<h3>Collection rules</h3>
			<p>What each role may do follows from these rules, declared in the tenant Worker's code.</p>
			{#if collections.loaded}
				<RuleMatrix list={collections.list} />
			{:else if collections.error}
				<p class="error" data-testid="collections-error">{collections.error}</p>
			{/if}

			<h3>Invitations</h3>
			{#if access.created}
				<div class="token" role="status" data-testid="created-invite">
					<p>
						Invitation for <strong>{access.created.role}</strong>, valid until {access.created.expires}. Hand this
						token to the invitee now: it is not shown again.
					</p>
					<code data-testid="invite-token">{access.created.token}</code>
					<button type="button" onclick={dismissInvite}>Done</button>
				</div>
			{/if}
			<table data-testid="invites">
				<thead><tr><th>Id</th><th>Role</th><th>State</th><th>Expires</th><th></th></tr></thead>
				<tbody>
					{#each access.invites as invite (invite.id)}
						<tr data-invite={invite.id} data-state={invite.state}>
							<td><code>{invite.id}</code></td>
							<td>{invite.role}</td>
							<td>{invite.state}</td>
							<td>{invite.expires}</td>
							<td>
								{#if invite.state === "pending"}
									<button type="button" onclick={() => revokeInvite(invite.id)}>Revoke</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<form onsubmit={submit(() => createInvite(inviteRole, hours()))} data-testid="create-invite">
				<label>
					Role
					<select bind:value={inviteRole} required>
						{#each access.roles as role (role.name)}<option value={role.name}>{role.name}</option>{/each}
					</select>
				</label>
				<label>Hours valid <input bind:value={inviteHours} inputmode="numeric" placeholder="default" /></label>
				<button type="submit">Create invitation</button>
			</form>
		{:else if !access.error}
			<p>Loading…</p>
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
	form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.chip {
		margin-right: 0.5rem;
	}
	.token code {
		display: block;
		word-break: break-all;
		margin-block: 0.5rem;
	}
</style>
