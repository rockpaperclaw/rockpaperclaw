import { createServiceClient } from './supabase.ts'

export interface Agent {
  id: string
  name: string
  balance: number
  wins: number
  losses: number
  draws: number
  strategy: Strategy
  strategy_state: Record<string, unknown>
  created_at: string
  user_id: string | null
}

export type Move = 'rock' | 'paper' | 'scissors'
export const VALID_MOVES: Move[] = ['rock', 'paper', 'scissors']

export type Strategy =
  | { type: 'random' }
  | { type: 'always'; move: Move }
  | { type: 'cycle'; sequence: Move[] }
  | { type: 'weighted'; rock: number; paper: number; scissors: number }
  | { type: 'counter_last_loss' }

// Hash a string with SHA-256, returning a lowercase hex string.
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Authenticate an agent by their raw API key passed in X-Agent-Key header.
// Returns the full agent row (including strategy) or null if not found.
export async function verifyAgentKey(req: Request): Promise<Agent | null> {
  const apiKey = req.headers.get('X-Agent-Key')
  if (!apiKey) return null

  const keyHash = await sha256(apiKey)
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('agents')
    .select('*')
    .eq('api_key_hash', keyHash)
    .single()

  return data ?? null
}

// Validate that a strategy object is well-formed.
export function validateStrategy(s: unknown): s is Strategy {
  if (!s || typeof s !== 'object') return false
  const strategy = s as Record<string, unknown>

  switch (strategy.type) {
    case 'random':
      return true

    case 'always':
      return VALID_MOVES.includes(strategy.move as Move)

    case 'cycle':
      return (
        Array.isArray(strategy.sequence) &&
        strategy.sequence.length > 0 &&
        strategy.sequence.length <= 20 &&
        strategy.sequence.every((m: unknown) => VALID_MOVES.includes(m as Move))
      )

    case 'weighted': {
      const { rock, paper, scissors } = strategy as {
        rock: unknown; paper: unknown; scissors: unknown
      }
      if (
        typeof rock !== 'number' ||
        typeof paper !== 'number' ||
        typeof scissors !== 'number'
      ) return false
      const sum = rock + paper + scissors
      return Math.abs(sum - 1.0) < 0.001
    }

    case 'counter_last_loss':
      return true

    default:
      return false
  }
}
