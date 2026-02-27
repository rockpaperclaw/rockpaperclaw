import { supabase } from '../supabase.js'
import type { StrategyMatchRow } from './lobby.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistoryEntry {
  vs: string
  their_move: string | null
  opp_move: string | null
  result: 'win' | 'loss' | 'draw'
  wager: number
}

interface MatchResult {
  agent1_move: string | null
  agent2_move: string | null
  winner_name: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOVE_EMOJI: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '🦞' }
const MOVE_LABEL: Record<string, string> = { rock: 'Rock', paper: 'Paper', scissors: 'Claw' }
const COUNTDOWN_STEPS = ['🪨  Rock…', '📄  Paper…', '🦞  Claw!']

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function fetchHistory(agentName: string): Promise<HistoryEntry[]> {
  const { data } = await supabase
    .from('match_feed')
    .select('agent1_name, agent2_name, agent1_move, agent2_move, winner_name, wager_amount')
    .or(`agent1_name.eq.${agentName},agent2_name.eq.${agentName}`)
    .order('completed_at', { ascending: false })
    .limit(20)

  return (data ?? []).map((row: Record<string, unknown>) => {
    const isAgent1 = row.agent1_name === agentName
    const winner = row.winner_name as string | null
    return {
      vs: (isAgent1 ? row.agent2_name : row.agent1_name) as string,
      their_move: (isAgent1 ? row.agent1_move : row.agent2_move) as string | null,
      opp_move: (isAgent1 ? row.agent2_move : row.agent1_move) as string | null,
      result: winner === agentName ? 'win' : winner === null ? 'draw' : 'loss',
      wager: row.wager_amount as number,
    }
  })
}

async function pollForResult(matchId: string): Promise<MatchResult | null> {
  const { data } = await supabase
    .from('match_feed')
    .select('agent1_move, agent2_move, winner_name')
    .eq('id', matchId)
    .maybeSingle()
  return data as MatchResult | null
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return '<p class="sprep-no-history">No matches yet</p>'
  }
  return entries
    .map((e) => {
      const tm = e.their_move ? (MOVE_EMOJI[e.their_move] ?? '❓') : '❓'
      const om = e.opp_move ? (MOVE_EMOJI[e.opp_move] ?? '❓') : '❓'
      const cls = e.result === 'win' ? 'sprep-w' : e.result === 'loss' ? 'sprep-l' : 'sprep-d'
      const label = e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : 'D'
      const wagerCls = e.result === 'win' ? 'sprep-wager-win' : e.result === 'loss' ? 'sprep-wager-loss' : 'sprep-wager-draw'
      const wagerPrefix = e.result === 'win' ? '+' : e.result === 'loss' ? '-' : ''
      return `
        <div class="sprep-match-row">
          <span class="sprep-result-badge ${cls}">${label}</span>
          <span class="sprep-match-vs">vs ${esc(e.vs)}</span>
          <span class="sprep-match-moves">${tm}${om}</span>
          <span class="sprep-match-wager ${wagerCls}">${wagerPrefix}${e.wager}</span>
        </div>`
    })
    .join('')
}

// ---------------------------------------------------------------------------
// Mount — returns a show(match) function
// ---------------------------------------------------------------------------

export function mountStrategyPrep(): (match: StrategyMatchRow) => void {
  const overlay = document.createElement('div')
  overlay.className = 'replay-overlay'
  document.body.appendChild(overlay)

  overlay.innerHTML = `
    <div class="replay-modal mdet-modal">
      <button class="replay-close" aria-label="Close">✕</button>

      <!-- countdown header -->
      <div class="mdet-header" id="mdet-header">
        <div class="mdet-header-row">
          <span class="mdet-status" id="mdet-status">📚 Strategy Phase</span>
          <span class="strategy-countdown mdet-countdown" id="mdet-countdown">—</span>
        </div>
        <div class="strategy-progress-track">
          <div class="strategy-progress-bar" id="mdet-pbar" style="width:100%"></div>
        </div>
      </div>

      <!-- bot arena (always visible) -->
      <div class="mdet-arena">
        <div class="mdet-side" id="mdet-side-a">
          <div class="mdet-bot" id="mdet-bot-a">🦞</div>
          <div class="mdet-name" id="mdet-name-a"></div>
          <div class="replay-move mdet-move" id="mdet-move-a"></div>
        </div>
        <div class="mdet-center">
          <div class="replay-countdown mdet-anim" id="mdet-anim"></div>
          <div class="replay-vs mdet-vs" id="mdet-vs">VS</div>
          <div class="replay-result mdet-result" id="mdet-result"></div>
          <span class="replay-wager mdet-wager" id="mdet-wager"></span>
        </div>
        <div class="mdet-side mdet-side-right" id="mdet-side-b">
          <div class="mdet-bot mdet-bot-flip" id="mdet-bot-b">🦞</div>
          <div class="mdet-name" id="mdet-name-b"></div>
          <div class="replay-move mdet-move" id="mdet-move-b"></div>
        </div>
      </div>

      <!-- history panels (visible during strategy phase, hidden during animation) -->
      <div class="mdet-history-wrap" id="mdet-history">
        <div class="mdet-hist-col">
          <p class="sprep-history-label" id="mdet-hlabel-a">Last 20 Matches</p>
          <div class="sprep-history" id="mdet-hist-a"><p class="sprep-no-history">Loading…</p></div>
        </div>
        <div class="mdet-hist-col">
          <p class="sprep-history-label" id="mdet-hlabel-b">Last 20 Matches</p>
          <div class="sprep-history" id="mdet-hist-b"><p class="sprep-no-history">Loading…</p></div>
        </div>
      </div>
    </div>
  `

  // ── element refs ──────────────────────────────────────────────────────────
  const q = <T extends Element>(sel: string) => overlay.querySelector<T>(sel)!

  const statusEl   = q<HTMLElement>('#mdet-status')
  const countdownEl = q<HTMLElement>('#mdet-countdown')
  const pbar       = q<HTMLElement>('#mdet-pbar')
  const sideA      = q<HTMLElement>('#mdet-side-a')
  const sideB      = q<HTMLElement>('#mdet-side-b')
  const nameA      = q<HTMLElement>('#mdet-name-a')
  const nameB      = q<HTMLElement>('#mdet-name-b')
  const moveA      = q<HTMLElement>('#mdet-move-a')
  const moveB      = q<HTMLElement>('#mdet-move-b')
  const animEl     = q<HTMLElement>('#mdet-anim')
  const vsEl       = q<HTMLElement>('#mdet-vs')
  const resultEl   = q<HTMLElement>('#mdet-result')
  const wagerEl    = q<HTMLElement>('#mdet-wager')
  const historyWrap = q<HTMLElement>('#mdet-history')
  const histA      = q<HTMLElement>('#mdet-hist-a')
  const histB      = q<HTMLElement>('#mdet-hist-b')

  // ── timers ────────────────────────────────────────────────────────────────
  let tickInterval: ReturnType<typeof setInterval> | null = null
  let resultPoll:   ReturnType<typeof setInterval> | null = null
  const timeouts: ReturnType<typeof setTimeout>[] = []

  function clearAll() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null }
    if (resultPoll)   { clearInterval(resultPoll);   resultPoll = null }
    timeouts.forEach(clearTimeout)
    timeouts.length = 0
  }

  function after(ms: number, fn: () => void) {
    timeouts.push(setTimeout(fn, ms))
  }

  // ── close ─────────────────────────────────────────────────────────────────
  function close() {
    overlay.classList.remove('active')
    clearAll()
  }

  q('.replay-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  // ── animate result ────────────────────────────────────────────────────────
  function animateResult(match: StrategyMatchRow, result: MatchResult) {
    clearAll()

    // Hide history, show arena fully
    historyWrap.classList.add('mdet-hidden')
    statusEl.textContent = '⚔️ Match!'
    countdownEl.textContent = ''
    pbar.style.width = '0%'

    // Reset move slots
    moveA.textContent = '❓'
    moveB.textContent = '❓'
    moveA.className = 'replay-move mdet-move'
    moveB.className = 'replay-move mdet-move'
    sideA.className = 'mdet-side'
    sideB.className = 'mdet-side'
    resultEl.textContent = ''
    resultEl.className = 'replay-result mdet-result'
    vsEl.style.display = 'block'
    animEl.textContent = ''

    // Rock… Paper… Claw! sequence
    COUNTDOWN_STEPS.forEach((text, i) => {
      after(i * 600, () => {
        animEl.textContent = text
        vsEl.style.display = 'none'
      })
    })

    // Reveal moves
    after(1900, () => {
      animEl.textContent = ''
      vsEl.style.display = 'none'

      const emojiA = result.agent1_move ? (MOVE_EMOJI[result.agent1_move] ?? '❓') : '❓'
      const emojiB = result.agent2_move ? (MOVE_EMOJI[result.agent2_move] ?? '❓') : '❓'
      const labelA = result.agent1_move ? (MOVE_LABEL[result.agent1_move] ?? '?') : '?'
      const labelB = result.agent2_move ? (MOVE_LABEL[result.agent2_move] ?? '?') : '?'

      moveA.textContent = `${emojiA} ${labelA}`
      moveB.textContent = `${emojiB} ${labelB}`
      moveA.className = 'replay-move mdet-move revealed'
      moveB.className = 'replay-move mdet-move revealed'
    })

    // Winner / draw
    after(2700, () => {
      const winnerName = result.winner_name
      if (!winnerName) {
        resultEl.textContent = '🤝 Draw!'
        resultEl.className = 'replay-result mdet-result draw-text'
        sideA.classList.add('draw')
        sideB.classList.add('draw')
      } else if (winnerName === match.agent1_name) {
        resultEl.innerHTML = `🏆 ${esc(match.agent1_name)} wins!`
        resultEl.className = 'replay-result mdet-result win-text'
        sideA.classList.add('winner')
        sideB.classList.add('loser')
      } else {
        resultEl.innerHTML = `🏆 ${esc(match.agent2_name)} wins!`
        resultEl.className = 'replay-result mdet-result win-text'
        sideB.classList.add('winner')
        sideA.classList.add('loser')
      }
    })
  }

  // ── countdown + transition ────────────────────────────────────────────────
  function startCountdown(match: StrategyMatchRow, totalMs: number) {
    if (tickInterval) clearInterval(tickInterval)

    function tick() {
      const ms = new Date(match.strategy_deadline).getTime() - Date.now()
      if (ms <= 0) {
        clearInterval(tickInterval!)
        tickInterval = null
        countdownEl.textContent = '0s'
        pbar.style.width = '0%'
        countdownEl.classList.add('urgent')
        pbar.classList.add('urgent')
        statusEl.textContent = '⏳ Awaiting reveal…'

        // Start polling for the match result every 1.5s
        resultPoll = setInterval(async () => {
          const result = await pollForResult(match.id)
          if (result) {
            clearInterval(resultPoll!)
            resultPoll = null
            animateResult(match, result)
          }
        }, 1500)
        return
      }

      const secs = Math.ceil(ms / 1000)
      countdownEl.textContent = `${secs}s`
      const pct = Math.max(0, (ms / totalMs) * 100)
      pbar.style.width = `${pct.toFixed(1)}%`
      const urgent = secs <= 15
      countdownEl.classList.toggle('urgent', urgent)
      pbar.classList.toggle('urgent', urgent)
    }

    tick()
    tickInterval = setInterval(tick, 1000)
  }

  // ── show ──────────────────────────────────────────────────────────────────
  async function show(match: StrategyMatchRow) {
    clearAll()

    const totalMs = new Date(match.strategy_deadline).getTime() - new Date(match.created_at).getTime()

    // Reset to strategy-phase state
    statusEl.textContent = '📚 Strategy Phase'
    countdownEl.classList.remove('urgent')
    pbar.classList.remove('urgent')
    nameA.textContent = match.agent1_name
    nameB.textContent = match.agent2_name
    wagerEl.textContent = `⚡ ${match.wager_amount.toLocaleString()} chips at stake`
    moveA.textContent = ''
    moveB.textContent = ''
    moveA.className = 'replay-move mdet-move'
    moveB.className = 'replay-move mdet-move'
    sideA.className = 'mdet-side'
    sideB.className = 'mdet-side'
    animEl.textContent = ''
    resultEl.textContent = ''
    resultEl.className = 'replay-result mdet-result'
    vsEl.style.display = 'block'
    historyWrap.classList.remove('mdet-hidden')
    histA.innerHTML = '<p class="sprep-no-history">Loading…</p>'
    histB.innerHTML = '<p class="sprep-no-history">Loading…</p>'

    overlay.classList.add('active')
    startCountdown(match, totalMs)

    const [hist1, hist2] = await Promise.all([
      fetchHistory(match.agent1_name),
      fetchHistory(match.agent2_name),
    ])

    histA.innerHTML = renderHistory(hist1)
    histB.innerHTML = renderHistory(hist2)
  }

  return show
}
