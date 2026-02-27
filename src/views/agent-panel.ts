// ---------------------------------------------------------------------------
// Agent panel — API key login + strategy editor
// ---------------------------------------------------------------------------

const SESSION_KEY = 'rpc_agent_key'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentProfile {
  id: string
  name: string
  balance: number
  wins: number
  losses: number
  draws: number
  strategy: Strategy
}

type Move = 'rock' | 'paper' | 'scissors'

type Strategy =
  | { type: 'random' }
  | { type: 'always'; move: Move }
  | { type: 'cycle'; sequence: Move[] }
  | { type: 'weighted'; rock: number; paper: number; scissors: number }
  | { type: 'counter_last_loss' }

// ---------------------------------------------------------------------------
// Edge function client
// ---------------------------------------------------------------------------

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
const ANON  = import.meta.env.VITE_SUPABASE_ANON_KEY

async function edgeCall<T>(
  path: string,
  { method = 'GET', body, agentKey }: { method?: string; body?: unknown; agentKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ANON}`,
  }
  if (agentKey) headers['X-Agent-Key'] = agentKey

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error((data?.error as string | undefined) ?? `HTTP ${res.status}`)
  return data as T
}

async function fetchProfile(apiKey: string): Promise<AgentProfile> {
  const data = await edgeCall<{ agent: AgentProfile }>('/get-profile', { agentKey: apiKey })
  return data.agent
}

async function saveStrategy(apiKey: string, strategy: Strategy): Promise<void> {
  await edgeCall('/set-strategy', { method: 'POST', body: { strategy }, agentKey: apiKey })
}

// ---------------------------------------------------------------------------
// Strategy helpers
// ---------------------------------------------------------------------------

const MOVE_OPTIONS: Move[] = ['rock', 'paper', 'scissors']
const MOVE_LABEL: Record<Move, string> = { rock: 'Rock', paper: 'Paper', scissors: 'Claw' }
const MOVE_EMOJI: Record<Move, string> = { rock: '🪨', paper: '📄', scissors: '🦞' }

function strategyLabel(s: Strategy): string {
  switch (s.type) {
    case 'random':         return 'Random'
    case 'always':         return `Always ${MOVE_LABEL[s.move]}`
    case 'cycle':          return `Cycle (${s.sequence.map(m => MOVE_EMOJI[m]).join('→')})`
    case 'weighted':       return `Weighted`
    case 'counter_last_loss': return 'Counter Last Loss'
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderLoggedOut(): string {
  return `
    <div class="ap-login">
      <span class="ap-login-label">🦞 Connect your agent</span>
      <input class="ap-key-input" id="ap-key" type="password"
             placeholder="Paste your API key…" autocomplete="off" spellcheck="false" />
      <button class="ap-btn ap-btn-primary" id="ap-connect">Connect</button>
      <span class="ap-login-error" id="ap-error"></span>
    </div>
  `
}

function renderLoggedIn(profile: AgentProfile): string {
  const s = profile.strategy
  return `
    <div class="ap-profile">
      <div class="ap-agent-info">
        <span class="ap-agent-name">🦞 ${esc(profile.name)}</span>
        <span class="ap-stat">💰 ${profile.balance.toLocaleString()}</span>
        <span class="ap-stat">W${profile.wins} L${profile.losses} D${profile.draws}</span>
        <span class="ap-current-strategy">Strategy: <strong>${strategyLabel(s)}</strong></span>
        <button class="ap-btn ap-btn-ghost ap-disconnect" id="ap-disconnect">Disconnect</button>
      </div>

      <div class="ap-strategy-editor" id="ap-strategy-editor">
        <div class="ap-type-tabs" id="ap-type-tabs">
          ${(['random', 'always', 'cycle', 'weighted', 'counter_last_loss'] as const).map(t => `
            <button class="ap-type-tab${s.type === t ? ' active' : ''}" data-type="${t}">
              ${{ random: 'Random', always: 'Always', cycle: 'Cycle', weighted: 'Weighted', counter_last_loss: 'Counter' }[t]}
            </button>`).join('')}
        </div>

        <div class="ap-type-config" id="ap-type-config">
          ${renderStrategyConfig(s)}
        </div>

        <div class="ap-save-row">
          <button class="ap-btn ap-btn-primary" id="ap-save">Save Strategy</button>
          <span class="ap-save-status" id="ap-save-status"></span>
        </div>
      </div>
    </div>
  `
}

function renderStrategyConfig(s: Strategy): string {
  switch (s.type) {
    case 'random':
      return `<p class="ap-desc">Picks rock, paper, or claw at random each match.</p>`

    case 'always':
      return `
        <div class="ap-move-picker">
          ${MOVE_OPTIONS.map(m => `
            <label class="ap-move-opt${s.move === m ? ' selected' : ''}">
              <input type="radio" name="always-move" value="${m}" ${s.move === m ? 'checked' : ''}>
              <span>${MOVE_EMOJI[m]} ${MOVE_LABEL[m]}</span>
            </label>`).join('')}
        </div>`

    case 'cycle': {
      const seq = [...s.sequence]
      while (seq.length < 3) seq.push('rock')
      return `
        <p class="ap-desc">Rotates through this sequence each match.</p>
        <div class="ap-cycle-slots">
          ${seq.map((m, i) => `
            <select class="ap-cycle-select" data-index="${i}">
              ${MOVE_OPTIONS.map(o => `<option value="${o}" ${m === o ? 'selected' : ''}>${MOVE_EMOJI[o]} ${MOVE_LABEL[o]}</option>`).join('')}
            </select>`).join('<span class="ap-cycle-arrow">→</span>')}
        </div>`
    }

    case 'weighted': {
      const r = Math.round(s.rock * 100)
      const p = Math.round(s.paper * 100)
      const sc = Math.round(s.scissors * 100)
      return `
        <p class="ap-desc">Set probability weights (must total 100%).</p>
        <div class="ap-weights">
          ${(['rock', 'paper', 'scissors'] as Move[]).map((m, i) => {
            const val = [r, p, sc][i]
            return `
            <label class="ap-weight-row">
              <span class="ap-weight-label">${MOVE_EMOJI[m]} ${MOVE_LABEL[m]}</span>
              <input class="ap-weight-input" type="number" data-move="${m}"
                     min="0" max="100" step="1" value="${val}">
              <span class="ap-weight-pct">%</span>
            </label>`
          }).join('')}
          <span class="ap-weight-total" id="ap-weight-total">Total: ${r + p + sc}%</span>
        </div>`
    }

    case 'counter_last_loss':
      return `<p class="ap-desc">Plays the counter to the move that beat you last time. Falls back to random if no prior loss.</p>`
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ---------------------------------------------------------------------------
// Read current strategy from DOM
// ---------------------------------------------------------------------------

function readStrategyFromDOM(container: HTMLElement, type: string): Strategy | null {
  switch (type) {
    case 'random': return { type: 'random' }
    case 'counter_last_loss': return { type: 'counter_last_loss' }

    case 'always': {
      const checked = container.querySelector<HTMLInputElement>('input[name="always-move"]:checked')
      if (!checked) return null
      return { type: 'always', move: checked.value as Move }
    }

    case 'cycle': {
      const selects = [...container.querySelectorAll<HTMLSelectElement>('.ap-cycle-select')]
      const sequence = selects.map(s => s.value as Move)
      if (sequence.length !== 3) return null
      return { type: 'cycle', sequence }
    }

    case 'weighted': {
      const inputs = [...container.querySelectorAll<HTMLInputElement>('.ap-weight-input')]
      const vals: Record<string, number> = {}
      for (const input of inputs) vals[input.dataset.move!] = Number(input.value) / 100
      const total = Math.round((vals.rock + vals.paper + vals.scissors) * 100)
      if (total !== 100) return null
      return { type: 'weighted', rock: vals.rock, paper: vals.paper, scissors: vals.scissors }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountAgentPanel(container: HTMLElement): void {
  let apiKey = sessionStorage.getItem(SESSION_KEY) ?? ''
  let currentType = 'random'

  function renderEmpty() {
    container.innerHTML = renderLoggedOut()
    bindLogin()
  }

  function renderProfile(profile: AgentProfile) {
    currentType = profile.strategy.type
    container.innerHTML = renderLoggedIn(profile)
    bindProfile(profile)
  }

  // ── login ────────────────────────────────────────────────────────────────
  function bindLogin() {
    const keyInput = container.querySelector<HTMLInputElement>('#ap-key')!
    const connectBtn = container.querySelector<HTMLButtonElement>('#ap-connect')!
    const errorEl = container.querySelector<HTMLElement>('#ap-error')!

    async function connect() {
      const key = keyInput.value.trim()
      if (!key) return
      connectBtn.disabled = true
      connectBtn.textContent = 'Connecting…'
      errorEl.textContent = ''
      try {
        const profile = await fetchProfile(key)
        apiKey = key
        sessionStorage.setItem(SESSION_KEY, key)
        renderProfile(profile)
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Connection failed'
        connectBtn.disabled = false
        connectBtn.textContent = 'Connect'
      }
    }

    connectBtn.addEventListener('click', connect)
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect() })

    // Auto-connect if we have a stored key
    if (apiKey) {
      keyInput.value = apiKey
      connect()
    }
  }

  // ── profile + strategy editor ────────────────────────────────────────────
  function bindProfile(profile: AgentProfile) {
    container.querySelector('#ap-disconnect')!.addEventListener('click', () => {
      apiKey = ''
      sessionStorage.removeItem(SESSION_KEY)
      renderEmpty()
    })

    const tabs = container.querySelector<HTMLElement>('#ap-type-tabs')!
    const configEl = container.querySelector<HTMLElement>('#ap-type-config')!
    const saveBtn = container.querySelector<HTMLButtonElement>('#ap-save')!
    const statusEl = container.querySelector<HTMLElement>('#ap-save-status')!

    // Tab switching
    tabs.addEventListener('click', (e) => {
      const tab = (e.target as Element).closest<HTMLButtonElement>('.ap-type-tab')
      if (!tab) return
      currentType = tab.dataset.type!
      tabs.querySelectorAll('.ap-type-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')

      // Re-render config area with a default for the selected type
      const defaults: Record<string, Strategy> = {
        random:           { type: 'random' },
        always:           { type: 'always', move: 'rock' },
        cycle:            { type: 'cycle', sequence: ['rock', 'paper', 'scissors'] },
        weighted:         { type: 'weighted', rock: 0.34, paper: 0.33, scissors: 0.33 },
        counter_last_loss: { type: 'counter_last_loss' },
      }
      // If switching to same type as current profile, restore actual values
      const existing = currentType === profile.strategy.type ? profile.strategy : defaults[currentType]
      configEl.innerHTML = renderStrategyConfig(existing as Strategy)
      bindWeightInputs()
      statusEl.textContent = ''
    })

    // Weight inputs: live total update
    function bindWeightInputs() {
      const inputs = [...container.querySelectorAll<HTMLInputElement>('.ap-weight-input')]
      const totalEl = container.querySelector<HTMLElement>('#ap-weight-total')
      if (!totalEl || inputs.length === 0) return
      inputs.forEach(input => input.addEventListener('input', () => {
        const sum = inputs.reduce((acc, i) => acc + Number(i.value), 0)
        totalEl.textContent = `Total: ${sum}%`
        totalEl.classList.toggle('ap-weight-error', sum !== 100)
      }))
    }
    bindWeightInputs()

    // Save
    saveBtn.addEventListener('click', async () => {
      const strategy = readStrategyFromDOM(container, currentType)
      if (!strategy) {
        statusEl.textContent = '⚠ Check your inputs'
        statusEl.className = 'ap-save-status error'
        return
      }
      saveBtn.disabled = true
      statusEl.textContent = 'Saving…'
      statusEl.className = 'ap-save-status'
      try {
        await saveStrategy(apiKey, strategy)
        profile.strategy = strategy
        statusEl.textContent = '✓ Saved'
        statusEl.className = 'ap-save-status success'
        // Update the "current strategy" label
        const label = container.querySelector<HTMLElement>('.ap-current-strategy strong')
        if (label) label.textContent = strategyLabel(strategy)
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : 'Save failed'
        statusEl.className = 'ap-save-status error'
      } finally {
        saveBtn.disabled = false
      }
    })
  }

  // ── init ─────────────────────────────────────────────────────────────────
  renderEmpty()
}
