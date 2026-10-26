import type { TakebaseError, TenantMembership } from "@takebase/sdk";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { useEdge } from "#lib/edge.ts";
import { watchPolicies } from "./policies/realtime.ts";
import { loadPolicies, resetPolicies } from "./policies/store.svelte.ts";

// Who is signed in, their tenants and the selected one. It owns the realtime
// lifecycle: one policies subscription per selected tenant, ended on a switch
// or sign-out, and all app state cleared whenever the SDK signs out.
export const session = $state({
	phase: "starting" as "starting" | "signed-out" | "signed-in",
	email: null as string | null,
	tenants: [] as TenantMembership[],
	tenant: null as TenantMembership | null,
	error: null as string | null,
	notice: null as string | null,
});

let unwatch: (() => void) | null = null;

const stopWatching = () => {
	unwatch?.();
	unwatch = null;
};

const clear = () => {
	stopWatching();
	resetPolicies();
	session.email = null;
	session.tenants = [];
	session.tenant = null;
	session.error = null;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Called once by the root page; returns the cleanup.
export const startSession = () => {
	const { auth, client } = useEdge();
	const stopSignedOut = client.auth.onSignedOut((reason) => {
		clear();
		session.phase = "signed-out";
		if (reason === "access_revoked") session.notice = "Your access to a tenant was removed, so you were signed out.";
	});
	const stopAuth = onAuthStateChanged(auth, async (user) => {
		if (!user) {
			clear();
			session.phase = "signed-out";
			return;
		}
		session.email = user.email;
		session.phase = "signed-in";
		try {
			const tenants = await client.auth.getTenants();
			// Dropped if the user changed while the list was loading.
			if (auth.currentUser?.uid === user.uid) session.tenants = tenants;
		} catch (error) {
			if (auth.currentUser?.uid === user.uid) session.error = message(error);
		}
	});
	return () => {
		stopAuth();
		stopSignedOut();
		stopWatching();
	};
};

export const signIn = async (email: string, password: string) => {
	session.error = null;
	session.notice = null;
	try {
		await signInWithEmailAndPassword(useEdge().auth, email, password);
	} catch (error) {
		session.error = message(error);
	}
};

export const signOut = () => useEdge().client.auth.signOut();

export const selectTenant = async (id: string) => {
	stopWatching();
	resetPolicies();
	session.tenant = null;
	session.error = null;
	try {
		session.tenant = await useEdge().client.useTenant(id);
	} catch (error) {
		// A newer selection or a sign-out replaced this one.
		if ((error as TakebaseError | null)?.code !== "tenant_changed") session.error = message(error);
		return;
	}
	void loadPolicies();
	unwatch = watchPolicies();
};
