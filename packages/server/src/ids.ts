import { randomUUID } from "node:crypto";

/** `<prefix>_<uuid>` id generator — used for every server-owned entity id (rejected-trigger ids, environment/deployment ids when the caller doesn't supply one, worker instance ids). Not used for run/step ids, which are the engine's to mint. */
export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
