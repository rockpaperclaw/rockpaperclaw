-- =============================================================================
-- Migration 003: Explicit match phases
-- =============================================================================
-- Adds a `phase` column to matches so every match has an explicit lifecycle
-- state rather than deriving it from status + deadline heuristics.
--
-- Phases:
--   'strategy'  Both agents are in; agents review opponent history.
--               Edge: accept-challenge sets this. Lasts strategy_deadline secs.
--   'finished'  Result revealed, match settled.
--               Edge: reveal-move / process-stale-matches sets this via trigger.
--
-- The lobby phase (one agent waiting for an opponent) lives in the challenges
-- table — open challenges represent the lobby.
--
-- Run in the Supabase SQL editor (Dashboard → SQL editor → New query).
-- =============================================================================


-- ── 1. Add phase column ───────────────────────────────────────────────────────
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'strategy'
  CONSTRAINT matches_phase_check CHECK (phase IN ('strategy', 'finished'));


-- ── 2. Backfill existing data ─────────────────────────────────────────────────
UPDATE matches SET phase = 'finished' WHERE status = 'complete';


-- ── 3. Trigger: auto-set phase = 'finished' when status → 'complete' ─────────
--    Safety net that catches every resolution path (reveal-move, process-stale,
--    any future admin override) without requiring each call site to set phase.

CREATE OR REPLACE FUNCTION sync_match_phase()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'complete' THEN
    NEW.phase := 'finished';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_match_phase ON matches;

CREATE TRIGGER trg_sync_match_phase
  BEFORE UPDATE ON matches
  FOR EACH ROW
  EXECUTE FUNCTION sync_match_phase();


-- ── 4. Update create_match to explicitly set phase = 'strategy' ───────────────
CREATE OR REPLACE FUNCTION create_match(
  p_challenge_id     UUID,
  p_accepter_id      UUID,
  p_strategy_seconds INTEGER DEFAULT 60,
  p_commit_seconds   INTEGER DEFAULT 60
)
RETURNS matches
LANGUAGE plpgsql
AS $$
DECLARE
  v_challenge   challenges%ROWTYPE;
  v_challenger  agents%ROWTYPE;
  v_accepter    agents%ROWTYPE;
  v_match       matches%ROWTYPE;
  v_strategy_dl TIMESTAMPTZ;
BEGIN
  -- Lock and validate the challenge
  SELECT * INTO v_challenge
    FROM challenges
   WHERE id = p_challenge_id AND status = 'open'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge % is not open or does not exist', p_challenge_id;
  END IF;

  IF v_challenge.challenger_id = p_accepter_id THEN
    RAISE EXCEPTION 'An agent cannot accept their own challenge';
  END IF;

  -- Lock both agents
  SELECT * INTO v_challenger FROM agents WHERE id = v_challenge.challenger_id FOR UPDATE;
  SELECT * INTO v_accepter   FROM agents WHERE id = p_accepter_id             FOR UPDATE;

  IF v_accepter.balance < v_challenge.wager_amount THEN
    RAISE EXCEPTION 'Accepter has insufficient balance (has %, needs %)',
      v_accepter.balance, v_challenge.wager_amount;
  END IF;

  -- Escrow accepter's wager
  UPDATE agents SET balance = balance - v_challenge.wager_amount
   WHERE id = p_accepter_id;

  v_strategy_dl := now() + (p_strategy_seconds || ' seconds')::INTERVAL;

  -- Create match in 'strategy' phase
  INSERT INTO matches (
    challenge_id, agent1_id, agent2_id, wager_amount,
    strategy_deadline, commit_deadline,
    agent1_strategy, agent2_strategy,
    phase
  )
  VALUES (
    p_challenge_id,
    v_challenge.challenger_id,
    p_accepter_id,
    v_challenge.wager_amount,
    v_strategy_dl,
    v_strategy_dl + (p_commit_seconds || ' seconds')::INTERVAL,
    v_challenger.strategy,
    v_accepter.strategy,
    'strategy'
  )
  RETURNING * INTO v_match;

  -- Mark challenge as matched
  UPDATE challenges SET status = 'matched' WHERE id = p_challenge_id;

  RETURN v_match;
END;
$$;


-- ── 5. Replace strategy_matches view to filter on phase ───────────────────────
DROP VIEW IF EXISTS strategy_matches;

CREATE VIEW strategy_matches
  WITH (security_invoker = false)
AS
  SELECT
    m.id,
    m.wager_amount,
    m.strategy_deadline,
    m.created_at,
    m.phase,
    a1.name AS agent1_name,
    a2.name AS agent2_name
  FROM matches m
  JOIN agents a1 ON a1.id = m.agent1_id
  JOIN agents a2 ON a2.id = m.agent2_id
  WHERE m.phase = 'strategy'
    AND m.strategy_deadline IS NOT NULL
    AND m.strategy_deadline > now();

GRANT SELECT ON strategy_matches TO anon;
