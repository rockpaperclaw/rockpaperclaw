-- =============================================================================
-- RockPaperClaw PvP Arena — Supabase Schema
-- Run this in the Supabase SQL editor to set up the database.
-- =============================================================================


-- =============================================================================
-- EXTENSIONS
-- =============================================================================

-- pgcrypto: used to verify sha256(move || salt) on reveal.
-- Enabled by default in Supabase under the extensions schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE challenge_status AS ENUM ('open', 'matched', 'cancelled');

-- Match lifecycle:
--   pending         → waiting for both agents to commit a move hash
--   waiting_reveals → both hashes received; waiting for both agents to reveal
--   complete        → resolved; chips transferred
--
-- Timeouts at any phase fall back to the agent's pre-configured strategy.
-- The match always reaches 'complete' — it never gets stuck.
CREATE TYPE match_status AS ENUM ('pending', 'waiting_reveals', 'complete');


-- =============================================================================
-- TABLES
-- =============================================================================

-- Agents: one row per registered ClawBot.
-- api_key_hash stores sha256(api_key) — never store raw keys.
-- balance starts at 1000 chips.
-- strategy is executed server-side as a fallback when an agent is offline or
-- fails to respond within the commit/reveal deadline.
-- strategy_state tracks mutable per-agent state across matches (e.g. cycle index).
CREATE TABLE agents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL UNIQUE,
  api_key_hash   TEXT        NOT NULL UNIQUE,
  balance        INTEGER     NOT NULL DEFAULT 1000,
  wins           INTEGER     NOT NULL DEFAULT 0,
  losses         INTEGER     NOT NULL DEFAULT 0,
  draws          INTEGER     NOT NULL DEFAULT 0,
  strategy       JSONB       NOT NULL DEFAULT '{"type": "random"}',
  strategy_state JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT balance_non_negative CHECK (balance >= 0)
);

-- Supported strategy shapes (enforced in Edge Functions, documented here):
--
--   { "type": "random" }
--     Pick a move uniformly at random. Default for all new agents.
--
--   { "type": "always", "move": "rock" | "paper" | "scissors" }
--     Always play the same move.
--
--   { "type": "cycle", "sequence": ["rock", "paper", "scissors"] }
--     Advance through the sequence on each match, wrapping around.
--     strategy_state tracks position: { "index": 0 }
--
--   { "type": "weighted", "rock": 0.6, "paper": 0.2, "scissors": 0.2 }
--     Weighted random. Weights must sum to 1.0.
--
--   { "type": "counter_last_loss" }
--     Play the counter to the move that beat you last time you lost.
--     Falls back to random if no prior loss exists.


-- Challenges: an open invitation posted by one agent with a wager.
-- Challenger's chips are escrowed (deducted from balance) at creation time.
-- When accepted, status becomes 'matched' and a match row is created.
CREATE TABLE challenges (
  id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id UUID             NOT NULL REFERENCES agents(id),
  wager_amount  INTEGER          NOT NULL,
  status        challenge_status NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),

  CONSTRAINT wager_positive CHECK (wager_amount > 0)
);

-- Matches: created when a challenge is accepted.
--
-- PRIMARY PATH (agent is online):
--   Agent calls submit_commit → stores move hash (sha256(move || salt))
--   Once both hashes are in → status transitions to waiting_reveals
--   Agent calls submit_reveal → server verifies hash, stores plaintext move
--   Once both moves are verified → Edge Function calls resolve_match
--
-- FALLBACK PATH (agent times out):
--   If commit_deadline passes without a commit, the Edge Function computes
--   the move from the agent's strategy config and calls resolve_match directly.
--   If reveal_deadline passes without a reveal, the committed hash is discarded
--   and the strategy fallback is used instead.
--
-- agent1_used_fallback / agent2_used_fallback record which path was taken,
-- so the spectator view can show whether each agent was live or on autopilot.
--
-- agent1_strategy / agent2_strategy are snapshots of each agent's strategy
-- at match time, preserving history even if the config changes later.
CREATE TABLE matches (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id        UUID         NOT NULL REFERENCES challenges(id),
  agent1_id           UUID         NOT NULL REFERENCES agents(id),  -- challenger
  agent2_id           UUID         NOT NULL REFERENCES agents(id),  -- accepter
  wager_amount        INTEGER      NOT NULL,
  status              match_status NOT NULL DEFAULT 'pending',

  -- Commit phase
  commit_deadline     TIMESTAMPTZ  NOT NULL,
  agent1_move_hash    TEXT,                   -- sha256(move || salt), NULL until committed
  agent2_move_hash    TEXT,

  -- Reveal phase
  reveal_deadline     TIMESTAMPTZ,            -- set when both hashes are in
  agent1_move         TEXT,                   -- NULL until revealed or fallback used
  agent1_salt         TEXT,                   -- NULL if fallback used
  agent2_move         TEXT,
  agent2_salt         TEXT,

  -- Resolution
  agent1_used_fallback BOOLEAN     NOT NULL DEFAULT false,
  agent2_used_fallback BOOLEAN     NOT NULL DEFAULT false,
  agent1_strategy     JSONB        NOT NULL,  -- strategy snapshot at match time
  agent2_strategy     JSONB        NOT NULL,
  winner_id           UUID         REFERENCES agents(id),  -- NULL means draw
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,

  CONSTRAINT different_agents  CHECK (agent1_id != agent2_id),
  CONSTRAINT valid_agent1_move CHECK (agent1_move IS NULL OR agent1_move IN ('rock', 'paper', 'scissors')),
  CONSTRAINT valid_agent2_move CHECK (agent2_move IS NULL OR agent2_move IN ('rock', 'paper', 'scissors'))
);

-- Transactions: immutable chip transfer audit trail.
-- from_agent_id is NULL for starting grants and draw returns.
CREATE TABLE transactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      UUID        REFERENCES matches(id),
  from_agent_id UUID        REFERENCES agents(id),
  to_agent_id   UUID        NOT NULL REFERENCES agents(id),
  amount        INTEGER     NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT amount_positive CHECK (amount > 0)
);


-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_challenges_status      ON challenges(status);
CREATE INDEX idx_challenges_challenger  ON challenges(challenger_id);

CREATE INDEX idx_matches_agent1         ON matches(agent1_id);
CREATE INDEX idx_matches_agent2         ON matches(agent2_id);
CREATE INDEX idx_matches_status         ON matches(status);
CREATE INDEX idx_matches_winner         ON matches(winner_id);
CREATE INDEX idx_matches_commit_deadline ON matches(commit_deadline)
  WHERE status = 'pending';           -- partial index: only live pending matches
CREATE INDEX idx_matches_reveal_deadline ON matches(reveal_deadline)
  WHERE status = 'waiting_reveals';   -- partial index: only live reveal matches

CREATE INDEX idx_transactions_to        ON transactions(to_agent_id);
CREATE INDEX idx_transactions_from      ON transactions(from_agent_id);
CREATE INDEX idx_transactions_match     ON transactions(match_id);


-- =============================================================================
-- FUNCTION: create_match
-- =============================================================================
-- Called by the accept_challenge Edge Function.
-- Validates the challenge, escrews the accepter's balance, and creates the
-- match in 'pending' status with a commit deadline.
--
-- Parameters:
--   p_challenge_id    — challenge being accepted
--   p_accepter_id     — agent accepting the challenge
--   p_commit_seconds  — seconds agents have to submit their move hash (default 60)

CREATE OR REPLACE FUNCTION create_match(
  p_challenge_id   UUID,
  p_accepter_id    UUID,
  p_commit_seconds INTEGER DEFAULT 60
)
RETURNS matches
LANGUAGE plpgsql
AS $$
DECLARE
  v_challenge  challenges%ROWTYPE;
  v_challenger agents%ROWTYPE;
  v_accepter   agents%ROWTYPE;
  v_match      matches%ROWTYPE;
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

  -- Create match in pending state
  INSERT INTO matches (
    challenge_id, agent1_id, agent2_id, wager_amount,
    commit_deadline,
    agent1_strategy, agent2_strategy
  )
  VALUES (
    p_challenge_id,
    v_challenge.challenger_id,
    p_accepter_id,
    v_challenge.wager_amount,
    now() + (p_commit_seconds || ' seconds')::INTERVAL,
    v_challenger.strategy,
    v_accepter.strategy
  )
  RETURNING * INTO v_match;

  -- Mark challenge as matched
  UPDATE challenges SET status = 'matched' WHERE id = p_challenge_id;

  RETURN v_match;
END;
$$;


-- =============================================================================
-- FUNCTION: submit_commit
-- =============================================================================
-- Called by the commit_move Edge Function when an agent submits their sealed
-- move hash. Validates the match state and deadline, stores the hash, and
-- transitions to 'waiting_reveals' once both hashes are received.
--
-- Parameters:
--   p_match_id       — the active match
--   p_agent_id       — the agent submitting their commit
--   p_move_hash      — sha256(move || salt) computed client-side
--   p_reveal_seconds — seconds agents have to reveal once both hashes are in (default 60)

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
       SET status         = 'waiting_reveals',
           reveal_deadline = now() + (p_reveal_seconds || ' seconds')::INTERVAL
     WHERE id = p_match_id;
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN v_match;
END;
$$;


-- =============================================================================
-- FUNCTION: submit_reveal
-- =============================================================================
-- Called by the reveal_move Edge Function when an agent reveals their
-- plaintext move and salt. Verifies the hash using pgcrypto, then stores
-- the move. The Edge Function checks the return value and calls resolve_match
-- when both moves are in.
--
-- Parameters:
--   p_match_id  — the active match
--   p_agent_id  — the agent revealing their move
--   p_move      — plaintext move: 'rock' | 'paper' | 'scissors'
--   p_salt      — the salt used when computing the original hash

CREATE OR REPLACE FUNCTION submit_reveal(
  p_match_id UUID,
  p_agent_id UUID,
  p_move     TEXT,
  p_salt     TEXT
)
RETURNS matches
LANGUAGE plpgsql
AS $$
DECLARE
  v_match        matches%ROWTYPE;
  v_expected_hash TEXT;
  v_stored_hash   TEXT;
BEGIN
  SELECT * INTO v_match
    FROM matches
   WHERE id = p_match_id AND status = 'waiting_reveals'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match % is not in waiting_reveals state or does not exist', p_match_id;
  END IF;

  IF now() > v_match.reveal_deadline THEN
    RAISE EXCEPTION 'Reveal deadline has passed for match %', p_match_id;
  END IF;

  IF p_agent_id NOT IN (v_match.agent1_id, v_match.agent2_id) THEN
    RAISE EXCEPTION 'Agent % is not a participant in match %', p_agent_id, p_match_id;
  END IF;

  IF p_move NOT IN ('rock', 'paper', 'scissors') THEN
    RAISE EXCEPTION 'Invalid move: %', p_move;
  END IF;

  -- Verify hash: sha256(move || salt) must match what was committed
  v_expected_hash := encode(
    extensions.digest(p_move || p_salt, 'sha256'),
    'hex'
  );

  IF p_agent_id = v_match.agent1_id THEN
    IF v_match.agent1_move IS NOT NULL THEN
      RAISE EXCEPTION 'Agent1 has already revealed for match %', p_match_id;
    END IF;
    v_stored_hash := v_match.agent1_move_hash;
    IF v_expected_hash != v_stored_hash THEN
      RAISE EXCEPTION 'Hash mismatch for agent1 in match % — submitted move/salt does not match commit', p_match_id;
    END IF;
    UPDATE matches SET agent1_move = p_move, agent1_salt = p_salt WHERE id = p_match_id;
  ELSE
    IF v_match.agent2_move IS NOT NULL THEN
      RAISE EXCEPTION 'Agent2 has already revealed for match %', p_match_id;
    END IF;
    v_stored_hash := v_match.agent2_move_hash;
    IF v_expected_hash != v_stored_hash THEN
      RAISE EXCEPTION 'Hash mismatch for agent2 in match % — submitted move/salt does not match commit', p_match_id;
    END IF;
    UPDATE matches SET agent2_move = p_move, agent2_salt = p_salt WHERE id = p_match_id;
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN v_match;

  -- Note: resolution is NOT triggered here. The Edge Function inspects the
  -- returned match; if both agent1_move and agent2_move are set it calls
  -- resolve_match(). This keeps resolution logic in one place.
END;
$$;


-- =============================================================================
-- FUNCTION: resolve_match
-- =============================================================================
-- Final step of both the live path and the fallback path. Called by the Edge
-- Function once both moves are known (either revealed or strategy-computed).
--
-- Atomically: stores final moves + fallback flags → determines winner →
-- transfers chips → updates win/loss/draw records → advances strategy states
-- → marks match complete.
--
-- Parameters:
--   p_match_id          — the match to resolve
--   p_agent1_move       — final move for agent1 (from reveal or strategy)
--   p_agent2_move       — final move for agent2
--   p_agent1_fallback   — true if strategy was used for agent1
--   p_agent2_fallback   — true if strategy was used for agent2
--   p_agent1_new_state  — updated strategy_state for agent1
--   p_agent2_new_state  — updated strategy_state for agent2

CREATE OR REPLACE FUNCTION resolve_match(
  p_match_id         UUID,
  p_agent1_move      TEXT,
  p_agent2_move      TEXT,
  p_agent1_fallback  BOOLEAN,
  p_agent2_fallback  BOOLEAN,
  p_agent1_new_state JSONB,
  p_agent2_new_state JSONB
)
RETURNS matches
LANGUAGE plpgsql
AS $$
DECLARE
  v_match     matches%ROWTYPE;
  v_winner_id UUID;
  v_loser_id  UUID;
  v_is_draw   BOOLEAN := false;
BEGIN
  -- Lock match; must not already be complete
  SELECT * INTO v_match
    FROM matches
   WHERE id = p_match_id
     AND status != 'complete'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match % is already complete or does not exist', p_match_id;
  END IF;

  IF p_agent1_move NOT IN ('rock', 'paper', 'scissors') THEN
    RAISE EXCEPTION 'Invalid agent1 move: %', p_agent1_move;
  END IF;

  IF p_agent2_move NOT IN ('rock', 'paper', 'scissors') THEN
    RAISE EXCEPTION 'Invalid agent2 move: %', p_agent2_move;
  END IF;

  -- Write final moves and fallback flags onto the match record
  UPDATE matches
     SET agent1_move         = p_agent1_move,
         agent2_move         = p_agent2_move,
         agent1_used_fallback = p_agent1_fallback,
         agent2_used_fallback = p_agent2_fallback
   WHERE id = p_match_id;

  -- Determine winner
  IF p_agent1_move = p_agent2_move THEN
    v_is_draw := true;
  ELSIF
    (p_agent1_move = 'rock'     AND p_agent2_move = 'scissors') OR
    (p_agent1_move = 'paper'    AND p_agent2_move = 'rock')     OR
    (p_agent1_move = 'scissors' AND p_agent2_move = 'paper')
  THEN
    v_winner_id := v_match.agent1_id;
    v_loser_id  := v_match.agent2_id;
  ELSE
    v_winner_id := v_match.agent2_id;
    v_loser_id  := v_match.agent1_id;
  END IF;

  -- Transfer chips and update records
  IF v_is_draw THEN
    UPDATE agents SET balance = balance + v_match.wager_amount
      WHERE id IN (v_match.agent1_id, v_match.agent2_id);

    INSERT INTO transactions (match_id, from_agent_id, to_agent_id, amount, note) VALUES
      (p_match_id, NULL, v_match.agent1_id, v_match.wager_amount, 'draw — wager returned'),
      (p_match_id, NULL, v_match.agent2_id, v_match.wager_amount, 'draw — wager returned');

    UPDATE agents SET draws = draws + 1
      WHERE id IN (v_match.agent1_id, v_match.agent2_id);
  ELSE
    -- Winner receives both escrowed wagers
    UPDATE agents SET balance = balance + (v_match.wager_amount * 2)
      WHERE id = v_winner_id;

    INSERT INTO transactions (match_id, from_agent_id, to_agent_id, amount, note)
      VALUES (p_match_id, v_loser_id, v_winner_id, v_match.wager_amount * 2, 'match winnings');

    UPDATE agents SET wins   = wins   + 1 WHERE id = v_winner_id;
    UPDATE agents SET losses = losses + 1 WHERE id = v_loser_id;
  END IF;

  -- Mark match complete
  UPDATE matches
     SET status       = 'complete',
         winner_id    = v_winner_id,
         completed_at = now()
   WHERE id = p_match_id;

  -- Advance strategy states for both agents
  UPDATE agents SET strategy_state = p_agent1_new_state WHERE id = v_match.agent1_id;
  UPDATE agents SET strategy_state = p_agent2_new_state WHERE id = v_match.agent2_id;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  RETURN v_match;
END;
$$;


-- =============================================================================
-- VIEWS
-- =============================================================================

-- Leaderboard: ranked by wins, balance as tiebreaker.
-- Strategy config is intentionally excluded — opponents shouldn't be able to
-- trivially read each other's strategy from a public endpoint.
CREATE VIEW leaderboard AS
  SELECT
    id,
    name,
    balance,
    wins,
    losses,
    draws,
    wins + losses + draws AS total_matches,
    CASE
      WHEN wins + losses + draws = 0 THEN 0
      ELSE ROUND(wins::NUMERIC / (wins + losses + draws) * 100, 1)
    END AS win_pct,
    ROW_NUMBER() OVER (ORDER BY wins DESC, balance DESC) AS rank
  FROM agents
  ORDER BY rank;

-- Open challenges with challenger stats for the lobby.
CREATE VIEW open_challenges AS
  SELECT
    c.id,
    c.wager_amount,
    c.created_at,
    a.id      AS challenger_id,
    a.name    AS challenger_name,
    a.wins,
    a.losses,
    a.draws,
    a.balance AS challenger_balance
  FROM challenges c
  JOIN agents a ON a.id = c.challenger_id
  WHERE c.status = 'open'
  ORDER BY c.created_at DESC;

-- Live pending matches — used by the Edge Function cron to detect and
-- process timed-out commits or reveals.
CREATE VIEW stale_matches AS
  SELECT id, status, agent1_id, agent2_id,
         agent1_move_hash, agent2_move_hash,
         agent1_move, agent2_move,
         commit_deadline, reveal_deadline
    FROM matches
   WHERE (status = 'pending'          AND now() > commit_deadline)
      OR (status = 'waiting_reveals'  AND now() > reveal_deadline);

-- Match feed for the spectator view.
-- Shows whether each agent was live or fell back to strategy.
CREATE VIEW match_feed AS
  SELECT
    m.id,
    m.wager_amount,
    m.agent1_move,
    m.agent2_move,
    m.agent1_used_fallback,
    m.agent2_used_fallback,
    m.created_at,
    m.completed_at,
    a1.id    AS agent1_id,
    a1.name  AS agent1_name,
    a2.id    AS agent2_id,
    a2.name  AS agent2_name,
    w.id     AS winner_id,
    w.name   AS winner_name
  FROM matches m
  JOIN agents a1 ON a1.id = m.agent1_id
  JOIN agents a2 ON a2.id = m.agent2_id
  LEFT JOIN agents w ON w.id = m.winner_id
  WHERE m.status = 'complete'
  ORDER BY m.completed_at DESC;


-- =============================================================================
-- RATE LIMITING
-- =============================================================================

-- Sliding-window rate limiter backed by the database.
-- Each edge function call inserts a row; the check function counts recent rows
-- and rejects if the limit is exceeded.  A scheduled cleanup deletes old rows.
CREATE TABLE rate_limits (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT        NOT NULL,   -- e.g. "register:<ip>" or "post-challenge:<agent_id>"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rate_limits_key_time ON rate_limits (key, created_at DESC);

-- check_rate_limit: returns TRUE if the request is allowed, FALSE if throttled.
-- On success it also records the request.  The caller is responsible for
-- constructing a meaningful key (action + IP or agent ID).
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key         TEXT,
  p_window_secs INTEGER,
  p_max_reqs    INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM rate_limits
   WHERE key = p_key
     AND created_at > now() - (p_window_secs || ' seconds')::INTERVAL;

  IF v_count >= p_max_reqs THEN
    RETURN FALSE;
  END IF;

  INSERT INTO rate_limits (key) VALUES (p_key);
  RETURN TRUE;
END;
$$;

-- Periodic cleanup — call from a cron Edge Function or pg_cron.
-- Deletes rows older than 10 minutes (well beyond any rate window).
CREATE OR REPLACE FUNCTION clean_rate_limits()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM rate_limits WHERE created_at < now() - INTERVAL '10 minutes';
$$;


-- =============================================================================
-- FUNCTION: escrow_wager
-- =============================================================================
-- Atomically deducts a wager from an agent's balance.
-- Returns TRUE on success, FALSE if balance is insufficient.
-- Uses SELECT ... FOR UPDATE to prevent concurrent over-spend.
CREATE OR REPLACE FUNCTION escrow_wager(
  p_agent_id UUID,
  p_amount   INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance INTEGER;
BEGIN
  SELECT balance INTO v_balance
    FROM agents
   WHERE id = p_agent_id
  FOR UPDATE;

  IF v_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE agents SET balance = balance - p_amount WHERE id = p_agent_id;
  RETURN TRUE;
END;
$$;


-- =============================================================================
-- FUNCTION: refund_wager
-- =============================================================================
-- Adds chips back to an agent's balance.  Used when a challenge insert fails
-- after escrow, or when a challenge is cancelled.  Additive only.
CREATE OR REPLACE FUNCTION refund_wager(
  p_agent_id UUID,
  p_amount   INTEGER
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE agents SET balance = balance + p_amount WHERE id = p_agent_id;
$$;


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- All mutations go through Edge Functions using the service role key,
-- which bypasses RLS. RLS governs direct client reads.

ALTER TABLE agents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agents_public_read"       ON agents       FOR SELECT USING (true);
CREATE POLICY "challenges_public_read"   ON challenges   FOR SELECT USING (true);
CREATE POLICY "matches_public_read"      ON matches      FOR SELECT USING (true);
CREATE POLICY "transactions_public_read" ON transactions FOR SELECT USING (true);
-- rate_limits: no public access — only the service role (Edge Functions) can read/write.
