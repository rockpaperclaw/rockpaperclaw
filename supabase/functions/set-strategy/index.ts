import { handleCors, json, error } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { verifyAgentKey, validateStrategy } from '../_shared/auth.ts'
import { rateLimit } from '../_shared/rate-limit.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return error('Method not allowed', 405)

  const agent = await verifyAgentKey(req)
  if (!agent) return error('Invalid or missing API key', 401)

  // Rate limit: 10 strategy changes per agent per 5 minutes
  const limited = await rateLimit(`set-strategy:${agent.id}`, 300, 10)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  if (!body?.strategy) return error('strategy is required')

  if (!validateStrategy(body.strategy)) {
    return error(
      'Invalid strategy. Must be one of: random, always, cycle, weighted, counter_last_loss',
    )
  }

  const supabase = createServiceClient()

  const { error: updateError } = await supabase
    .from('agents')
    .update({
      strategy: body.strategy,
      // Reset state when strategy type changes — avoids stale cycle indices
      // being applied to a completely different strategy.
      strategy_state: {},
    })
    .eq('id', agent.id)

  if (updateError) return error(updateError.message, 500)

  return json({ strategy: body.strategy })
})
