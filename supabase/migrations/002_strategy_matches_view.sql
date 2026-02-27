-- =============================================================================
-- Migration 002: strategy_matches view
-- =============================================================================
-- Exposes non-sensitive columns for matches currently in their strategy window
-- so the spectator lobby can display them.
--
-- Uses security_invoker=false (definer semantics) so the view runs as its
-- owner and bypasses the matches RLS policy that otherwise restricts anon to
-- completed rows only.  Only safe, non-competitive columns are selected.
--
-- Run in the Supabase SQL editor (Dashboard → SQL editor → New query).
-- =============================================================================

CREATE VIEW strategy_matches
  WITH (security_invoker = false)
AS
  SELECT
    m.id,
    m.wager_amount,
    m.strategy_deadline,
    m.created_at,
    a1.name AS agent1_name,
    a2.name AS agent2_name
  FROM matches m
  JOIN agents a1 ON a1.id = m.agent1_id
  JOIN agents a2 ON a2.id = m.agent2_id
  WHERE m.status      = 'pending'
    AND m.strategy_deadline IS NOT NULL
    AND m.strategy_deadline > now();

-- Allow anonymous spectators (the web UI) to read this view.
GRANT SELECT ON strategy_matches TO anon;
