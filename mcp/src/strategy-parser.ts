/**
 * Strategy DSL parser and stringifier.
 *
 * DSL format (case-insensitive, moves can be full name or r/p/s shorthand):
 *
 *   random
 *   rock | paper | scissors            → always play this move
 *   cycle <move> [move] ... [move]     → up to 20 moves, repeats
 *   weighted rock:<n> paper:<n> scissors:<n>  → n = integer %, must sum to 100
 *   counter                            → counter your last losing opponent move
 *
 * Examples:
 *   "rock"
 *   "cycle r p s"
 *   "cycle rock rock scissors paper rock rock scissors paper rock scissors"
 *   "weighted rock:60 paper:20 scissors:20"
 *   "counter"
 */

export type Move = 'rock' | 'paper' | 'scissors'

export type Strategy =
  | { type: 'random' }
  | { type: 'always'; move: Move }
  | { type: 'cycle'; sequence: Move[] }
  | { type: 'weighted'; rock: number; paper: number; scissors: number }
  | { type: 'counter_last_loss' }

export const MAX_CYCLE_LENGTH = 20

const MOVE_ALIASES: Record<string, Move> = {
  r: 'rock',    rock: 'rock',
  p: 'paper',   paper: 'paper',
  s: 'scissors', scissors: 'scissors',
}

function toMove(token: string): Move {
  const move = MOVE_ALIASES[token.toLowerCase()]
  if (!move) throw new Error(
    `"${token}" is not a valid move — use rock/paper/scissors (or r/p/s)`
  )
  return move
}

/** Parse a DSL string into a Strategy object. */
export function parse(dsl: string): Strategy {
  const tokens = dsl.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (tokens.length === 0) throw new Error('Strategy cannot be empty')

  const [first, ...rest] = tokens

  // random
  if (first === 'random') {
    if (rest.length) throw new Error('"random" takes no arguments')
    return { type: 'random' }
  }

  // counter / counter_last_loss
  if (first === 'counter' || first === 'counter_last_loss') {
    if (rest.length) throw new Error('"counter" takes no arguments')
    return { type: 'counter_last_loss' }
  }

  // Single bare move: "rock" → always rock
  if (first in MOVE_ALIASES && rest.length === 0) {
    return { type: 'always', move: toMove(first) }
  }

  // always <move>: explicit form
  if (first === 'always') {
    if (rest.length !== 1) throw new Error('"always" requires exactly one move')
    return { type: 'always', move: toMove(rest[0]) }
  }

  // cycle <move> [move] ...
  if (first === 'cycle') {
    if (rest.length === 0) throw new Error('"cycle" requires at least one move')
    if (rest.length > MAX_CYCLE_LENGTH) {
      throw new Error(
        `Cycle sequence is ${rest.length} moves — maximum is ${MAX_CYCLE_LENGTH}`
      )
    }
    return { type: 'cycle', sequence: rest.map(toMove) }
  }

  // weighted rock:<n> paper:<n> scissors:<n>
  if (first === 'weighted') {
    if (rest.length === 0) throw new Error(
      '"weighted" requires move:percentage pairs, e.g. rock:60 paper:20 scissors:20'
    )

    const weights: Partial<Record<Move, number>> = {}

    for (const token of rest) {
      const colonIdx = token.lastIndexOf(':')
      if (colonIdx === -1) throw new Error(
        `Expected "move:percentage" but got "${token}"`
      )

      const movePart = token.slice(0, colonIdx)
      const pctPart  = token.slice(colonIdx + 1)
      const move     = toMove(movePart)
      const pct      = Number(pctPart)

      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(
        `Invalid percentage for ${move}: "${pctPart}" (must be 0–100)`
      )
      if (move in weights) throw new Error(`Duplicate move in weighted: "${move}"`)

      weights[move] = pct
    }

    const rock     = weights.rock     ?? 0
    const paper    = weights.paper    ?? 0
    const scissors = weights.scissors ?? 0
    const total    = rock + paper + scissors

    if (Math.abs(total - 100) > 0.5) {
      throw new Error(
        `Weights must sum to 100 — got ${total} ` +
        `(rock:${rock} paper:${paper} scissors:${scissors})`
      )
    }

    return {
      type: 'weighted',
      rock:     rock     / 100,
      paper:    paper    / 100,
      scissors: scissors / 100,
    }
  }

  throw new Error(
    `Unknown strategy "${first}" — valid types: random, rock, paper, scissors, ` +
    `always, cycle, weighted, counter`
  )
}

/** Stringify a Strategy object back into a readable DSL string. */
export function stringify(strategy: Strategy): string {
  switch (strategy.type) {
    case 'random':
      return 'random'

    case 'always':
      return strategy.move

    case 'cycle':
      return `cycle ${strategy.sequence.join(' ')}`

    case 'weighted': {
      const r = Math.round(strategy.rock     * 100)
      const p = Math.round(strategy.paper    * 100)
      const s = Math.round(strategy.scissors * 100)
      return `weighted rock:${r} paper:${p} scissors:${s}`
    }

    case 'counter_last_loss':
      return 'counter'

    default: {
      const _exhaustive: never = strategy
      return _exhaustive
    }
  }
}

/**
 * Accept either a DSL string or a raw Strategy object.
 * Throws a descriptive error if parsing fails.
 */
export function coerce(input: unknown): Strategy {
  if (typeof input === 'string') {
    try {
      return parse(input)
    } catch (e) {
      throw new Error(
        `Invalid strategy DSL: ${e instanceof Error ? e.message : String(e)}\n\n` +
        `Valid formats:\n` +
        `  random\n` +
        `  rock | paper | scissors\n` +
        `  cycle rock paper scissors rock rock  (up to ${MAX_CYCLE_LENGTH} moves)\n` +
        `  weighted rock:60 paper:20 scissors:20\n` +
        `  counter`
      )
    }
  }

  if (input && typeof input === 'object') {
    // Assume it's already a valid Strategy object — the Edge Function validates it.
    return input as Strategy
  }

  throw new Error('strategy must be a DSL string or a strategy object')
}
