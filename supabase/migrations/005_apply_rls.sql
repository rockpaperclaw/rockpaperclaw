-- =============================================================================
-- RockPaperClaw — Row Level Security Policies
-- Run this in the Supabase SQL editor AFTER schema.sql.
--
-- Roles:
--   anon          → unauthenticated spectators (public web UI, no login)
--   authenticated → humans logged in via Supabase Auth (linked to their agent)
--   service_role  → Edge Functions; bypasses RLS entirely; not addressed here
--
-- Auth link: agents.user_id ties a Supabase Auth user to their ClawBot.
-- Add this column first if it does not already exist.
-- =============================================================================


-- =============================================================================
-- STEP 1 — Link Supabase Auth users to their agent
-- =============================================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) UNIQUE;


-- =============================================================================
-- STEP 2 — Drop the broad starter policies from schema.sql
-- =============================================================================

DROP POLICY IF EXISTS "agents_public_read"       ON agents;
DROP POLICY IF EXISTS "challenges_public_read"   ON challenges;
DROP POLICY IF EXISTS "matches_public_read"      ON matches;
DROP POLICY IF EXISTS "transactions_public_read" ON transactions;


-- =============================================================================
-- AGENTS
-- =============================================================================
-- Sensitive columns that must never be exposed to the public:
--   api_key_hash   — used only by Edge Functions for verification
--   strategy       — competitive info; only the owner should see their own
--   strategy_state — same
--   user_id        — internal auth link; no need to expose
--
-- Approach: column-level GRANTs restrict what anon can SELECT even when the
-- RLS policy itself is permissive. Authenticated users get a separate policy
-- scoped to their own row, giving full column access.
-- =============================================================================

-- Strip broad column access from anon and authenticated roles.
-- service_role retains full access and bypasses RLS.
REVOKE SELECT ON agents FROM anon, authenticated;

-- Anon (spectators) can read only the public-safe profile columns.
GRANT SELECT (id, name, balance, wins, losses, draws, created_at)
  ON agents TO anon;

-- Authenticated owners can read all columns on their own row.
-- (Column access is unrestricted for authenticated; the RLS policy below
--  limits which rows they can see.)
GRANT SELECT ON agents TO authenticated;

-- Policy: anon sees all rows but only the columns granted above.
DROP POLICY IF EXISTS "agents_anon_read" ON agents;
CREATE POLICY "agents_anon_read"
  ON agents FOR SELECT
  TO anon
  USING (true);

-- Policy: authenticated users see only their own full row.
DROP POLICY IF EXISTS "agents_owner_read" ON agents;
CREATE POLICY "agents_owner_read"
  ON agents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);


-- =============================================================================
-- CHALLENGES
-- =============================================================================
-- Open challenges are public — the lobby is visible to all.
-- An owner needs to see their own challenges regardless of status so they can
-- track cancellations and matched challenges.
-- No direct writes from the client; all mutations go through Edge Functions.
-- =============================================================================

-- Policy: anon sees open challenges only (lobby).
DROP POLICY IF EXISTS "challenges_anon_read" ON challenges;
CREATE POLICY "challenges_anon_read"
  ON challenges FOR SELECT
  TO anon
  USING (status = 'open');

-- Policy: authenticated owners see all their own challenges (any status).
DROP POLICY IF EXISTS "challenges_owner_read" ON challenges;
CREATE POLICY "challenges_owner_read"
  ON challenges FOR SELECT
  TO authenticated
  USING (challenger_id IN (
    SELECT id FROM agents WHERE user_id = auth.uid()
  ));


-- =============================================================================
-- MATCHES
-- =============================================================================
-- The most sensitive table. Several columns must be hidden during active play:
--
--   agent1_move_hash / agent2_move_hash
--     Hidden until both are submitted. Exposing one hash before the other
--     would let the second agent verify guesses before committing.
--
--   agent1_move / agent2_move / agent1_salt / agent2_salt
--     Hidden until the match is complete. Exposing one reveal before the
--     other would let the slower agent change their reveal to win (even
--     though the hash check would catch this, there is no need to expose it).
--
-- RLS cannot restrict individual columns per row state cleanly.
-- Solution: anon and authenticated clients only see completed matches directly.
-- In-progress match state is served exclusively through Edge Functions, which
-- return a sanitised projection (own hash visible, opponent hash hidden).
-- Supabase Realtime for the live spectator view is scoped to the match_feed
-- view, which only surfaces completed matches.
-- =============================================================================

-- Policy: anon sees only completed matches (spectator feed).
DROP POLICY IF EXISTS "matches_anon_read" ON matches;
CREATE POLICY "matches_anon_read"
  ON matches FOR SELECT
  TO anon
  USING (status = 'complete');

-- Policy: authenticated participants see their own completed matches.
-- In-progress state is intentionally excluded here — served via Edge Functions.
DROP POLICY IF EXISTS "matches_participant_read" ON matches;
CREATE POLICY "matches_participant_read"
  ON matches FOR SELECT
  TO authenticated
  USING (
    status = 'complete'
    AND (
      agent1_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
      OR
      agent2_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
    )
  );


-- =============================================================================
-- TRANSACTIONS
-- =============================================================================
-- The chip audit trail. Owners should be able to review their own history.
-- Anon has no need to query raw transaction rows — balance and match outcomes
-- are surfaced through agent profiles and the match feed instead.
-- =============================================================================

-- Policy: no direct anon access to transactions.
-- (Table has RLS enabled, no anon policy = anon sees nothing.)

-- Policy: authenticated owners see transactions they sent or received.
DROP POLICY IF EXISTS "transactions_owner_read" ON transactions;
CREATE POLICY "transactions_owner_read"
  ON transactions FOR SELECT
  TO authenticated
  USING (
    from_agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
    OR
    to_agent_id   IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );


-- =============================================================================
-- VIEWS — Realtime subscriptions should target these, not raw tables
-- =============================================================================
-- The views defined in schema.sql (leaderboard, open_challenges, match_feed,
-- stale_matches) are SECURITY INVOKER by default in Supabase, meaning they
-- respect the caller's RLS policies.
--
-- For Realtime subscriptions from the web UI use:
--   supabase.channel('arena').on('postgres_changes', {
--     event: '*', schema: 'public', table: 'matches',
--     filter: 'status=eq.complete'           ← mirrors the anon RLS policy
--   })
--
-- This ensures the Realtime feed never leaks in-progress match data.
-- =============================================================================


-- =============================================================================
-- SUMMARY
-- =============================================================================
--
--  Table          anon                        authenticated (owner only)
--  ─────────────────────────────────────────────────────────────────────
--  agents         id, name, balance,          all columns, own row only
--                 wins, losses, draws,
--                 created_at (via GRANT)
--
--  challenges     open challenges only        all statuses, own challenges
--
--  matches        complete matches only       complete matches, own matches
--                                             (in-progress via Edge Fn)
--
--  transactions   none                        own sent/received rows
--
-- =============================================================================
