// Cron Edge Function — called on a schedule (every 15–30s recommended).
// Finds matches past their commit or reveal deadline and resolves them
// using the strategy fallback for any agent that failed to respond in time.
//
// Set up in Supabase Dashboard → Edge Functions → Schedules,
// or via the Supabase CLI cron config.

import { json } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { computeMove, advanceState } from '../_shared/strategy.ts'

Deno.serve(async (_req) => {
  const supabase = createServiceClient()

  // stale_matches view returns all matches past their commit or reveal deadline.
  const { data: stale, error: fetchError } = await supabase
    .from('stale_matches')
    .select('*')

  if (fetchError) return json({ error: fetchError.message }, 500)
  if (!stale || stale.length === 0) return json({ processed: 0 })

  const results = []

  for (const match of stale) {
    try {
      results.push(await processMatch(supabase, match))
    } catch (e) {
      results.push({ match_id: match.id, error: String(e) })
    }
  }

  return json({ processed: results.length, results })
})

async function processMatch(
  supabase: ReturnType<typeof import('../_shared/supabase.ts').createServiceClient>,
  match: Record<string, unknown>,
) {
  // Load both agents' strategy and state.
  const { data: agents } = await supabase
    .from('agents')
    .select('id, strategy, strategy_state')
    .in('id', [match.agent1_id, match.agent2_id])

  const agent1 = agents?.find((a: { id: string }) => a.id === match.agent1_id)
  const agent2 = agents?.find((a: { id: string }) => a.id === match.agent2_id)

  if (!agent1 || !agent2) throw new Error(`Agents not found for match ${match.id}`)

  let agent1Move: string
  let agent2Move: string
  let agent1Fallback: boolean
  let agent2Fallback: boolean
  let newState1: Record<string, unknown>
  let newState2: Record<string, unknown>

  if (match.status === 'pending') {
    // Commit phase timed out — use strategy for any agent that didn't commit.
    const agent1Committed = match.agent1_move_hash !== null
    const agent2Committed = match.agent2_move_hash !== null

    // For agents that didn't commit: compute move from strategy.
    // For agents that did commit but are in a timed-out pending match:
    //   their move_hash is stored but can't be verified (no reveal phase was
    //   reached), so we fall back to strategy for both to keep it fair.
    //
    // Edge case: one agent committed but the other didn't before deadline.
    // The committing agent is penalised too — this discourages posting
    // challenges and going offline.
    const r1 = await computeMove(agent1.strategy, agent1.strategy_state, agent1.id)
    const r2 = await computeMove(agent2.strategy, agent2.strategy_state, agent2.id)

    agent1Move = r1.move
    agent2Move = r2.move
    newState1 = r1.newState
    newState2 = r2.newState
    agent1Fallback = !agent1Committed
    agent2Fallback = !agent2Committed

  } else {
    // waiting_reveals — reveal phase timed out.
    // Agents that revealed in time keep their revealed move.
    // Agents that didn't reveal get a strategy move.
    const agent1Revealed = match.agent1_move !== null
    const agent2Revealed = match.agent2_move !== null

    if (agent1Revealed) {
      agent1Move = match.agent1_move as string
      newState1 = await advanceState(agent1.strategy, agent1.strategy_state, agent1.id)
      agent1Fallback = false
    } else {
      const r1 = await computeMove(agent1.strategy, agent1.strategy_state, agent1.id)
      agent1Move = r1.move
      newState1 = r1.newState
      agent1Fallback = true
    }

    if (agent2Revealed) {
      agent2Move = match.agent2_move as string
      newState2 = await advanceState(agent2.strategy, agent2.strategy_state, agent2.id)
      agent2Fallback = false
    } else {
      const r2 = await computeMove(agent2.strategy, agent2.strategy_state, agent2.id)
      agent2Move = r2.move
      newState2 = r2.newState
      agent2Fallback = true
    }
  }

  const { data: resolved, error: resolveError } = await supabase.rpc(
    'resolve_match',
    {
      p_match_id: match.id,
      p_agent1_move: agent1Move!,
      p_agent2_move: agent2Move!,
      p_agent1_fallback: agent1Fallback!,
      p_agent2_fallback: agent2Fallback!,
      p_agent1_new_state: newState1!,
      p_agent2_new_state: newState2!,
    },
  )

  if (resolveError) throw new Error(resolveError.message)

  const result = resolved as Record<string, unknown>
  return {
    match_id: match.id,
    winner_id: result.winner_id,
    agent1_move: agent1Move,
    agent2_move: agent2Move,
    agent1_fallback: agent1Fallback,
    agent2_fallback: agent2Fallback,
  }
}
