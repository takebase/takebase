import { createCollectionRegistry } from "@takebase/core";
import { agents } from "../schema/agents.ts";
import { policiesCollection } from "./policies.ts";

// `tables` lists plain tables that unique/exists rules may reference.
export const collections = createCollectionRegistry([policiesCollection], { tables: [agents] });
