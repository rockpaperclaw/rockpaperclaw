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

  // Rate limit: 20 challenges per agent per 5 minutes
  const limited = await rateLimit(`post-challenge:${agent.id}`, 300, 20)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const wager = Number(body?.wager_amount)

  if (!Number.isInteger(wager) || wager <= 0) {
    return error('wager_amount must be a positive integer')
  }

  const supabase = createServiceClient()

  // Atomically check balance and escrow the wager (prevents race conditions).
  const { data: escrowed, error: escrowError } = await supabase.rpc(
    'escrow_wager',
    { p_agent_id: agent.id, p_amount: wager },
  )

  if (escrowError) return error(escrowError.message, 500)
  if (!escrowed) {
    return error(`Insufficient balance — wager is ${wager} chips`)
  }

  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .insert({ challenger_id: agent.id, wager_amount: wager })
    .select()
    .single()

  if (challengeError) {
    // Refund escrow on failure — additive update is safe without locking.
    await supabase.rpc('refund_wager', {
      p_agent_id: agent.id,
      p_amount: wager,
    })
    return error(challengeError.message, 500)
  }

  return json({ challenge }, 201)
})
