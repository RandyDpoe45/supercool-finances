// SuperCool Finances — idempotent demo-data seed (spec 08, §Seed data).
//
// ATOMIC tool (ADR-16): this imports NO balance-service code. The balance schema it
// writes to is DUPLICATED here and kept in sync via specs/08-build-and-serve.md — the
// contract of record. It touches ONLY the demo customers and their accounts; it NEVER
// inserts or modifies the MXN `currency` row, the clearing/system accounts, or any
// `user_limits` row — those are SYSTEM CONSTANTS seeded by boot MIGRATIONS.
//
// Idempotent: customers `ON CONFLICT (id) DO NOTHING`, accounts
// `ON CONFLICT (account_number) DO NOTHING`, so a re-run changes nothing. Exits 0 on
// success, non-zero on a real error.

import pg from 'pg';

const { Client } = pg;

// --- Demo dataset — the shared contract from spec 08 (§Seed data / Demo dataset) ----

// Customer A is the login: its `id` IS the pinned Keycloak `sub` from realm-export.json
// (so account.owner_id -> this id lines up with the token's sub). Customer B has NO
// Keycloak login; its id is a synthetic UUID — it exists as a confirmation-of-payee
// transfer target for the demo.
const CUSTOMERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo Customer',
    phone: '5510000001',
    email: 'demo-customer@example.test',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    name: 'Maria Gonzalez',
    phone: '5520000002',
    email: 'maria.gonzalez@example.test',
  },
];

// One active MXN customer account each. Money (`balance`) is bigint minor units passed
// as a STRING — never float arithmetic. `held` and the spend counters start at 0 and
// the fixed-window markers start at the DB's CURRENT_DATE (supplied in SQL below, not
// as a parameter, so it is the database's notion of "today"). account.id uses the DB
// default (gen_random_uuid()).
const ACCOUNTS = [
  { ownerId: CUSTOMERS[0].id, accountNumber: '1000000001', balance: '100000000' },
  { ownerId: CUSTOMERS[1].id, accountNumber: '1000000002', balance: '50000000' },
];

const CURRENCY = 'MXN';

// Connection resilience: balance-service's `service_healthy` gate already guarantees
// Postgres is up and migrated before this runs, so these are a thin safety net for the
// brief readiness race, not a substitute for the dependency.
const CONNECT_ATTEMPTS = 10;
const CONNECT_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

// Discrete credentials ONLY — the tool composes its own connection internally from the
// same DB_* var names balance-service uses. No *_URL connection string is ever read.
function buildClientConfig() {
  const rawPort = requireEnv('DB_PORT');
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port)) {
    throw new Error(`DB_PORT must be an integer (got "${rawPort}")`);
  }
  return {
    host: requireEnv('DB_HOST'),
    port,
    database: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
  };
}

async function connectWithRetry(config) {
  let lastError;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const client = new Client(config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      console.warn(
        `[seed] connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed: ${error.message}`,
      );
      if (attempt < CONNECT_ATTEMPTS) {
        await sleep(CONNECT_DELAY_MS);
      }
    }
  }
  throw new Error(
    `Could not connect to Postgres after ${CONNECT_ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

// Returns true if a row was inserted, false if it already existed (conflict skipped).
async function upsertCustomer(client, customer) {
  const result = await client.query(
    `INSERT INTO "customer" ("id", "name", "phone", "email")
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("id") DO NOTHING
     RETURNING "id"`,
    [customer.id, customer.name, customer.phone, customer.email],
  );
  return result.rowCount > 0;
}

async function upsertAccount(client, account) {
  const result = await client.query(
    `INSERT INTO "account"
       ("owner_id", "kind", "system_key", "currency", "account_number", "status",
        "balance", "held", "spent_today", "spent_today_date", "spent_month", "spent_month_date")
     VALUES
       ($1, 'customer', NULL, $2, $3, 'active',
        $4, 0, 0, CURRENT_DATE, 0, CURRENT_DATE)
     ON CONFLICT ("account_number") DO NOTHING
     RETURNING "id"`,
    [account.ownerId, CURRENCY, account.accountNumber, account.balance],
  );
  return result.rowCount > 0;
}

async function main() {
  const config = buildClientConfig();
  console.log(
    `[seed] connecting to postgres ${config.host}:${config.port}/${config.database} as ${config.user}`,
  );
  const client = await connectWithRetry(config);

  const summary = {
    customersInserted: 0,
    customersSkipped: 0,
    accountsInserted: 0,
    accountsSkipped: 0,
  };

  try {
    // One transaction: customers BEFORE accounts (FK account.owner_id -> customer.id),
    // so a newly inserted customer is visible to its account insert in the same tx.
    await client.query('BEGIN');

    for (const customer of CUSTOMERS) {
      if (await upsertCustomer(client, customer)) {
        summary.customersInserted += 1;
        console.log(`[seed] customer INSERTED  ${customer.id}  (${customer.name})`);
      } else {
        summary.customersSkipped += 1;
        console.log(`[seed] customer exists    ${customer.id}  (${customer.name}) — skipped`);
      }
    }

    for (const account of ACCOUNTS) {
      if (await upsertAccount(client, account)) {
        summary.accountsInserted += 1;
        console.log(
          `[seed] account  INSERTED  ${account.accountNumber}  owner ${account.ownerId}  balance ${account.balance}`,
        );
      } else {
        summary.accountsSkipped += 1;
        console.log(`[seed] account  exists    ${account.accountNumber} — skipped`);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }

  console.log(
    `[seed] done — customers: ${summary.customersInserted} inserted, ${summary.customersSkipped} skipped; ` +
      `accounts: ${summary.accountsInserted} inserted, ${summary.accountsSkipped} skipped.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[seed] FAILED: ${error.message}`);
    process.exit(1);
  });
