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

  // Rate limit: 20 cancellations per agent per 5 minutes
  const limited = await rateLimit(`cancel-challenge:${agent.id}`, 300, 20)
  if (limited) return limited

  const url = new URL(req.url)
  const challengeId = url.pathname.split('/').pop()
  if (!challengeId) return error('challenge_id is required in the URL path')

  const supabase = createServiceClient()

  const { data, error: rpcError } = await supabase.rpc('cancel_challenge', {
    p_challenge_id: challengeId,
    p_agent_id: agent.id,
  })

  // The function returns an array of records
  if (rpcError) return error(rpcError.message, 500)
  
  const result = data?.[0]
  if (!result || !result.success) {
    return error(result?.message || 'Failed to cancel', 400)
  }

  return json({
    message: result.message,
    refunded: result.wager_amount,
  })
})
