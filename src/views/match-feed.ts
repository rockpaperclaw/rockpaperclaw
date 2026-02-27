import { supabase } from '../supabase.js'
import type { ReplayMatch } from './replay.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchFeedRow {
  id: string
  agent1_name: string
  agent2_name: string
  agent1_move: string | null
  agent2_move: string | null
  winner_name: string | null
  wager_amount: number
  completed_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOVE_EMOJI: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '🦞' }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderFeed(
  rows: MatchFeedRow[],
  onReplay: (m: ReplayMatch) => void,
): HTMLElement {
  const wrap = document.createElement('div')

  if (rows.length === 0) {
    wrap.innerHTML = '<p class="empty">No completed matches yet.</p>'
    return wrap
  }

  for (const m of rows) {
    const ea = m.agent1_move ? (MOVE_EMOJI[m.agent1_move] ?? '❓') : '❓'
    const eb = m.agent2_move ? (MOVE_EMOJI[m.agent2_move] ?? '❓') : '❓'

    let resultHtml: string
    let resultCls: string
    if (!m.winner_name) {
      resultHtml = '🤝 Draw'
      resultCls = 'feed-draw'
    } else {
      resultHtml = `🏆 ${esc(m.winner_name)}`
      resultCls = 'feed-win'
    }

    const row = document.createElement('div')
    row.className = 'feed-row'
    row.innerHTML = `
      <span class="feed-time">${timeAgo(m.completed_at)}</span>
      <span class="feed-matchup">
        <span class="feed-agent">${esc(m.agent1_name)}</span>
        <span class="feed-glyph">${ea}</span>
        <span class="feed-sep">vs</span>
        <span class="feed-glyph">${eb}</span>
        <span class="feed-agent">${esc(m.agent2_name)}</span>
      </span>
      <span class="feed-result ${resultCls}">${resultHtml}</span>
      <span class="feed-chips">🪙 ${m.wager_amount}</span>
      <button class="feed-replay-btn" aria-label="Watch replay">▶ Replay</button>
    `

    row.querySelector('.feed-replay-btn')!.addEventListener('click', () => onReplay(m))
    wrap.appendChild(row)
  }

  return wrap
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountMatchFeed(onReplay: (m: ReplayMatch) => void): void {
  const elMaybe = document.getElementById('match-feed-content')
  if (!elMaybe) return
  const el: HTMLElement = elMaybe

  async function refresh() {
    const { data, error } = await supabase
      .from('match_feed')
      .select('*')
      .limit(20)

    if (error) {
      console.error('match feed error:', error.message)
      return
    }

    el.innerHTML = ''
    el.appendChild(renderFeed((data ?? []) as MatchFeedRow[], onReplay))
  }

  refresh()

  // Realtime: new match completions
  supabase
    .channel('matches-feed')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'matches' },
      () => refresh(),
    )
    .subscribe()
}
