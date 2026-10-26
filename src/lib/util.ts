import crypto from "node:crypto";

export function newId(): string {
  return crypto.randomUUID();
}

/** Single timestamp format for every table: ISO-8601 UTC. */
export function now(): string {
  return new Date().toISOString();
}
