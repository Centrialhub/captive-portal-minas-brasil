# Native PostgreSQL authorization contract tests

Run on Windows x64 with Node.js:

```powershell
Set-Location 'F:\captive MB\tests\database'
npm ci
npm test
```

This directory has its own pinned dependency manifest and lock file. It does not change the application dependencies. The runner starts the PostgreSQL 17.10 binaries shipped by `embedded-postgres@17.10.0-beta.17`, binds only to `127.0.0.1:55439`, and always stops its own cluster. It does not read environment database URLs, credentials, or production data. No Supabase connection is used.

Each run uses a new `data-*` directory under this directory. The data directories, `results.json`, and server log are ignored by Git and retained for inspection. Keep port 55439 available. The current harness deliberately targets Windows x64; a Linux/macOS port needs to select the corresponding packaged native binaries and remove the `.exe` suffix, retaining the loopback restriction.

`fixture.sql` reproduces the relevant published columns; `catalog.json` contains the actual constraints/indexes/triggers retrieved on 2026-09-25, without customer records. The runner applies these contracts and the complete new migration to a fresh native PostgreSQL database. Transactions, row locks, advisory locks, `SKIP LOCKED`, grants, triggers and rollback are real. Concurrency checks open independent PostgreSQL connections, including 20 simultaneous joins.

Vault encryption, pg_cron scheduling and pg_net HTTP are represented by local SQL stubs because their hosted extensions are not distributed with this PostgreSQL binary. The tests verify configuration, secret handling, dispatch arguments and the database watchdog around transport failure. They do **not** prove hosted scheduler cadence, Vault encryption, HTTP delivery, Edge behavior, UniFi authorization, or internet access. Those remain deployment/integration gates.

The suite checks atomic membership/session creation, parallel deduplication, lease fencing, ambiguous sends, immutable deadlines, late legacy writes, evidence validation, honest observed-only receipts, optional challenge races, daily quota, fixed abuse blocking, worker rollback and independently expiring work. It injects an audit failure to prove all terminal writes roll back together.
