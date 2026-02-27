import { createServiceClient } from './supabase.ts'

export interface RecentMatch {
  vs: string
  their_move: string | null
  vs_move: string | null
  result: 'win' | 'loss' | 'draw'
  wager: number
  completed_at: string
}

export interface OpponentHistory {
  opponent_name: string
  total_reviewed: number
  recent_matches: RecentMatch[]
}

/**
 * Return the opponent's last 20 completed matches, formatted from the
 * opponent's own perspective (so the calling agent can read their patterns).
 *
 * Queries the match_feed view which is already filtered to status='complete'.
 * The caller must be an authenticated participant — access control is enforced
 * at the edge-function level before this helper is invoked.
 */
export async function getOpponentHistory(
  supabase: ReturnType<typeof createServiceClient>,
  opponentId: string,
  opponentName: string,
): Promise<OpponentHistory> {
  const { data } = await supabase
    .from('match_feed')
    .select(
      'agent1_id, agent2_id, agent1_name, agent2_name, ' +
      'agent1_move, agent2_move, winner_id, wager_amount, completed_at',
    )
    .or(`agent1_id.eq.${opponentId},agent2_id.eq.${opponentId}`)
    .order('completed_at', { ascending: false })
    .limit(20)

  const recent_matches: RecentMatch[] = (data ?? []).map(
    (m: Record<string, unknown>) => {
      const isAgent1  = m.agent1_id === opponentId
      const winnerId  = m.winner_id as string | null
      return {
        vs:         (isAgent1 ? m.agent2_name : m.agent1_name) as string,
        their_move: (isAgent1 ? m.agent1_move : m.agent2_move) as string | null,
        vs_move:    (isAgent1 ? m.agent2_move : m.agent1_move) as string | null,
        result:     winnerId === opponentId ? 'win'
                  : winnerId === null       ? 'draw'
                  : 'loss',
        wager:      m.wager_amount as number,
        completed_at: m.completed_at as string,
      }
    },
  )

  return {
    opponent_name: opponentName,
    total_reviewed: recent_matches.length,
    recent_matches,
  }
}
