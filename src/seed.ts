import { readFile } from "node:fs/promises";
import { pool } from "./db.js";

const ACTIVITY_ROWS = 1_000_000;
const STREAK_ROWS = 1_000_000;
const BATCH_SIZE = 100_000;

// Rows are generated server-side with generate_series, so each batch is one round trip
// instead of shipping 100k parameter tuples over the wire.
const insertActivities = `
  INSERT INTO user_activities (user_id, activity_type, metadata, created_at)
  SELECT
    1 + floor(random() * 100000)::int,
    (ARRAY['QUEST_COMPLETED','LOGIN','REWARD_CLAIMED','LEVEL_UP','ITEM_PURCHASED'])[1 + floor(random() * 5)::int],
    jsonb_build_object(
      'quest_id',   1 + floor(random() * 1000)::int,
      'difficulty', (ARRAY['easy','medium','hard'])[1 + floor(random() * 3)::int],
      'reward', jsonb_build_object(
        'type',   (ARRAY['xp','coins','badge'])[1 + floor(random() * 3)::int],
        'amount', 10 * (1 + floor(random() * 50)::int)
      )
    ),
    now() - random() * interval '365 days'
  FROM generate_series($1::int, $2::int)`;

// ~10% ACTIVE so the partial index covers a small slice of the table.
const insertStreaks = `
  INSERT INTO user_streaks (user_id, streak_count, status, last_updated_at)
  SELECT
    g,
    floor(random() * 365)::int,
    CASE WHEN random() < 0.1 THEN 'ACTIVE' ELSE 'INACTIVE' END,
    now() - random() * interval '90 days'
  FROM generate_series($1::int, $2::int) AS g`;

async function seedTable(name: string, sql: string, total: number) {
  const started = Date.now();
  for (let from = 1; from <= total; from += BATCH_SIZE) {
    const to = Math.min(from + BATCH_SIZE - 1, total);
    await pool.query(sql, [from, to]);
    process.stdout.write(`\r${name}: ${to.toLocaleString()} / ${total.toLocaleString()}`);
  }
  console.log(` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

const started = Date.now();
await pool.query(await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8"));
await seedTable("user_activities", insertActivities, ACTIVITY_ROWS);
await seedTable("user_streaks", insertStreaks, STREAK_ROWS);

// Fresh stats + visibility map, otherwise the planner guesses and index-only scans can't kick in.
console.log("VACUUM ANALYZE...");
await pool.query("VACUUM ANALYZE user_activities, user_streaks");

const { rows } = await pool.query(
  "SELECT (SELECT count(*) FROM user_activities) AS activities, (SELECT count(*) FROM user_streaks) AS streaks",
);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`, rows[0]);
await pool.end();
