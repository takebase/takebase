import type { TakebaseError, TenantMembership } from "@takebase/sdk";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { useEdge } from "#lib/edge.ts";

// Who is signed in, their tenants and the selected one. This store owns the
// admin's whole lifecycle: the other stores register a reset here, and every
// one of them runs on a tenant switch and on any SDK sign-out (including
// revocation), so nothing from a previous tenant or user stays on screen.
export const session = $state({
	phase: "starting" as "starting" | "signed-out" | "signed-in",
	email: null as string | null,
	tenants: [] as TenantMembership[],
	tenant: null as TenantMembership | null,
	error: null as string | null,
	notice: null as string | null,
});

const resets = new Set<() => void>();

// Registers state to clear on a tenant switch or sign-out; returns the unregister.
export const onReset = (reset: () => void) => {
	resets.add(reset);
	return () => resets.delete(reset);
};

const resetTenantState = () => {
	for (const reset of resets) reset();
};

const clear = () => {
	resetTenantState();
	session.email = null;
	session.tenants = [];
	session.tenant = null;
	session.error = null;
};

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Whether the selected tenant lists the admin role. Display only: the Workers
// decide every admin request.
export const isTenantAdmin = () => session.tenant?.roles.includes("admin") === true;

// Called once by the root layout; returns the cleanup.
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
		resetTenantState();
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
	resetTenantState();
	session.tenant = null;
	session.error = null;
	try {
		session.tenant = await useEdge().client.useTenant(id);
	} catch (error) {
		// A newer selection or a sign-out replaced this one.
		if ((error as TakebaseError | null)?.code !== "tenant_changed") session.error = message(error);
	}
};
