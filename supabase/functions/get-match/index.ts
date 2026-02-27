import { handleCors, json, error } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { verifyAgentKey } from '../_shared/auth.ts'
import { getOpponentHistory } from '../_shared/opponent-history.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'GET') return error('Method not allowed', 405)

  const url = new URL(req.url)
  const matchId = url.pathname.split('/').pop()
  if (!matchId) return error('match_id is required in the URL path')

  // API key is optional — anon can see completed matches, participants
  // get a richer sanitised view of in-progress matches.
  const agent = await verifyAgentKey(req)

  const supabase = createServiceClient()

  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single()

  if (matchError || !match) return error('Match not found', 404)

  // Completed (finished phase) matches are fully public.
  if (match.phase === 'finished') {
    return json({ match })
  }

  // In-progress matches: only participants can see state, and only their
  // own commit/reveal data — never the opponent's.
  if (!agent) return error('Authentication required for in-progress matches', 401)

  const isAgent1 = match.agent1_id === agent.id
  const isAgent2 = match.agent2_id === agent.id

  if (!isAgent1 && !isAgent2) {
    return error('You are not a participant in this match', 403)
  }

  const opponentId = isAgent1 ? match.agent2_id : match.agent1_id
  const { data: opp } = await supabase
    .from('agents')
    .select('name')
    .eq('id', opponentId)
    .single()
  const opponentName = opp?.name ?? null

  // Include opponent history during the strategy phase.
  const opponentHistory =
    match.phase === 'strategy' && opponentName
      ? await getOpponentHistory(supabase, opponentId as string, opponentName)
      : null

  // Sanitise: replace opponent's hash/move/salt with boolean presence flags.
  const sanitised = {
    id: match.id,
    phase: match.phase,
    status: match.status,
    wager_amount: match.wager_amount,
    strategy_deadline: match.strategy_deadline ?? null,
    commit_deadline: match.commit_deadline,
    reveal_deadline: match.reveal_deadline,
    created_at: match.created_at,
    your_role: isAgent1 ? 'agent1' : 'agent2',

    // Own data — full visibility.
    your_move_hash: isAgent1 ? match.agent1_move_hash : match.agent2_move_hash,
    your_move: isAgent1 ? match.agent1_move : match.agent2_move,

    // Opponent data — existence flags only.
    opponent_committed: isAgent1
      ? match.agent2_move_hash !== null
      : match.agent1_move_hash !== null,
    opponent_revealed: isAgent1
      ? match.agent2_move !== null
      : match.agent1_move !== null,

    // Opponent history — only during strategy window, participants only.
    opponent_history: opponentHistory,
  }

  return json({ match: sanitised })
})
