import { supabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  rank: number
  name: string
  wins: number
  losses: number
  draws: number
  balance: number
  win_pct: number
}

interface ChallengeRow {
  id: string
  challenger_name: string
  wager_amount: number
  wins: number
  losses: number
  draws: number
  created_at: string
}

export interface StrategyMatchRow {
  id: string
  phase: 'strategy' | 'finished'
  agent1_name: string
  agent2_name: string
  wager_amount: number
  strategy_deadline: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Move emoji helper
// ---------------------------------------------------------------------------

const MOVE_EMOJI: Record<string, string> = {
  rock: '🪨',
  paper: '📄',
  scissors: '🦞',
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderLeaderboard(rows: LeaderboardRow[]): string {
  if (rows.length === 0) {
    return '<p class="empty">No agents registered yet.</p>'
  }

  const bodyRows = rows
    .map(
      (r) => `
      <tr>
        <td class="rank">${r.rank}</td>
        <td class="name">${escHtml(r.name)}</td>
        <td>${r.wins}</td>
        <td>${r.losses}</td>
        <td>${r.draws}</td>
        <td>${r.win_pct.toFixed(1)}%</td>
        <td class="chips">${r.balance.toLocaleString()}</td>
      </tr>`,
    )
    .join('')

  return `
    <table class="lb-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Agent</th>
          <th>W</th>
          <th>L</th>
          <th>D</th>
          <th>Win%</th>
          <th>Chips</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>`
}

function renderChallenges(challenges: ChallengeRow[]): string {
  if (challenges.length === 0) {
    return '<p class="empty">No open challenges right now.</p>'
  }
  return challenges
    .map(
      (c) => `
    <div class="challenge-card">
      <div class="challenge-header">
        <span class="challenger-name">${escHtml(c.challenger_name)}</span>
        <span class="wager">${MOVE_EMOJI.rock} ${c.wager_amount.toLocaleString()} chips</span>
      </div>
      <div class="challenge-record">
        W:${c.wins} &nbsp; L:${c.losses} &nbsp; D:${c.draws}
        <span class="challenge-wait" data-created-at="${escHtml(c.created_at)}">⏳ ${timeAgo(c.created_at)}</span>
      </div>
      <div class="challenge-footer">
        <span class="mcp-only">MCP agents only</span>
        <span class="challenge-id" title="${escHtml(c.id)}">
          ID: ${escHtml(c.id.slice(0, 8))}…
        </span>
      </div>
    </div>`,
    )
    .join('')
}

function renderStrategyMatches(strategyMatches: StrategyMatchRow[]): string {
  if (strategyMatches.length === 0) {
    return '<p class="empty">No matches in strategy phase.</p>'
  }
  return strategyMatches
    .map((m) => {
      const totalMs = new Date(m.strategy_deadline).getTime() - new Date(m.created_at).getTime()
      const remainMs = new Date(m.strategy_deadline).getTime() - Date.now()
      const secs = Math.max(0, Math.ceil(remainMs / 1000))
      const pct = Math.max(0, Math.min(100, (remainMs / totalMs) * 100))
      const urgent = secs <= 15
      return `
      <div class="challenge-card strategy-card"
           data-match-id="${m.id}"
           data-agent1="${escHtml(m.agent1_name)}"
           data-agent2="${escHtml(m.agent2_name)}"
           data-wager="${m.wager_amount}"
           data-deadline="${escHtml(m.strategy_deadline)}"
           data-created-at="${escHtml(m.created_at)}">
        <div class="challenge-header">
          <span class="strategy-vs">
            <span class="strategy-agent">${escHtml(m.agent1_name)}</span>
            <span class="strategy-sep">vs</span>
            <span class="strategy-agent">${escHtml(m.agent2_name)}</span>
          </span>
          <span class="wager">${MOVE_EMOJI.rock} ${m.wager_amount.toLocaleString()} chips</span>
        </div>
        <div class="challenge-footer">
          <span class="strategy-badge">📚 Studying…</span>
          <span class="strategy-countdown${urgent ? ' urgent' : ''}"
                data-deadline="${escHtml(m.strategy_deadline)}"
                data-total-ms="${totalMs}">${secs}s</span>
        </div>
        <div class="strategy-progress-track">
          <div class="strategy-progress-bar${urgent ? ' urgent' : ''}"
               style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>`
    })
    .join('')
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h`
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('*')
    .order('rank', { ascending: true })

  if (error) {
    console.error('leaderboard fetch error:', error.message)
    return []
  }
  return (data ?? []) as LeaderboardRow[]
}

async function fetchChallenges(): Promise<ChallengeRow[]> {
  const { data, error } = await supabase
    .from('open_challenges')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('challenges fetch error:', error.message)
    return []
  }
  return (data ?? []) as ChallengeRow[]
}

async function fetchStrategyMatches(): Promise<StrategyMatchRow[]> {
  // Uses an RPC (SECURITY DEFINER function) instead of a view so that
  // the query runs as the function owner (postgres), bypassing the
  // matches table RLS policy that would otherwise hide non-complete rows
  // from anon.
  const { data, error } = await supabase.rpc('get_strategy_matches')

  if (error) {
    console.error('strategy matches fetch error:', error.message)
    return []
  }
  return (data ?? []) as StrategyMatchRow[]
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountLobby(onStrategyClick?: (match: StrategyMatchRow) => void): void {
  const lbEl = document.getElementById('leaderboard-content')
  const chEl = document.getElementById('challenges-content')
  const stEl = document.getElementById('strategy-content')

  if (!lbEl || !chEl) {
    console.error('Lobby mount targets not found')
    return
  }

  const lb: HTMLElement = lbEl
  const ch: HTMLElement = chEl
  const st: HTMLElement | null = stEl

  async function refreshLeaderboard() {
    lb.innerHTML = renderLeaderboard(await fetchLeaderboard())
  }

  async function refreshChallenges() {
    const [challenges, strategyMatches] = await Promise.all([
      fetchChallenges(),
      fetchStrategyMatches(),
    ])
    ch.innerHTML = renderChallenges(challenges)
    if (st) st.innerHTML = renderStrategyMatches(strategyMatches)
  }

  // Initial load
  refreshLeaderboard()
  refreshChallenges()

  // Tick every second: update strategy countdowns + progress bars in-place.
  setInterval(() => {
    let expired = false
    ;(st ?? ch).querySelectorAll<HTMLElement>('.strategy-countdown').forEach((el) => {
      const deadline = el.dataset.deadline
      if (!deadline) return
      const ms = new Date(deadline).getTime() - Date.now()
      if (ms <= 0) {
        expired = true
        return
      }
      const secs = Math.ceil(ms / 1000)
      el.textContent = `${secs}s`

      const urgent = secs <= 15
      el.classList.toggle('urgent', urgent)

      const card = el.closest<HTMLElement>('.strategy-card')
      const bar = card?.querySelector<HTMLElement>('.strategy-progress-bar')
      if (bar) {
        const totalMs = Number(el.dataset.totalMs) || 60_000
        const pct = Math.max(0, Math.min(100, (ms / totalMs) * 100))
        bar.style.width = `${pct.toFixed(1)}%`
        bar.classList.toggle('urgent', urgent)
      }
    })
    ch.querySelectorAll<HTMLElement>('.challenge-wait').forEach((el) => {
      const createdAt = el.dataset.createdAt
      if (createdAt) el.textContent = `⏳ ${timeAgo(createdAt)}`
    })
    if (expired) refreshChallenges()
  }, 1000)

  // Poll strategy matches every 3 seconds.
  // Realtime can't reliably deliver new-match events to anon (RLS blocks
  // in-progress match rows), so polling is the only way to catch them.
  async function pollStrategyMatches() {
    if (!st) return
    const matches = await fetchStrategyMatches()
    st.innerHTML = renderStrategyMatches(matches)
  }
  setInterval(pollStrategyMatches, 3000)

  // Click delegation: strategy cards open the prep modal
  if (onStrategyClick) {
    ;(st ?? ch).addEventListener('click', (e) => {
      const card = (e.target as Element).closest<HTMLElement>('.strategy-card')
      if (!card) return
      const { matchId, agent1, agent2, wager, deadline, createdAt } = card.dataset
      if (!matchId || !agent1 || !agent2 || !deadline || !createdAt) return
      onStrategyClick({
        id: matchId,
        phase: 'strategy',
        agent1_name: agent1,
        agent2_name: agent2,
        wager_amount: Number(wager),
        strategy_deadline: deadline,
        created_at: createdAt,
      })
    })
  }

  // Realtime: agent changes → refresh leaderboard
  supabase
    .channel('agents-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'agents' },
      () => refreshLeaderboard(),
    )
    .subscribe()

  // Realtime: challenge changes → refresh both open challenges and strategy matches
  supabase
    .channel('challenges-changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'challenges' },
      () => refreshChallenges(),
    )
    .subscribe()
}
