import { applyD1Migrations, env } from "cloudflare:test";

// Setup files run outside per-test isolated storage, and may run multiple times.
// `applyD1Migrations()` only applies migrations that have not been applied yet,
// so it is safe to call this function here.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);