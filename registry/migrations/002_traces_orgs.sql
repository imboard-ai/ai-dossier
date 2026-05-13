-- Team visibility: store the user's org memberships at write time so
-- other members of the same orgs can read the trace. Reads stay opt-in
-- (`?org=<name>`); writes/updates/deletes remain owner-scoped only.

ALTER TABLE traces ADD COLUMN IF NOT EXISTS orgs TEXT[];

CREATE INDEX IF NOT EXISTS traces_orgs_idx
  ON traces USING GIN (orgs);
