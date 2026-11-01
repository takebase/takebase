import { createCollectionRegistry } from "@takebase/core";
import { notesCollection } from "./notes.ts";

export const collections = createCollectionRegistry([notesCollection]);
