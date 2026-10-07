# Tenant dashboard: persisted monthly metrics

`GET /api/v1/tenant/dashboard-stats?mes=YYYY-MM`

- Requires the existing tenant JWT and an activated tenant. The tenant scope comes only from the authenticated token; a query/body tenant ID cannot change it.
- `mes` is optional. Without it, the service selects the current business month in `America/Sao_Paulo`. Invalid, empty or repeated values return HTTP 400 with `INVALID_DASHBOARD_MONTH`.
- `stats.periodo` returns `mes`, `mes_anterior`, `timezone` and `escopo_pendencias: "ATUAL"`.
- `total_averbacoes`, `total_recusadas`, `valor_total_averbado`, `comparacoes` and `ultimas_averbacoes` apply to the selected calendar month, using each record's `created_at` in the business timezone. Invalid/future timestamps are excluded. No pagination limit applies to the aggregates.
- Only `SUCESSO` contributes to accepted counts/values; only `ERRO` contributes to refused counts. Cancellation and approval/dispatch pending states are not silently counted as accepted or refused.
- Comparisons use the previous complete calendar month. For an unfinished current month, the current month-to-date is compared to the previous complete month. The existing zero-baseline convention remains 0% for 0→0 and 100% for 0→positive.
- Latest records are the five most recent successes in the selected month, ordered before limiting. Related policy fields are resolved only within the same tenant. The explicit response projection excludes raw XML and recovery tokens.
- `total_pendentes_recuperacao` and `solicitacoes_regras_pendentes` are current work queues even when viewing a historical month. They are not historical queue snapshots. Expired/used recovery sessions do not contribute.
- `alertas` remains empty: this change does not fabricate alert data or add an alert integration.

## Compatibility

Existing field names are preserved. The three total metric fields previously described all stored history despite monthly UI labels; they now describe the selected month. Deploy together with the Cargo monthly-dashboard companion after reviewing existing security prerequisite PRs. Older clients without `mes` receive the current month's totals.

The endpoint reads the existing `dbStore` source of truth (in-memory state persisted to `data_store.json`). PostgreSQL remains the existing optional asynchronous mirror, not a new source of truth. This PR introduces no migration, new infrastructure, credentials or production data access.

## Verification

The HTTP contract test uses the real Express route and JWT middleware with isolated synthetic storage. It covers month boundaries in São Paulo, cross-tenant isolation, ordering before limiting, closed-month/current-queue distinctions, January rollover, malformed query values, non-activated/unknown tenants and field redaction. Aggregate tests and build should be run before merging. Browser/end-to-end portal verification belongs to the Cargo companion.
