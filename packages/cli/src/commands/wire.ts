import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import { loadProjectConfig, resolveEnvironment } from "../project-config.ts";
import {
	type DeliveryResult,
	maxRetryEvents,
	type WireStatus,
	wireDeps,
	wireRetry,
	wireStatus,
	wireTest,
} from "../services/wire.ts";

const usage = `takebase wire status <tenant> [--env <name>]
       takebase wire test <tenant> [--env <name>]
       takebase wire retry <tenant> (--event <id>... | --dead) [--env <name>]`;

const help = `Inspect and repair a tenant's realtime notification delivery.

Usage: ${usage}

Commands:
  status   Outbox counts, the oldest pending event, dead events (newest ${maxRetryEvents})
           and the realtime revocations global D1 still owes the tenant
  test     Deliver whatever is pending once (dispatch, then reconcile)
  retry    Give dead events a fresh attempt budget, then deliver with retries

Options:
  --env <name>   Environment from takebase.jsonc (default: local)
  --event <id>   A dead event to retry (repeatable, at most ${maxRetryEvents})
  --dead         Retry every dead event
  -h, --help     Show this help

Delivery only republishes collection revision numbers; clients refetch records
through the collection rules, so a retry never exposes a record. Output shows
delivery metadata only. Locally, run \`takebase dev\` first.
`;

const options = {
	env: { type: "string" },
	event: { type: "string", multiple: true },
	dead: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

const printStatus = (io: CliIo, tenantId: string, status: WireStatus) => {
	const { counts, oldestPending, dead, revocations } = status;
	io.stdout(
		`Tenant ${tenantId} outbox: ${counts.pending} pending, ${counts.delivered} delivered, ${counts.dead} dead` +
			`${oldestPending === null ? "" : `; oldest pending since ${oldestPending}`}\n`,
	);
	io.stdout(
		`Realtime revocations owed: ${revocations.tenant === null ? "no tenant-wide" : `tenant-wide at rev ${revocations.tenant}`}, ${revocations.members} member(s)\n`,
	);
	if (dead.length === 0) return;
	io.stdout("Dead events (newest first):\n");
	for (const event of dead) {
		io.stdout(
			`  ${event.id}  seq ${event.seq}  ${event.collection} ${event.operation}  ${event.attempts} attempts  created ${event.created}\n`,
		);
	}
};

const printDelivery = (io: CliIo, tenantId: string, result: DeliveryResult) => {
	io.stdout(
		`Delivery: dispatch HTTP ${result.dispatch}, reconcile HTTP ${result.reconcile}; ` +
			`${result.delivered} delivered, ${result.failed} failed in ${result.attempts} attempt(s)\n`,
	);
	printStatus(io, tenantId, result.status);
	const owed =
		result.status.counts.pending +
		result.status.revocations.members +
		(result.status.revocations.tenant === null ? 0 : 1);
	if (result.dispatch === 200 && result.reconcile === 200 && owed === 0) return 0;
	throw new CliError("Some notifications are still pending", {
		hint:
			result.dispatch === 0 || result.reconcile === 0
				? "The tenant Worker did not answer; check `takebase health`, then run this again."
				: "Run `takebase wire retry` again later; events that keep failing end up dead.",
	});
};

export const wireCommand = async (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("wire", args, options);
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const [subcommand, tenantId, ...extra] = positionals;
	if (subcommand === undefined || !["status", "test", "retry"].includes(subcommand)) {
		throw new CliError(subcommand === undefined ? "Missing wire command" : `Unknown wire command "${subcommand}"`, {
			usage: true,
			hint: `Usage: ${usage}`,
		});
	}
	if (tenantId === undefined) throw new CliError("Missing tenant", { usage: true, hint: `Usage: ${usage}` });
	if (extra.length > 0) {
		throw new CliError(`Unexpected arguments: ${extra.join(" ")}`, { usage: true, hint: `Usage: ${usage}` });
	}
	const events = values.event ?? [];
	if (subcommand !== "retry" && (events.length > 0 || values.dead === true)) {
		throw new CliError("--event and --dead are only for wire retry", { usage: true, hint: `Usage: ${usage}` });
	}
	if (subcommand === "retry" && events.length > 0 === (values.dead === true)) {
		throw new CliError("wire retry needs either --event <id>... or --dead", { usage: true, hint: `Usage: ${usage}` });
	}
	const project = loadProjectConfig(io.cwd);
	const environment = resolveEnvironment(project, values.env);
	const deps = wireDeps(project, environment, tenantId);

	if (subcommand === "status") {
		printStatus(io, tenantId, wireStatus(deps, tenantId));
		return 0;
	}
	if (subcommand === "test") return printDelivery(io, tenantId, await wireTest(deps, tenantId));
	const result = await wireRetry(deps, tenantId, events.length > 0 ? { ids: events } : { dead: true });
	io.stdout(`Revived ${result.revived} dead event(s).\n`);
	return printDelivery(io, tenantId, result);
};
