import assert from "node:assert/strict";
import { pool } from "./db.js";

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] } & Record<string, unknown>;

const planShape = (n: PlanNode): string =>
  [n["Node Type"] + (n["Index Name"] ? ` (${n["Index Name"]})` : ""), ...(n.Plans ?? []).map(planShape)].join(" > ");

const RUNS = 5;

type Explained = { Plan: PlanNode; "Execution Time": number };

async function explain(variant: string, sql: string, params: unknown[] = []) {
  await pool.query(sql, params); // warm-up so both variants are measured with a warm cache
  const runs: Explained[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    runs.push(rows[0]["QUERY PLAN"][0]);
  }
  // Median run: sub-ms timings jitter a lot between single samples.
  runs.sort((a, b) => a["Execution Time"] - b["Execution Time"]);
  const { Plan, "Execution Time": ms } = runs[Math.floor(RUNS / 2)];
  return {
    variant,
    "time (ms)": ms,
    "buffers hit": Plan["Shared Hit Blocks"] as number,
    "buffers read": Plan["Shared Read Blocks"] as number,
    rows: Plan["Actual Rows"] as number,
    plan: planShape(Plan),
  };
}

function report(title: string, before: Awaited<ReturnType<typeof explain>>, after: typeof before) {
  console.log(`\n=== ${title} ===`);
  // Round for display only; the speedup uses the raw times.
  console.table([before, after].map((r) => ({ ...r, "time (ms)": r["time (ms)"].toFixed(3) })));
  console.log(`Speedup: ${(before["time (ms)"] / after["time (ms)"]).toFixed(1)}x`);
}

async function indexSize(name: string) {
  const { rows } = await pool.query("SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS size", [name]);
  return rows[0].size as string;
}

const { rows: [{ n }] } = await pool.query(
  "SELECT least((SELECT count(*) FROM user_activities), (SELECT count(*) FROM user_streaks))::int AS n",
);
assert.ok(n >= 1_000_000, `smallest table has ${n} rows, expected 1,000,000: run npm run seed`);

// 1. Pagination: OFFSET has to walk and discard 500k rows; keyset jumps straight there via the PK index.
{
  const OFFSET = 500_000;
  const offsetSql = "SELECT id, user_id, activity_type, created_at FROM user_activities ORDER BY id LIMIT 20 OFFSET $1";
  const keysetSql = "SELECT id, user_id, activity_type, created_at FROM user_activities WHERE id > $1 ORDER BY id LIMIT 20";
  // The cursor is the last id of the previous page, as a client would hold it.
  const { rows: [{ id: lastId }] } = await pool.query("SELECT id FROM user_activities ORDER BY id OFFSET $1 LIMIT 1", [OFFSET - 1]);

  const offsetPage = await pool.query(offsetSql, [OFFSET]);
  const keysetPage = await pool.query(keysetSql, [lastId]);
  assert.deepEqual(keysetPage.rows, offsetPage.rows, "keyset and offset must return the same page");

  report(
    `Pagination: LIMIT 20 OFFSET ${OFFSET.toLocaleString()} vs WHERE id > ${lastId}`,
    await explain("OFFSET", offsetSql, [OFFSET]),
    await explain("Keyset", keysetSql, [lastId]),
  );
}

// 2. JSONB containment: seq scan of every row vs GIN lookup.
{
  const sql = `SELECT id, user_id, created_at FROM user_activities WHERE metadata @> '{"quest_id": 42}'`;
  await pool.query("DROP INDEX IF EXISTS idx_activities_metadata_gin");
  const before = await explain("No index", sql);

  const t = Date.now();
  await pool.query("CREATE INDEX idx_activities_metadata_gin ON user_activities USING GIN (metadata)");
  console.log(`\nGIN index built in ${((Date.now() - t) / 1000).toFixed(1)}s, size ${await indexSize("idx_activities_metadata_gin")}`);
  const after = await explain("GIN index", sql);

  assert.equal(after.rows, before.rows, "index must not change the result");
  report(`JSONB: metadata @> '{"quest_id": 42}'`, before, after);
}

// 3. Partial index: only ~10% of streaks are ACTIVE, so the index stays small and pre-sorted.
{
  // id breaks ties (hundreds of streaks share the max), so the result is deterministic and comparable.
  const sql = "SELECT id, user_id, streak_count FROM user_streaks WHERE status = 'ACTIVE' ORDER BY streak_count DESC, id LIMIT 20";
  await pool.query("DROP INDEX IF EXISTS idx_streaks_active");
  const before = await explain("No index", sql);
  const rowsBefore = (await pool.query(sql)).rows;

  await pool.query("CREATE INDEX idx_streaks_active ON user_streaks (streak_count DESC, id) WHERE status = 'ACTIVE'");
  console.log(`\nPartial index size ${await indexSize("idx_streaks_active")} (covers ACTIVE rows only)`);
  const after = await explain("Partial index", sql);

  assert.deepEqual((await pool.query(sql)).rows, rowsBefore, "index must not change the result");
  report("Partial index: top 20 ACTIVE streaks", before, after);
}

await pool.end();
