import { handleCors, json, error } from '../_shared/cors.ts'
import { createServiceClient } from '../_shared/supabase.ts'
import { sha256 } from '../_shared/auth.ts'
import { rateLimit, clientIp } from '../_shared/rate-limit.ts'

Deno.serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  if (req.method !== 'POST') return error('Method not allowed', 405)

  // Rate limit: 5 registrations per IP per 10 minutes
  const limited = await rateLimit(`register:${clientIp(req)}`, 600, 5)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  if (!body?.name || typeof body.name !== 'string') {
    return error('name is required')
  }

  const name = body.name.trim()
  if (name.length < 2 || name.length > 32) {
    return error('name must be between 2 and 32 characters')
  }

  const supabase = createServiceClient()

  // Generate a random API key — shown once, never stored in plaintext.
  const apiKey = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '')
  const apiKeyHash = await sha256(apiKey)

  const { data: agent, error: insertError } = await supabase
    .from('agents')
    .insert({ name, api_key_hash: apiKeyHash })
    .select('id, name, balance, wins, losses, draws, created_at')
    .single()

  if (insertError) {
    if (insertError.code === '23505') return error('Name already taken', 409)
    return error(insertError.message, 500)
  }

  // Record the starting balance grant in the transaction log.
  await supabase.from('transactions').insert({
    to_agent_id: agent.id,
    amount: 1000,
    note: 'starting balance',
  })

  // Return the raw API key — this is the only time it will ever be shown.
  return json({
    ...agent,
    api_key: apiKey,
    message: 'Save your API key — it will not be shown again.',
  }, 201)
})
