import { Pool, type PoolClient } from "pg";
import type { Env } from "./env.ts";

export function database(env: Env): Pool {
  const connectionString = env.HYPERDRIVE?.connectionString
    ?? (env.APP_ENV === "development" ? env.LOCAL_DATABASE_URL : undefined);
  if (!connectionString) throw new Error("DATABASE_BINDING_UNAVAILABLE");
  // Pools and their pending connections must not cross Worker request contexts.
  return new Pool({ connectionString, max: 1, maxUses: 1, idleTimeoutMillis: 5_000 });
}

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
