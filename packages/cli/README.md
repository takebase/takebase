# @takebase/cli

The `takebase` command: generate a project, run it locally, deploy it and operate its tenants, users, secrets and backups.

> Not on a registry yet. The package is `private: true` at version 0.0.0, and it has no license yet. See [Installing](../../README.md#installing) in the root README.

Needs Node.js 24 or newer. `takebase dev` also needs the Firebase CLI and Java for the emulators; remote commands use your own Wrangler and Firebase logins.

## Commands

`takebase --help` lists every group, and `takebase <group> --help` its options.

| Group | Does |
| --- | --- |
| `create`, `init` | Generate a full starter project. Refuses a non-empty directory unless `--force` is given |
| `dev` | Run the local stack: emulators, Workers and the app. `--stop` frees its ports |
| `build` | Bundle every Worker and build the app |
| `deploy` | `--env <name> [--tenant <id>] (--plan \| --confirm <name>)`. A named tenant must be active |
| `doctor`, `health`, `logs` | Validate configuration, check every Worker, stream redacted logs |
| `user`, `role`, `invite` | Create and manage users, tenant roles and invitations |
| `tenant` | Create, provision, list, disable and delete tenants. `tenant user` manages members |
| `collection` | `create <name> --field <name:type[?]>`, `inspect <name>` |
| `migrate` | `generate --name <name>`, `inspect`, `apply`. Local databases only: `deploy` applies remote migrations |
| `wire` | Notification status, test delivery, retry dead events |
| `secrets` | `init`, `rotate`, `recover`, `check`, `status` |
| `backup` | `init`, `create`, `list [--tenant <id>]`, `verify`, `restore`, `prune` |

## Things it refuses on purpose

- `migrate apply --tenant` and `--remote`: `deploy` applies remote migrations.
- `backup restore` without `--dry-run` or `--confirm <env>`.
- Remote names outside the environment's `namePrefix`, and a login that cannot use its `CLOUDFLARE_ACCOUNT_ID`.
- There is no `secrets revoke`: `secrets rotate` retires the old key once every secret opens with the new one.
- Keys and passwords as arguments. `user create` writes a generated password to `--password-file` only, and secret values are never printed.

The root [README](../../README.md#cli) has the details of each group.
