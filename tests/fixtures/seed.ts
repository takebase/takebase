import { seed } from "./tenants.ts";

// `pnpm dev:stack` runs `takebase dev --fresh --seed 'node tests/fixtures/seed.ts'`:
// the fixture users and memberships, once both tenants are provisioned.

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Run this through `pnpm dev:stack`");
const uids = await seed();
console.log(`fixture users seeded: ${Object.keys(uids).join(", ")}`);
