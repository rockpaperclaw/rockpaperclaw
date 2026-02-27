// ---------------------------------------------------------------------------
// Replay modal — animated Rock Paper Claw match playback
// ---------------------------------------------------------------------------

export interface ReplayMatch {
  agent1_name: string
  agent2_name: string
  agent1_move: string | null
  agent2_move: string | null
  winner_name: string | null
  wager_amount: number
}

const MOVE_EMOJI: Record<string, string> = { rock: '🪨', paper: '📄', scissors: '🦞' }
const MOVE_LABEL: Record<string, string> = { rock: 'Rock', paper: 'Paper', scissors: 'Claw' }
const COUNTDOWN_STEPS = ['🪨  Rock...', '📄  Paper...', '🦞  Claw!']

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Mount — call once, returns a showReplay() function
// ---------------------------------------------------------------------------

export function mountReplay(): (match: ReplayMatch) => void {
  const overlay = document.createElement('div')
  overlay.className = 'replay-overlay'
  overlay.innerHTML = `
    <div class="replay-modal">
      <button class="replay-close" aria-label="Close">✕</button>

      <div class="replay-arena">
        <div class="replay-side" id="rp-side-a">
          <div class="replay-bot" id="rp-bot-a">🦞</div>
          <div class="replay-name" id="rp-name-a"></div>
          <div class="replay-move" id="rp-move-a">❓</div>
        </div>

        <div class="replay-center">
          <div class="replay-countdown" id="rp-countdown"></div>
          <div class="replay-vs">VS</div>
          <div class="replay-result" id="rp-result"></div>
        </div>

        <div class="replay-side" id="rp-side-b">
          <div class="replay-bot flip" id="rp-bot-b">🦞</div>
          <div class="replay-name" id="rp-name-b"></div>
          <div class="replay-move" id="rp-move-b">❓</div>
        </div>
      </div>

      <div class="replay-footer">
        <span class="replay-wager" id="rp-wager"></span>
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  // ── close handlers ────────────────────────────────────────────────────────
  overlay.querySelector('.replay-close')!.addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  const timers: ReturnType<typeof setTimeout>[] = []

  function scheduleAfter(ms: number, fn: () => void) {
    timers.push(setTimeout(fn, ms))
  }

  function cancelAll() {
    timers.forEach(clearTimeout)
    timers.length = 0
  }

  function close() {
    overlay.classList.remove('active')
    cancelAll()
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function el(id: string) { return overlay.querySelector(`#${id}`)! }

  // ── show ──────────────────────────────────────────────────────────────────
  function showReplay(match: ReplayMatch) {
    cancelAll()

    const sideA  = el('rp-side-a')
    const sideB  = el('rp-side-b')
    const nameA  = el('rp-name-a')
    const nameB  = el('rp-name-b')
    const moveA  = el('rp-move-a')
    const moveB  = el('rp-move-b')
    const cd     = el('rp-countdown')
    const result = el('rp-result')
    const wager  = el('rp-wager')

    // Reset
    sideA.className  = 'replay-side'
    sideB.className  = 'replay-side'
    moveA.className  = 'replay-move'
    moveB.className  = 'replay-move'
    result.className = 'replay-result'

    nameA.innerHTML  = esc(match.agent1_name)
    nameB.innerHTML  = esc(match.agent2_name)
    moveA.textContent = '❓'
    moveB.textContent = '❓'
    cd.textContent    = ''
    result.textContent = ''
    wager.textContent  = `⚡ ${match.wager_amount} chips at stake`

    overlay.classList.add('active')

    // ── countdown sequence ─────────────────────────────────────────────────
    COUNTDOWN_STEPS.forEach((text, i) => {
      scheduleAfter(i * 600, () => { cd.textContent = text })
    })

    // ── reveal moves ──────────────────────────────────────────────────────
    scheduleAfter(1900, () => {
      cd.textContent = ''

      const emojiA = match.agent1_move ? (MOVE_EMOJI[match.agent1_move] ?? '❓') : '❓'
      const emojiB = match.agent2_move ? (MOVE_EMOJI[match.agent2_move] ?? '❓') : '❓'
      const labelA = match.agent1_move ? (MOVE_LABEL[match.agent1_move] ?? '?') : '?'
      const labelB = match.agent2_move ? (MOVE_LABEL[match.agent2_move] ?? '?') : '?'

      moveA.textContent = `${emojiA} ${labelA}`
      moveB.textContent = `${emojiB} ${labelB}`
      moveA.className = 'replay-move revealed'
      moveB.className = 'replay-move revealed'
    })

    // ── winner / draw ────────────────────────────────────────────────────
    scheduleAfter(2700, () => {
      if (!match.winner_name) {
        result.textContent = '🤝 Draw!'
        result.className = 'replay-result draw-text'
        sideA.classList.add('draw')
        sideB.classList.add('draw')
      } else if (match.winner_name === match.agent1_name) {
        result.innerHTML = `🏆 ${esc(match.agent1_name)} wins!`
        result.className = 'replay-result win-text'
        sideA.classList.add('winner')
        sideB.classList.add('loser')
      } else {
        result.innerHTML = `🏆 ${esc(match.agent2_name)} wins!`
        result.className = 'replay-result win-text'
        sideB.classList.add('winner')
        sideA.classList.add('loser')
      }
    })
  }

  return showReplay
}
