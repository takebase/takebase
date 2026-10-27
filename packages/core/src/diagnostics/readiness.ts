import type { Readiness, ReadinessState } from "@takebase/contracts";
import type { Logger } from "./log.ts";

// Dependency readiness, kept apart from liveness (`GET /health`). Each check
// runs concurrently under a time limit; a failure is logged with its reason
// and answered only as "error".

// True when the dependency answered; "unconfigured" for an optional one
// without settings.
export type ReadinessCheck = () => Promise<boolean | "unconfigured">;

const withTimeout = (check: ReadinessCheck, ms: number) =>
	Promise.race([
		check(),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
	]);

export const checkReadiness = async (
	service: string,
	checks: Record<string, ReadinessCheck>,
	log: Logger,
	timeoutMs = 3_000,
): Promise<Readiness> => {
	const results = await Promise.all(
		Object.entries(checks).map(async ([name, check]): Promise<[string, ReadinessState]> => {
			try {
				const result = await withTimeout(check, timeoutMs);
				if (result === "unconfigured") return [name, "unconfigured"];
				if (result) return [name, "ok"];
				log.warn("health.dependency_failed", { dependency: name });
			} catch (error) {
				log.warn("health.dependency_failed", { dependency: name, error });
			}
			return [name, "error"];
		}),
	);
	const states = results.map(([, state]) => state);
	const status = states.includes("error") ? "error" : states.includes("unconfigured") ? "degraded" : "ok";
	return { service, status, checks: Object.fromEntries(results) };
};
