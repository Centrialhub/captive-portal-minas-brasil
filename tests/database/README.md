# Native PostgreSQL authorization contract tests

Run on Windows x64 with Node.js:

```powershell
Set-Location 'F:\captive MB\tests\database'
npm ci
npm test
```

This directory has its own pinned dependency manifest and lock file. It does not change the application dependencies. The runner starts the PostgreSQL 17.10 binaries shipped by `embedded-postgres@17.10.0-beta.17`, binds only to `127.0.0.1:55439`, and always stops its own cluster. It does not read environment database URLs, credentials, or production data. No Supabase connection is used.

Each run uses a uniquely created `data-*` directory under this directory. Before any database write, every connection checks read-only `SHOW data_directory` against that new directory's resolved absolute path, verifies that this run's PostgreSQL child is alive and checks its PID against the new directory's `postmaster.pid`. A different server answering port 55439 is rejected before fixtures, migrations, or tests can run. Spawn errors and early exits abort setup. Cleanup targets only the live child and its matching data directory; it never stops PostgreSQL by the shared port.

The data directories, `results.json`, and server log are ignored by Git and retained for inspection. Keep port 55439 available. A port-conflict run exits 1, leaves the existing cluster running and does not overwrite a prior `results.json`; check its timestamp rather than treating old results as a new run. The current harness deliberately targets Windows x64; a Linux/macOS port needs to select the corresponding packaged native binaries and remove the `.exe` suffix, retaining the loopback and process/directory identity checks.

This guard was verified on 2026-09-25 with a separate disposable PostgreSQL cluster occupying 55439: the runner exited 1 with `HARNESS_CLUSTER_MISMATCH`; that server logged only `SHOW data_directory` from the runner, retained its original start time, role/schema/object counts and sentinel value, and remained running. The controller of that separate probe stopped its own cluster afterward. This is harness infrastructure validation and does not count as a product defect or change the product-test totals.

`fixture.sql` reproduces the relevant published columns; `catalog.json` contains the actual constraints/indexes/triggers retrieved on 2026-09-25, without customer records. The runner applies these contracts and the complete new migration to a fresh native PostgreSQL database. Transactions, row locks, advisory locks, `SKIP LOCKED`, grants, triggers and rollback are real. Concurrency checks open independent PostgreSQL connections, including 20 simultaneous joins.

Vault encryption, pg_cron scheduling and pg_net HTTP are represented by local SQL stubs because their hosted extensions are not distributed with this PostgreSQL binary. The tests verify configuration, secret handling, dispatch arguments and the database watchdog around transport failure. They do **not** prove hosted scheduler cadence, Vault encryption, HTTP delivery, Edge behavior, UniFi authorization, or internet access. Those remain deployment/integration gates.

The suite checks atomic membership/session creation, parallel deduplication, lease fencing, ambiguous sends, immutable deadlines, late legacy writes, evidence validation, honest observed-only receipts, optional challenge races, daily quota, fixed abuse blocking, worker rollback and independently expiring work. It injects an audit failure to prove all terminal writes roll back together.

## Adversarial findings and release gate

The additional synthetic probes in `run.mjs` assert the intended invariants even when the currently applied SQL violates them. Each adversarial failure is collected, the remaining probes run, and `results.json` includes `adversarialFailures` and `observations`. The runner exits **1** when any invariant fails and still stops its PostgreSQL cluster. Do not turn these assertions into expected-failure passes or remove them to release. An unhandled fixture/setup error also exits 1 and may prevent a fresh result file; check the process exit and result timestamp together.

The three expiry-during-lock probes use a 1,000 ms validity window, verify the lock wait through `pg_stat_activity`, then hold the lock for another 1,100 ms. If the expected wait is never observed, `PROBE_SETUP_ERROR` aborts the run instead of being counted as a product-invariant violation. This distinguishes scheduling/setup problems from a measured defect.

The 2026-09-25 findings are documented in `docs/synthetic-database-findings.md` at the repository root. They are local reproductions, not evidence of those failures occurring in production. Applied migrations remain unchanged in this testing round; any SQL fix requires a new migration and another complete run.

Fault triggers and held lock transactions are removed/released in `finally` blocks. The participant corruption probe explicitly bypasses a guard as the isolated database owner and restores it immediately: that test checks containment, not the reachability of such corruption through a public API. Other probes use regular RPCs with controlled fixture timestamps and real independent connections.

Capacity probes keep the production SQL functions intact and advance ten synthetic seconds by aging only their own operation/outbox timestamps. A four-client control must pass. The 40-client queued burst and 40-client accepted burst use a four-operation cron batch, ten-second ticks, two-second verification scheduling and the coordinator's 16-second minimum lease budget. Controller send/read outcomes are modeled as immediate success; no HTTP/controller is contacted. This isolates scheduler capacity and ordering, without claiming to simulate real network timing or production demand.
