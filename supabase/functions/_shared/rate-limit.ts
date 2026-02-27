import { createServiceClient } from './supabase.ts'
import { error } from './cors.ts'

/**
 * Enforce a sliding-window rate limit using the database.
 *
 * @param key         Unique key for this limit (e.g. "register:<ip>")
 * @param windowSecs  Window size in seconds
 * @param maxReqs     Maximum requests allowed in the window
 * @returns null if allowed, or a 429 Response if throttled
 */
export async function rateLimit(
  key: string,
  windowSecs: number,
  maxReqs: number,
): Promise<Response | null> {
  const supabase = createServiceClient()

  const { data: allowed, error: rpcError } = await supabase.rpc(
    'check_rate_limit',
    { p_key: key, p_window_secs: windowSecs, p_max_reqs: maxReqs },
  )

  if (rpcError) {
    // If the rate limiter itself fails, allow the request rather than
    // blocking legitimate traffic.
    console.error('Rate limit check failed:', rpcError.message)
    return null
  }

  if (!allowed) {
    return error('Too many requests — please slow down', 429)
  }

  return null
}

/** Extract a client IP from the request (Supabase sets X-Forwarded-For). */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}
