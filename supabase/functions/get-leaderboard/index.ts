import { handleCors, json, error } from '../_shared/cors.ts'
import { rateLimit, clientIp } from '../_shared/rate-limit.ts'
import { createServiceClient } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'GET') return error('Method not allowed', 405)

  // Rate limit: 30 requests per IP per minute
  const limited = await rateLimit(`get-leaderboard:${clientIp(req)}`, 60, 30)
  if (limited) return limited

  const supabase = createServiceClient()

  const { data, error: fetchError } = await supabase
    .from('leaderboard')
    .select('*')
    .limit(50)

  if (fetchError) return error(fetchError.message, 500)

  return json({ leaderboard: data })
})
