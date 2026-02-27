/**
 * RockPaperClaw arena simulator.
 *
 * Calls Edge Functions directly — no MCP overhead.
 * Agent API keys are stored locally in scripts/agents.json (gitignored).
 *
 * Commands:
 *   npm run simulate register  [--count 50] [--prefix SimBot]
 *   npm run simulate run       [--rounds 20] [--wager 10] [--concurrency 10]
 *   npm run simulate status
 *   npm run simulate reset
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENTS_FILE = resolve(__dirname, 'agents.json')

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = resolve(__dirname, '../.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = val
  }
}

loadEnv()

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')
if (!SUPABASE_URL) throw new Error('VITE_SUPABASE_URL not set in .env')
const BASE = `${SUPABASE_URL}/functions/v1`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Move = 'rock' | 'paper' | 'scissors'
const MOVES: Move[] = ['rock', 'paper', 'scissors']

interface SimAgent {
  name: string
  apiKey: string
}

interface Profile {
  name: string
  balance: number
  wins: number
  losses: number
  draws: number
}

interface Challenge {
  id: string
  challenger_name: string
  wager_amount: number
}

// ---------------------------------------------------------------------------
// HTTP client (per agent)
// ---------------------------------------------------------------------------

function makeClient(apiKey?: string) {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['X-Agent-Key'] = apiKey

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    const data = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error((data?.error as string | undefined) ?? `HTTP ${res.status}`)
    return data
  }

  return {
    register: (name: string) =>
      call('POST', '/register', { name }) as Promise<{ api_key: string }>,

    getProfile: () =>
      call('GET', '/get-profile') as Promise<{ agent: Profile }>,

    listChallenges: () =>
      call('GET', '/list-challenges') as Promise<{ challenges: Challenge[] }>,

    postChallenge: (wager_amount: number) =>
      call('POST', '/post-challenge', { wager_amount }) as Promise<{ challenge: { id: string } }>,

    acceptChallenge: (challengeId: string, strategy_seconds?: number) =>
      call('POST', `/accept-challenge/${challengeId}`, { strategy_seconds }) as Promise<{
        match_id: string
        phase: 'strategy' | 'finished'
        strategy_deadline: string | null
      }>,

    commitMove: (match_id: string, move_hash: string) =>
      call('POST', '/commit-move', { match_id, move_hash }),

    revealMove: (match_id: string, move: string, salt: string) =>
      call('POST', '/reveal-move', { match_id, move, salt }),

    cancelChallenge: (challengeId: string) =>
      call('POST', `/cancel-challenge/${challengeId}`, {}),
  }
}

// ---------------------------------------------------------------------------
// Commit-reveal helpers
// ---------------------------------------------------------------------------

function createCommit(move: Move): { move: Move; salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(move + salt).digest('hex')
  return { move, salt, hash }
}

function randomMove(): Move {
  return MOVES[Math.floor(Math.random() * MOVES.length)]
}

async function waitUntil(isoDate: string | null | undefined): Promise<void> {
  if (!isoDate) return
  const ms = new Date(isoDate).getTime() - Date.now()
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms + 200))
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

function makeSemaphore(limit: number) {
  let running = 0
  const queue: Array<() => void> = []

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (running < limit) {
        running++
        resolve()
      } else {
        queue.push(resolve)
      }
    })
    try {
      return await fn()
    } finally {
      running--
      queue.shift()?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Agents file I/O
// ---------------------------------------------------------------------------

function loadAgents(): SimAgent[] {
  if (!existsSync(AGENTS_FILE)) return []
  return JSON.parse(readFileSync(AGENTS_FILE, 'utf8')) as SimAgent[]
}

function saveAgents(agents: SimAgent[]): void {
  writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2))
}

// ---------------------------------------------------------------------------
// Run one match between two agents
// ---------------------------------------------------------------------------

type MatchOutcome = 'challenger_wins' | 'accepter_wins' | 'draw' | 'error'

interface MatchResult {
  challenger: string
  accepter: string
  challengerMove: Move
  accepterMove: Move
  outcome: MatchOutcome
  error?: string
}

function resolveOutcome(c: Move, a: Move): MatchOutcome {
  if (c === a) return 'draw'
  if (
    (c === 'rock' && a === 'scissors') ||
    (c === 'scissors' && a === 'paper') ||
    (c === 'paper' && a === 'rock')
  ) return 'challenger_wins'
  return 'accepter_wins'
}

async function runMatch(
  challenger: SimAgent,
  accepter: SimAgent,
  wager: number,
  strategySeconds: number,
): Promise<MatchResult> {
  const cClient = makeClient(challenger.apiKey)
  const aClient = makeClient(accepter.apiKey)

  const cCommit = createCommit(randomMove())
  const aCommit = createCommit(randomMove())

  try {
    // Post challenge, then accept (passing strategy window duration)
    const { challenge } = await cClient.postChallenge(wager)
    const { match_id: matchId, strategy_deadline } =
      await aClient.acceptChallenge(challenge.id, strategySeconds)

    // Wait for strategy window to close before committing
    await waitUntil(strategy_deadline)

    // Both commit concurrently
    await Promise.all([
      cClient.commitMove(matchId, cCommit.hash),
      aClient.commitMove(matchId, aCommit.hash),
    ])

    // Both reveal concurrently — second reveal resolves the match
    await Promise.all([
      cClient.revealMove(matchId, cCommit.move, cCommit.salt),
      aClient.revealMove(matchId, aCommit.move, aCommit.salt),
    ])

    return {
      challenger: challenger.name,
      accepter: accepter.name,
      challengerMove: cCommit.move,
      accepterMove: aCommit.move,
      outcome: resolveOutcome(cCommit.move, aCommit.move),
    }
  } catch (err) {
    return {
      challenger: challenger.name,
      accepter: accepter.name,
      challengerMove: cCommit.move,
      accepterMove: aCommit.move,
      outcome: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function getArg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function getNumArg(flag: string, fallback: number): number {
  return Number(getArg(flag, String(fallback)))
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

const MOVE_GLYPH: Record<Move, string> = { rock: '🪨', paper: '📄', scissors: '🦞' }

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const [, , command = 'help'] = process.argv

// ── register ────────────────────────────────────────────────────────────────
if (command === 'register') {
  const count = getNumArg('--count', 10)
  const prefix = getArg('--prefix', 'SimBot')
  const existing = loadAgents()
  const existingNames = new Set(existing.map((a) => a.name))
  const anonClient = makeClient()

  console.log(`\nRegistering up to ${count} agents with prefix "${prefix}"...\n`)

  const fresh: SimAgent[] = []
  for (let i = 1; i <= count; i++) {
    const name = `${prefix}-${String(i).padStart(3, '0')}`
    if (existingNames.has(name)) {
      console.log(`  skip  ${name}  (already registered)`)
      continue
    }
    try {
      const res = await anonClient.register(name)
      fresh.push({ name, apiKey: res.api_key })
      console.log(`  ✓  ${name}`)
    } catch (err) {
      console.log(`  ✗  ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  saveAgents([...existing, ...fresh])
  console.log(`\nSaved ${existing.length + fresh.length} total agents → scripts/agents.json`)
}

// ── status ───────────────────────────────────────────────────────────────────
else if (command === 'status') {
  const agents = loadAgents()
  if (agents.length === 0) {
    console.log('No agents found. Run: npm run simulate register')
    process.exit(1)
  }

  const results = await Promise.allSettled(
    agents.map(async (a) => {
      const { agent } = await makeClient(a.apiKey).getProfile()
      return agent
    }),
  )

  const header = `${'Agent'.padEnd(20)} ${'Chips'.padStart(7)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'D'.padStart(4)}`
  console.log(`\n${header}`)
  console.log('─'.repeat(header.length))

  for (const r of results) {
    if (r.status === 'rejected') {
      console.log(`  error: ${r.reason}`)
      continue
    }
    const p = r.value
    console.log(
      p.name.padEnd(20),
      String(p.balance).padStart(7),
      String(p.wins).padStart(4),
      String(p.losses).padStart(4),
      String(p.draws).padStart(4),
    )
  }
  console.log()
}

// ── reset ────────────────────────────────────────────────────────────────────
else if (command === 'reset') {
  const agents = loadAgents()
  if (agents.length === 0) { console.log('No agents found.'); process.exit(1) }

  const anyClient = makeClient(agents[0].apiKey)
  const { challenges } = await anyClient.listChallenges()

  const ourNames = new Set(agents.map((a) => a.name))
  const ours = challenges.filter((c) => ourNames.has(c.challenger_name))

  if (ours.length === 0) { console.log('No open challenges from sim agents.'); process.exit(0) }

  const nameToAgent = new Map(agents.map((a) => [a.name, a]))
  console.log(`Cancelling ${ours.length} open challenge(s)...\n`)

  await Promise.allSettled(
    ours.map(async (ch) => {
      const agent = nameToAgent.get(ch.challenger_name)
      if (!agent) return
      try {
        await makeClient(agent.apiKey).cancelChallenge(ch.id)
        console.log(`  ✓  cancelled ${ch.id.slice(0, 8)}…  (${ch.challenger_name})`)
      } catch (err) {
        console.log(`  ✗  ${ch.id.slice(0, 8)}…: ${err instanceof Error ? err.message : err}`)
      }
    }),
  )
  console.log('\nDone.')
}

// ── run ──────────────────────────────────────────────────────────────────────
else if (command === 'run') {
  const rounds = getNumArg('--rounds', 5)
  const wager = getNumArg('--wager', 10)
  const concurrency = getNumArg('--concurrency', 10)
  const strategySeconds = getNumArg('--strategy-seconds', 0)

  const agents = loadAgents()
  if (agents.length < 2) {
    console.log('Need at least 2 agents. Run: npm run simulate register')
    process.exit(1)
  }

  const sem = makeSemaphore(concurrency)
  let totalDecided = 0, totalDraws = 0, totalErrors = 0

  console.log(
    `\nSimulating ${rounds} round(s) | ${agents.length} agents | ` +
    `${wager}-chip wager | concurrency ${concurrency}\n`,
  )

  for (let round = 1; round <= rounds; round++) {
    const shuffled = shuffle(agents)
    const pairs: [SimAgent, SimAgent][] = []
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
      pairs.push([shuffled[i], shuffled[i + 1]])
    }

    console.log(`── Round ${round}/${rounds}  (${pairs.length} matches) ──`)

    const results = await Promise.allSettled(
      pairs.map(([challenger, accepter]) =>
        sem(() => runMatch(challenger, accepter, wager, strategySeconds)),
      ),
    )

    for (const r of results) {
      if (r.status === 'rejected') {
        totalErrors++
        console.log(`  ✗  ${r.reason}`)
        continue
      }
      const m = r.value
      if (m.outcome === 'error') {
        totalErrors++
        console.log(`  ✗  ${m.challenger} vs ${m.accepter}: ${m.error}`)
      } else {
        const cg = MOVE_GLYPH[m.challengerMove]
        const ag = MOVE_GLYPH[m.accepterMove]
        const winner =
          m.outcome === 'draw'
            ? '🤝 draw'
            : `🏆 ${m.outcome === 'challenger_wins' ? m.challenger : m.accepter}`
        console.log(`  ${m.challenger}(${cg}) vs ${m.accepter}(${ag}) → ${winner}`)
        if (m.outcome === 'draw') totalDraws++; else totalDecided++
      }
    }
    console.log()
  }

  const total = totalDecided + totalDraws + totalErrors
  console.log(
    `Finished. ${total} matches — ${totalDecided} decided, ${totalDraws} draws, ${totalErrors} errors`,
  )
}

// ── lobby ─────────────────────────────────────────────────────────────────────
else if (command === 'lobby') {
  const matchCount      = getNumArg('--matches',          50)
  const lobbySize       = getNumArg('--lobby-size',        6)
  const challengeSecs   = getNumArg('--challenge-seconds', 60)
  const strategySecs    = getNumArg('--strategy-seconds',  60)
  const wager           = getNumArg('--wager',             10)

  const agents = loadAgents()
  if (agents.length < 2) {
    console.log('Need at least 2 agents. Run: npm run simulate register')
    process.exit(1)
  }

  // Generate matchCount pairs, recycling through shuffled agents each round.
  const pairs: [SimAgent, SimAgent][] = []
  while (pairs.length < matchCount) {
    const s = shuffle(agents)
    for (let i = 0; i + 1 < s.length && pairs.length < matchCount; i += 2) {
      pairs.push([s[i], s[i + 1]])
    }
  }

  // Time between launching successive matches so that ~lobbySize are always
  // in flight (either in challenge-open or strategy phase).
  const staggerMs = Math.round((challengeSecs + strategySecs) * 1000 / lobbySize)
  const estMins   = Math.round((pairs.length * staggerMs + (challengeSecs + strategySecs) * 1000) / 60000)

  const start = Date.now()
  function elapsed() { return `t=${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s` }

  console.log(`\n Lobby simulation`)
  console.log(`  ${matchCount} matches | ${lobbySize} concurrent | ${wager}-chip wager`)
  console.log(`  Challenge window: ${challengeSecs}s  |  Strategy window: ${strategySecs}s`)
  console.log(`  Stagger: ${staggerMs / 1000}s between starts  |  Est. ~${estMins} min total\n`)

  let done = 0, errors = 0

  async function runLobbyMatch(challenger: SimAgent, accepter: SimAgent): Promise<void> {
    const cClient = makeClient(challenger.apiKey)
    const aClient = makeClient(accepter.apiKey)
    const cCommit = createCommit(randomMove())
    const aCommit = createCommit(randomMove())

    try {
      // Post challenge — visible in lobby as "Waiting for opponent"
      const { challenge } = await cClient.postChallenge(wager)
      console.log(`  📢 [${elapsed()}] ${challenger.name} posted challenge`)

      // Wait the full challenge window before the accepter joins
      await new Promise<void>((r) => setTimeout(r, challengeSecs * 1000))

      // Accept — visible in lobby as "Strategy phase"
      const { match_id: matchId, strategy_deadline } =
        await aClient.acceptChallenge(challenge.id, strategySecs)
      console.log(`  ⚔️  [${elapsed()}] ${accepter.name} accepted — ${strategySecs}s strategy window`)

      // Wait for strategy window to close
      await waitUntil(strategy_deadline)

      // Both commit concurrently, then both reveal
      await Promise.all([
        cClient.commitMove(matchId, cCommit.hash),
        aClient.commitMove(matchId, aCommit.hash),
      ])
      await Promise.all([
        cClient.revealMove(matchId, cCommit.move, cCommit.salt),
        aClient.revealMove(matchId, aCommit.move, aCommit.salt),
      ])

      const outcome = resolveOutcome(cCommit.move, aCommit.move)
      const winner  = outcome === 'draw'
        ? '🤝 draw'
        : `🏆 ${outcome === 'challenger_wins' ? challenger.name : accepter.name}`
      console.log(
        `  ✅ [${elapsed()}] ${challenger.name}(${MOVE_GLYPH[cCommit.move]}) ` +
        `vs ${accepter.name}(${MOVE_GLYPH[aCommit.move]}) → ${winner}  ` +
        `(${++done}/${matchCount})`,
      )
    } catch (err) {
      errors++
      console.log(
        `  ✗  [${elapsed()}] ${challenger.name} vs ${accepter.name}: ` +
        `${err instanceof Error ? err.message : err}`,
      )
    }
  }

  // Stagger-launch every match; await all of them finishing.
  await Promise.all(
    pairs.map(([c, a], i) =>
      new Promise<void>((resolve) =>
        setTimeout(() => runLobbyMatch(c, a).then(resolve), i * staggerMs),
      ),
    ),
  )

  const total = done + errors
  console.log(`\nFinished. ${total} matches — ${done} completed, ${errors} errors`)
}

// ── help ─────────────────────────────────────────────────────────────────────
else {
  console.log(`
RockPaperClaw Simulator

Commands:
  register  [--count 50] [--prefix SimBot]     Register N agents (one-time)
  run       [--rounds 20] [--wager 10]          Run rapid back-to-back rounds
            [--concurrency 10]
            [--strategy-seconds 0]
  lobby     [--matches 50] [--lobby-size 6]     Staggered lobby simulation — posts
            [--challenge-seconds 60]            challenges one by one and keeps
            [--strategy-seconds 60]             ~lobby-size matches in flight
            [--wager 10]
  status                                         Show all sim agent profiles
  reset                                          Cancel open challenges from sim agents

Examples:
  npm run simulate lobby -- --matches 50 --challenge-seconds 60 --strategy-seconds 60
  npm run simulate run -- --rounds 20 --wager 10
  npm run simulate status
  npm run simulate reset
`)
}
