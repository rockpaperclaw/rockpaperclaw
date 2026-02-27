import { verifyAgentKey } from '../_shared/auth.ts'
import { error, handleCors, json } from '../_shared/cors.ts'
import { getOpponentHistory } from '../_shared/opponent-history.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { rateLimit } from '../_shared/rate-limit.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return error('Method not allowed', 405)

  const agent = await verifyAgentKey(req)
  if (!agent) return error('Invalid or missing API key', 401)

  // Rate limit: 20 accepts per agent per 5 minutes
  const limited = await rateLimit(`accept-challenge:${agent.id}`, 300, 20)
  if (limited) return limited

  const url = new URL(req.url)
  // Expect: /accept-challenge/<challenge_id>
  const challengeId = url.pathname.split('/').pop()
  if (!challengeId) return error('challenge_id is required in the URL path')

  const body = await req.json().catch(() => ({}))
  
  // Enforce reasonable bounds to prevent griefing/lockups
  // Default to 60 seconds. Minimum 10, Maximum 120.
  const reqStrategySeconds = Number(body?.strategy_seconds)
  const strategySeconds = !Number.isNaN(reqStrategySeconds) 
    ? Math.max(10, Math.min(120, reqStrategySeconds)) 
    : 60
    
  const reqCommitSeconds = Number(body?.commit_seconds)
  const commitSeconds = !Number.isNaN(reqCommitSeconds) 
    ? Math.max(10, Math.min(120, reqCommitSeconds)) 
    : 60

  const supabase = createServiceClient()

  // create_match() atomically:
  //   validates challenge, escrows accepter balance, creates match in 'pending'
  //   with a strategy_deadline before the commit window opens.
  const { data, error: rpcError } = await supabase.rpc('create_match', {
    p_challenge_id:     challengeId,
    p_accepter_id:      agent.id,
    p_strategy_seconds: strategySeconds,
    p_commit_seconds:   commitSeconds,
  })

  if (rpcError) return error(rpcError.message, 400)

  const match = data as Record<string, unknown>

  // Accepter's opponent = challenger (agent1).
  // Fetch their name then build history — only returned to this authenticated
  // participant, never publicly exposed.
  const { data: challenger } = await supabase
    .from('agents')
    .select('id, name')
    .eq('id', match.agent1_id as string)
    .single()

  const opponentHistory = challenger
    ? await getOpponentHistory(supabase, challenger.id, challenger.name)
    : null

  return json({
    match_id:          match.id,
    phase:             match.phase,
    status:            match.status,
    strategy_deadline: match.strategy_deadline,
    commit_deadline:   match.commit_deadline,
    your_role:         'agent2',
    opponent_history:  opponentHistory,
    message: `Study your opponent — commit after ${match.strategy_deadline}`,
  })
})
