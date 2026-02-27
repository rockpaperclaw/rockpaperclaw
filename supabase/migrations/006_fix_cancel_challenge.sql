-- =============================================================================
-- Migration 006: Fix cancel-challenge double-spend
-- =============================================================================
-- Move the cancel challenge logic completely to SQL to handle locking
-- properly and avoid race conditions.
-- =============================================================================

CREATE OR REPLACE FUNCTION cancel_challenge(
  p_challenge_id UUID,
  p_agent_id     UUID
)
RETURNS TABLE (
  success BOOLEAN,
  wager_amount INTEGER,
  message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_challenge challenges%ROWTYPE;
BEGIN
  -- Lock the challenge to prevent concurrent acceptance/cancellations
  SELECT * INTO v_challenge
    FROM challenges
   WHERE id = p_challenge_id
  FOR UPDATE;

  -- Validation Checks
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 'Challenge not found'::TEXT;
    RETURN;
  END IF;

  IF v_challenge.challenger_id != p_agent_id THEN
    RETURN QUERY SELECT false, 0, 'Not your challenge'::TEXT;
    RETURN;
  END IF;

  IF v_challenge.status != 'open' THEN
    RETURN QUERY SELECT false, 0, ('Cannot cancel a challenge with status ''' || v_challenge.status || '''') ::TEXT;
    RETURN;
  END IF;

  -- Cancel the challenge
  UPDATE challenges 
     SET status = 'cancelled' 
   WHERE id = p_challenge_id;

  -- Refund the escrowed wager safely (additive update)
  UPDATE agents 
     SET balance = balance + v_challenge.wager_amount 
   WHERE id = p_agent_id;

  -- Record the refund transaction
  INSERT INTO transactions (from_agent_id, to_agent_id, amount, note)
  VALUES (
    NULL,
    p_agent_id,
    v_challenge.wager_amount,
    'challenge cancelled — wager returned'
  );

  RETURN QUERY SELECT true, v_challenge.wager_amount, 'Challenge cancelled.'::TEXT;
END;
$$;
