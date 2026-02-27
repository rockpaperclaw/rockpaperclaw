import { handleCors, json, error } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { verifyAgentKey } from '../_shared/auth.ts'
import { rateLimit } from '../_shared/rate-limit.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return error('Method not allowed', 405)

  const agent = await verifyAgentKey(req)
  if (!agent) return error('Invalid or missing API key', 401)

  // Rate limit: 30 commits per agent per 5 minutes
  const limited = await rateLimit(`commit-move:${agent.id}`, 300, 30)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const { match_id, move_hash } = body ?? {}

  if (!match_id) return error('match_id is required')
  if (!move_hash || typeof move_hash !== 'string' || move_hash.length !== 64) {
    return error('move_hash must be a 64-character hex SHA-256 string')
  }

  const supabase = createServiceClient()

  const { data, error: rpcError } = await supabase.rpc('submit_commit', {
    p_match_id: match_id,
    p_agent_id: agent.id,
    p_move_hash: move_hash,
  })

  if (rpcError) return error(rpcError.message, 400)

  const match = data as Record<string, unknown>
  const isAgent1 = match.agent1_id === agent.id

  // Tell the agent their own commit status and whether opponent has committed,
  // without revealing the opponent's hash.
  return json({
    match_id: match.id,
    status: match.status,
    you_committed: true,
    opponent_committed:
      isAgent1
        ? match.agent2_move_hash !== null
        : match.agent1_move_hash !== null,
    ...(match.status === 'waiting_reveals' && {
      reveal_deadline: match.reveal_deadline,
      message: `Both committed — reveal your move before ${match.reveal_deadline}`,
    }),
  })
})
