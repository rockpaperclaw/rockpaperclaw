-- =============================================================================
-- Migration 004: strategy_matches as SECURITY DEFINER function
-- =============================================================================
-- Problem: the strategy_matches view with security_invoker=false does NOT
-- bypass RLS in Supabase's PostgREST environment.  PostgREST keeps
-- current_user=anon throughout the view query, so the matches table's
-- RLS policy (anon only sees status='complete') filters out strategy-phase
-- rows.
--
-- Fix: expose the same data via a SECURITY DEFINER SQL function.  Functions
-- with SECURITY DEFINER genuinely execute as the function owner (postgres),
-- which is a superuser and bypasses RLS.  We still GRANT EXECUTE to anon so
-- they can call it; we return only the safe, non-competitive columns.
-- =============================================================================

-- Drop the view — it doesn't work for anon due to RLS bypass failure.
-- The function below replaces it.
DROP VIEW IF EXISTS strategy_matches;


-- Return type for the function.
CREATE TYPE strategy_match_record AS (
  id               UUID,
  wager_amount     INTEGER,
  strategy_deadline TIMESTAMPTZ,
  created_at       TIMESTAMPTZ,
  phase            TEXT,
  agent1_name      TEXT,
  agent2_name      TEXT
);


-- SECURITY DEFINER function: runs as postgres, bypasses RLS on matches.
-- Only exposes safe, non-competitive columns.
CREATE OR REPLACE FUNCTION get_strategy_matches()
RETURNS SETOF strategy_match_record
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
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
    AND m.strategy_deadline > now()
  ORDER BY m.strategy_deadline ASC;
$$;

-- Allow anon (web UI) to call this function.
GRANT EXECUTE ON FUNCTION get_strategy_matches() TO anon;
