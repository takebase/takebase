import { useEdge } from "#lib/edge.ts";
import { loadPolicies } from "./store.svelte.ts";

// Refetches the policies list on every change signal for the selected tenant.
// The first call (catch-up) also comes right after subscribing and after each
// reconnect, so a missed signal cannot leave the list behind. The SDK coalesces
// bursts and ends the subscription on a tenant switch or sign-out.
export const watchPolicies = () =>
	useEdge()
		.client.collection("policies")
		.subscribe("*", () => void loadPolicies());
