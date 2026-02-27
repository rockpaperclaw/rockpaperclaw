import { VALID_MOVES, verifyAgentKey } from '../_shared/auth.ts'
import { error, handleCors, json } from '../_shared/cors.ts'
import { rateLimit } from '../_shared/rate-limit.ts'
import { advanceState } from '../_shared/strategy.ts'
import { createServiceClient } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return error('Method not allowed', 405)

  const agent = await verifyAgentKey(req)
  if (!agent) return error('Invalid or missing API key', 401)

  // Rate limit: 30 reveals per agent per 5 minutes
  const limited = await rateLimit(`reveal-move:${agent.id}`, 300, 30)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const { match_id, move, salt } = body ?? {}

  if (!match_id) return error('match_id is required')
  if (!VALID_MOVES.includes(move)) return error('move must be rock, paper, or scissors')
  if (!salt || typeof salt !== 'string' || salt.length < 16) {
    return error('salt must be a string of at least 16 characters for cryptographic safety')
  }

  const supabase = createServiceClient()

  // submit_reveal verifies sha256(move + salt) against the stored hash.
  const { data, error: rpcError } = await supabase.rpc('submit_reveal', {
    p_match_id: match_id,
    p_agent_id: agent.id,
    p_move: move,
    p_salt: salt,
  })

  if (rpcError) return error(rpcError.message, 400)

  const match = data as Record<string, unknown>

  // If both moves are now revealed, resolve the match immediately.
  if (match.agent1_move !== null && match.agent2_move !== null) {
    return await resolveMatch(supabase, match, agent.id)
  }

  // One reveal in, waiting for opponent.
  return json({
    match_id: match.id,
    status: match.status,
    your_move: move,
    opponent_revealed: false,
    message: 'Waiting for opponent to reveal.',
  })
})

async function resolveMatch(
  supabase: ReturnType<typeof import('../_shared/supabase.ts').createServiceClient>,
  match: Record<string, unknown>,
  triggeringAgentId: string,
) {
  // Load both agents' full profiles for strategy state advancement.
  const { data: agents } = await supabase
    .from('agents')
    .select('id, strategy, strategy_state')
    .in('id', [match.agent1_id, match.agent2_id])

  const agent1 = agents?.find((a: { id: string }) => a.id === match.agent1_id)
  const agent2 = agents?.find((a: { id: string }) => a.id === match.agent2_id)

  if (!agent1 || !agent2) {
    return json({ error: 'Could not load agents for resolution' }, 500)
  }

  // Advance strategy state for both agents (keeps cycle indices in sync
  // even though both agents submitted their own moves live).
  const [newState1, newState2] = await Promise.all([
    advanceState(agent1.strategy, agent1.strategy_state, agent1.id),
    advanceState(agent2.strategy, agent2.strategy_state, agent2.id),
  ])

  const { data: resolved, error: resolveError } = await supabase.rpc(
    'resolve_match',
    {
      p_match_id: match.id,
      p_agent1_move: match.agent1_move,
      p_agent2_move: match.agent2_move,
      p_agent1_fallback: false,
      p_agent2_fallback: false,
      p_agent1_new_state: newState1,
      p_agent2_new_state: newState2,
    },
  )

  if (resolveError) {
    return json({ error: resolveError.message }, 500)
  }

  const result = resolved as Record<string, unknown>
  const youAreAgent1 = result.agent1_id === triggeringAgentId
  const yourMove = youAreAgent1 ? result.agent1_move : result.agent2_move
  const opponentMove = youAreAgent1 ? result.agent2_move : result.agent1_move

  let outcome: string
  if (result.winner_id === null) outcome = 'draw'
  else if (result.winner_id === triggeringAgentId) outcome = 'win'
  else outcome = 'loss'

  return json({
    match_id: result.id,
    phase: 'finished',
    status: 'complete',
    your_move: yourMove,
    opponent_move: opponentMove,
    outcome,
    winner_id: result.winner_id,
    wager_amount: result.wager_amount,
  })
}
