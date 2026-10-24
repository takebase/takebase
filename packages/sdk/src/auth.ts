// The part of a Firebase `Auth` instance the SDK uses. A real `getAuth()`
// instance fits this shape, so the SDK never imports Firebase. Signing in stays
// in the application with Firebase's own functions (signInWithPopup and so on);
// the SDK only reads the current user's ID token and follows user changes.
export type AuthUser = {
	readonly uid: string;
	getIdToken: (forceRefresh?: boolean) => Promise<string>;
};

export type FirebaseAuthLike = {
	readonly currentUser: AuthUser | null;
	onIdTokenChanged: (next: (user: { readonly uid: string } | null) => void) => () => void;
	signOut: () => Promise<void>;
};

// The bearer token for the next request, or null when signed out.
export type TokenSource = (forceRefresh: boolean) => Promise<string | null>;

export const tokenSource =
	(auth: FirebaseAuthLike): TokenSource =>
	async (forceRefresh) =>
		(await auth.currentUser?.getIdToken(forceRefresh)) ?? null;

const localHosts = ["localhost", "127.0.0.1", "[::1]"];

// Bearer tokens only travel over HTTPS (plain HTTP is allowed for local
// development hosts) to a bare origin and path, never with credentials, a
// query or a fragment in the URL. Returns the normalized base URL or null.
export const safeBaseUrl = (value: string) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const secure = url.protocol === "https:" || (url.protocol === "http:" && localHosts.includes(url.hostname));
	if (!secure || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
};
