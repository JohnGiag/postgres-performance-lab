-- Recreated from scratch on every `npm run seed`.
DROP TABLE IF EXISTS user_activities, user_streaks;

CREATE TABLE user_activities (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER      NOT NULL,
  activity_type VARCHAR(32)  NOT NULL,
  metadata      JSONB        NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE user_streaks (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER     NOT NULL,
  streak_count    INTEGER     NOT NULL DEFAULT 0,
  status          VARCHAR(8)  NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
