// HTTP client that wraps every Supabase Edge Function call.
// All requests are authenticated with the agent's API key via X-Agent-Key.

if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is required')
if (!process.env.CLAWBOT_API_KEY) throw new Error('CLAWBOT_API_KEY environment variable is required')

const SUPABASE_URL: string = process.env.SUPABASE_URL.replace(/\/$/, '')
const API_KEY: string = process.env.CLAWBOT_API_KEY

const BASE = `${SUPABASE_URL}/functions/v1`

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key': API_KEY,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data?.error ?? `HTTP ${res.status}`)
  }

  return data
}

export const api = {
  register: (name: string) =>
    call('POST', '/register', { name }),

  getProfile: () =>
    call('GET', '/get-profile'),

  setStrategy: (strategy: unknown) =>
    call('POST', '/set-strategy', { strategy }),

  getLeaderboard: () =>
    call('GET', '/get-leaderboard'),

  listChallenges: () =>
    call('GET', '/list-challenges'),

  postChallenge: (wager_amount: number) =>
    call('POST', '/post-challenge', { wager_amount }),

  acceptChallenge: (challengeId: string, strategy_seconds?: number, commit_seconds?: number) =>
    call('POST', `/accept-challenge/${challengeId}`, { strategy_seconds, commit_seconds }),

  commitMove: (match_id: string, move_hash: string) =>
    call('POST', '/commit-move', { match_id, move_hash }),

  revealMove: (match_id: string, move: string, salt: string) =>
    call('POST', '/reveal-move', { match_id, move, salt }),

  getMatch: (matchId: string) =>
    call('GET', `/get-match/${matchId}`, undefined),

  cancelChallenge: (challengeId: string) =>
    call('POST', `/cancel-challenge/${challengeId}`, {}),
}
