import { Buffer } from "node:buffer";
import { HttpFailure } from "./errors.ts";

export interface NewCapability {
  token: string;
  hash: Buffer;
}


export async function createCapability(): Promise<NewCapability> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return { token, hash: Buffer.from(digest) };
}

export async function capabilityHash(authorization: string | null): Promise<Buffer> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (!token) throw new HttpFailure(404, "JOB_NOT_FOUND");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest);
}

export function operatorAuthorized(authorization: string | null, expected: string | undefined): boolean {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/u)?.[1];
  if (!token || !expected || token.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < token.length; index++) difference |= token.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
