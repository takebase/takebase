// Database Security Rules for one tenant's Realtime Database, rendered with
// that tenant's dispatcher uid. The layout (see README.md):
//
//   /collections/{name}    = { revision }      dispatcher writes; never decreases
//   /access/members/{uid}  = { rev }           dispatcher writes; the user may only delete it
//   /access/revoked/{uid}  = rev               dispatcher writes; never decreases
//   /access/revoked/_tenant = rev              revokes every grant up to rev
//   /presence/{uid}        = { online, lastSeen }  the member themself, server time only
//
// Everything else is denied. A grant counts only when its rev is newer than the
// user's and the tenant's last revocation, so a stale grant loses to any
// revocation written before it.

// Marks the tenant-wide revocation under /access/revoked; never a user id.
export const TENANT_REVOCATION = "_tenant";

// Firebase uids are generated as letters and digits; anything else would be
// unsafe to embed in a rule expression.
const uidPattern = /^[A-Za-z0-9]{1,128}$/;

export const isDispatcherUid = (uid: unknown): uid is string => typeof uid === "string" && uidPattern.test(uid);

export const databaseRules = (dispatcherUid: string) => {
	if (!isDispatcherUid(dispatcherUid)) throw new TypeError("dispatcher uid must be 1-128 letters or digits");
	const dispatcher = `auth != null && auth.uid === '${dispatcherUid}'`;
	const members = "root.child('access').child('members')";
	const revoked = "root.child('access').child('revoked')";
	const member = `auth != null && ${members}.child(auth.uid).exists()`;
	const newerThan = (key: string) =>
		`(!${revoked}.child(${key}).exists() || newData.child('rev').val() > ${revoked}.child(${key}).val())`;

	return {
		rules: {
			".read": false,
			".write": false,
			collections: {
				".read": `(${member}) || (${dispatcher})`,
				$collection: {
					".write": dispatcher,
					".validate":
						"newData.hasChildren(['revision']) && (!data.exists() || newData.child('revision').val() > data.child('revision').val())",
					revision: { ".validate": "newData.isNumber() && newData.val() > 0" },
					$other: { ".validate": false },
				},
			},
			access: {
				".read": dispatcher,
				members: {
					// Only the dispatcher may clear every grant at once (revokeAll).
					".write": `${dispatcher} && !newData.exists()`,
					$uid: {
						// The SDK watches its own entry to sign out when it disappears.
						".read": "auth != null && auth.uid === $uid",
						".write": `${dispatcher} || (auth != null && auth.uid === $uid && !newData.exists())`,
						".validate": `newData.hasChildren(['rev']) && $uid !== '${TENANT_REVOCATION}' && ${newerThan("$uid")} && ${newerThan(`'${TENANT_REVOCATION}'`)}`,
						rev: { ".validate": "newData.isNumber()" },
						$other: { ".validate": false },
					},
				},
				revoked: {
					$key: {
						".write": dispatcher,
						".validate": "newData.isNumber() && (!data.exists() || newData.val() >= data.val())",
					},
				},
			},
			presence: {
				".read": member,
				".write": `${dispatcher} && !newData.exists()`,
				$uid: {
					".write": `(auth != null && auth.uid === $uid && ${members}.child($uid).exists()) || (${dispatcher} && !newData.exists())`,
					".validate": "newData.hasChildren(['online', 'lastSeen'])",
					online: { ".validate": "newData.isBoolean()" },
					lastSeen: { ".validate": "newData.val() === now" },
					$other: { ".validate": false },
				},
			},
		},
	};
};
