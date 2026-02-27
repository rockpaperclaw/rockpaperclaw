-- =============================================================================
-- Migration 001: Strategy Period
-- =============================================================================
-- Adds a 60-second strategy window before the commit phase.
-- During this window agents receive their opponent's last 20 match results
-- via accept-challenge / get-match and may NOT commit yet.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL editor → New query).
-- =============================================================================

-- 1. Add strategy_deadline column (nullable so existing rows are unaffected)
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS strategy_deadline TIMESTAMPTZ;

-- 2. Replace create_match — adds p_strategy_seconds parameter and sets
--    strategy_deadline; commit_deadline is now relative to strategy_deadline.
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

  -- Create match: commit window opens after strategy window closes
  INSERT INTO matches (
    challenge_id, agent1_id, agent2_id, wager_amount,
    strategy_deadline, commit_deadline,
    agent1_strategy, agent2_strategy
  )
  VALUES (
    p_challenge_id,
    v_challenge.challenger_id,
    p_accepter_id,
    v_challenge.wager_amount,
    v_strategy_dl,
    v_strategy_dl + (p_commit_seconds || ' seconds')::INTERVAL,
    v_challenger.strategy,
    v_accepter.strategy
  )
  RETURNING * INTO v_match;

  -- Mark challenge as matched
  UPDATE challenges SET status = 'matched' WHERE id = p_challenge_id;

  RETURN v_match;
END;
$$;


-- 3. Replace submit_commit — blocks commits during the strategy window.
CREATE OR REPLACE FUNCTION submit_commit(
  p_match_id       UUID,
  p_agent_id       UUID,
  p_move_hash      TEXT,
  p_reveal_seconds INTEGER DEFAULT 60
)
RETURNS matches
LANGUAGE plpgsql
AS $$
DECLARE
  v_match matches%ROWTYPE;
BEGIN
  SELECT * INTO v_match
    FROM matches
   WHERE id = p_match_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match % is not in pending state or does not exist', p_match_id;
  END IF;

  -- Block commits until strategy period expires
  IF v_match.strategy_deadline IS NOT NULL AND now() < v_match.strategy_deadline THEN
    RAISE EXCEPTION 'Strategy period active until % — study your opponent first',
      to_char(v_match.strategy_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  END IF;

  IF now() > v_match.commit_deadline THEN
    RAISE EXCEPTION 'Commit deadline has passed for match %', p_match_id;
  END IF;

  IF p_agent_id NOT IN (v_match.agent1_id, v_match.agent2_id) THEN
    RAISE EXCEPTION 'Agent % is not a participant in match %', p_agent_id, p_match_id;
  END IF;

  -- Store hash for the correct agent, reject duplicate commits
  IF p_agent_id = v_match.agent1_id THEN
    IF v_match.agent1_move_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Agent1 has already committed for match %', p_match_id;
    END IF;
    UPDATE matches SET agent1_move_hash = p_move_hash WHERE id = p_match_id;
  ELSE
    IF v_match.agent2_move_hash IS NOT NULL THEN
      RAISE EXCEPTION 'Agent2 has already committed for match %', p_match_id;
    END IF;
    UPDATE matches SET agent2_move_hash = p_move_hash WHERE id = p_match_id;
  END IF;

  -- Reload to check if both hashes are now in
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;

  IF v_match.agent1_move_hash IS NOT NULL AND v_match.agent2_move_hash IS NOT NULL THEN
    UPDATE matches
       SET status          = 'waiting_reveals',
           reveal_deadline = now() + (p_reveal_seconds || ' seconds')::INTERVAL
     WHERE id = p_match_id;
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN v_match;
END;
$$;
