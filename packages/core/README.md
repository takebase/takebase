# @takebase/core

The Takebase server framework for Cloudflare Workers: collections with server-enforced rules and Laravel-style validation, tenant membership checks, an outbox for realtime signals, encrypted secrets and health checks.

> Not on a registry yet. The package is `private: true` at version 0.0.0, and it has no license yet. See [Installing](../../README.md#installing) in the root README.

## Define a collection

Tables are declared with `@takebase/core/schema`, so your code imports no ORM. Rules run on the server and deny by default: an operation with no rule is refused.

```ts
import { defineCollection, deny, hasRole, tenantMember } from "@takebase/core";
import { id, integer, sqliteTable, text, timestamps } from "@takebase/core/schema";

export const notes = sqliteTable("notes", {
	...id(),
	title: text("title").notNull(),
	done: integer("done", { mode: "boolean" }).notNull(),
	...timestamps(),
});

export const notesCollection = defineCollection({
	table: notes,
	rules: {
		list: tenantMember(),
		view: tenantMember(),
		create: hasRole("editor"),
		update: hasRole("editor"),
		delete: deny(),
	},
	validate: {
		title: "required|string|max:200",
		done: "required|boolean",
	},
	sorts: ["created"],
});
```

Invalid input gets a 422 with one message per field. `takebase collection create` writes these two files for you, and `takebase migrate generate` turns schema changes into D1 migrations.

## Entry points

| Import | Contents |
| --- | --- |
| `@takebase/core` | `defineCollection`, rule builders, collection routes, authentication and membership, secrets, realtime dispatch, health |
| `@takebase/core/schema` | Table builders (`sqliteTable`, `text`, `integer`, `real`, `blob`, `index`, `uniqueIndex`, `primaryKey`, `foreignKey`), `id()`, `timestamps()`, and the type `CollectionFields<Table>` |

`takebase create` generates complete global and tenant Workers that wire these together. `workers/tenant/src/app.ts` in a generated project is the place to start.

## Limits

- Built for Workers with the `nodejs_als` compatibility flag. Other runtimes are not supported.
- The Drizzle dependency is pinned to one exact version. `@takebase/core/schema` hides the import, not Drizzle's behaviour: the builders are Drizzle's own.
