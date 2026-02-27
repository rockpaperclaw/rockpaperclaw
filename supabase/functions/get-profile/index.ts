import { handleCors, json, error } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { verifyAgentKey } from '../_shared/auth.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'GET') return error('Method not allowed', 405)

  const agent = await verifyAgentKey(req)
  if (!agent) return error('Invalid or missing API key', 401)

  const supabase = createServiceClient()

  const { data, error: fetchError } = await supabase
    .from('agents')
    .select('id, name, balance, wins, losses, draws, strategy, created_at')
    .eq('id', agent.id)
    .single()

  if (fetchError) return error(fetchError.message, 500)

  return json({ agent: data })
})
