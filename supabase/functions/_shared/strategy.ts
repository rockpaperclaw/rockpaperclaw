import type { Move, Strategy } from './auth.ts'
import { VALID_MOVES } from './auth.ts'
import { createServiceClient } from './supabase.ts'

export interface MoveResult {
  move: Move
  newState: Record<string, unknown>
}

// Compute the next move for a given strategy and current state.
// For counter_last_loss, pass the agentId so we can look up their last loss.
export async function computeMove(
  strategy: Strategy,
  state: Record<string, unknown>,
  agentId?: string,
): Promise<MoveResult> {
  switch (strategy.type) {
    case 'random':
      return {
        move: VALID_MOVES[Math.floor(Math.random() * 3)],
        newState: state,
      }

    case 'always':
      return { move: strategy.move, newState: state }

    case 'cycle': {
      const index = typeof state.index === 'number' ? state.index : 0
      const move = strategy.sequence[index % strategy.sequence.length]
      return {
        move,
        newState: { index: (index + 1) % strategy.sequence.length },
      }
    }

    case 'weighted': {
      const rand = Math.random()
      let move: Move
      if (rand < strategy.rock) move = 'rock'
      else if (rand < strategy.rock + strategy.paper) move = 'paper'
      else move = 'scissors'
      return { move, newState: state }
    }

    case 'counter_last_loss': {
      const counters: Record<Move, Move> = {
        rock: 'paper',
        paper: 'scissors',
        scissors: 'rock',
      }

      let lastLostTo: Move | null = null

      if (agentId) {
        const supabase = createServiceClient()
        // Find the most recent match this agent lost and what beat them.
        const { data } = await supabase
          .from('matches')
          .select('agent1_id, agent2_id, agent1_move, agent2_move, winner_id')
          .neq('winner_id', agentId)          // they lost (winner was opponent)
          .not('winner_id', 'is', null)        // not a draw
          .or(`agent1_id.eq.${agentId},agent2_id.eq.${agentId}`)
          .eq('status', 'complete')
          .order('completed_at', { ascending: false })
          .limit(1)
          .single()

        if (data) {
          // The move that beat them is the opponent's move in that match.
          lastLostTo = (
            data.agent1_id === agentId ? data.agent2_move : data.agent1_move
          ) as Move
        }
      }

      const move = lastLostTo
        ? counters[lastLostTo]
        : VALID_MOVES[Math.floor(Math.random() * 3)]

      return { move, newState: state }
    }
  }
}

// Advance strategy state without using the computed move.
// Called on the live path so cycle indices stay in sync even when the
// agent submitted their own move rather than relying on the strategy.
export async function advanceState(
  strategy: Strategy,
  state: Record<string, unknown>,
  agentId?: string,
): Promise<Record<string, unknown>> {
  const result = await computeMove(strategy, state, agentId)
  return result.newState
}
