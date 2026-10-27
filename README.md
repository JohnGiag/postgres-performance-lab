# PostgreSQL Performance & Indexing Lab

Seeds 1,000,000 rows each into `user_activities` and `user_streaks`, then uses `EXPLAIN (ANALYZE, BUFFERS)` to compare:

- **Pagination**: `LIMIT 20 OFFSET 500000` vs keyset `WHERE id > last_id LIMIT 20`
- **JSONB search**: `metadata @> '{"quest_id": 42}'` without an index vs with `USING GIN (metadata)`
- **Partial index**: top 20 `ACTIVE` streaks without an index vs with an index on `(streak_count DESC, id) WHERE status = 'ACTIVE'`

## Prerequisites

- Docker (Docker Desktop on Windows/macOS)
- Node.js 20+

## Run it

```bash
npm install
npm run db:up       # starts Postgres 17 on localhost:5433 and waits until it is healthy
npm run seed        # drops and recreates both tables, inserts 2M rows (~10s)
npm run benchmark   # prints a table per comparison
```

`npm run db:down` stops the container. The data stays in the `pgdata` volume. Use `docker compose down -v` to delete it.

To use a different database, set `DATABASE_URL`. The default is `postgres://lab:lab@localhost:5433/perf_lab`. The seed drops `user_activities` and `user_streaks`, so only point this at a throwaway database.

## Layout

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Postgres 17 with a persistent volume, 1 GB shared memory, and tuning for local use (`shared_buffers`, `work_mem`, `synchronous_commit=off`, `jit=off`, `track_io_timing`) |
| `sql/schema.sql` | Table definitions, reapplied on every seed |
| `src/seed.ts` | Batched `INSERT ... SELECT FROM generate_series` with 100k rows per batch. The rows are generated inside Postgres, so each batch is a single round trip. Ends with `VACUUM ANALYZE`. |
| `src/benchmark.ts` | Runs each query once to warm the cache, then runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 5 times. It reports the median execution time, plus shared buffers hit/read, row count and plan shape. Each run drops and rebuilds its indexes, so you can run it again at any time. |

The benchmark also checks its own results: the keyset page must equal the offset page, the JSONB search must return the same number of rows with and without the index, and the top 20 streaks (ties broken by `id`) must be the same rows with and without the partial index. If the tables aren't fully seeded, it stops and tells you to run `npm run seed`.

## Sample results

Measured on 2026-10-27 with a warm cache, median of 5 runs: PostgreSQL 17.11 (`postgres:17` image) on Docker Desktop, Windows 11. The machine has an AMD Ryzen 7 6800H and 16 GB RAM; the Docker VM had 16 CPUs and ~7.4 GB.

| Comparison | Buffers before → after | Before | After | Speedup |
|---|---|---|---|---|
| OFFSET 500k vs keyset | 12,124 → 5 | 89.7 ms (Index Scan through 500k rows) | 0.019 ms | ~4700x |
| JSONB `@>` without vs with GIN | 21,271 → 1,237 | 88.9 ms (parallel Seq Scan) | 4.6 ms (Bitmap Index Scan) | ~20x |
| Top ACTIVE streaks without vs with partial index | 8,347 → 23 | 34.8 ms (Seq Scan + Sort) | 0.022 ms (Index Scan) | ~1600x |

What the numbers show:

- **OFFSET** still reads and throws away every skipped row, so it gets slower the deeper you page. Keyset pagination goes straight to the cursor through the primary key index, so its cost stays the same on any page.
- **GIN** indexes every key/value pair in the JSONB. Here the index is 14 MB and takes about 2.5s to build. In exchange, a `@>` query reads about 1k buffers instead of the whole table.
- **The partial index** only covers the ~10% of rows that are `ACTIVE`, so it is about 3 MB. It is stored already sorted by `streak_count DESC, id`, so "top 20" reads just 20 entries and needs no sort step.

Your timings will differ. Speedups for queries under 0.1 ms change a lot between runs, because a few microseconds is a big share of the total. The seed data is random, so row counts also vary slightly between seeds. The buffer counts are the most stable number to compare between machines.

## License

[MIT](LICENSE)
