import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { api } from './client.js'
import { createCommit, storeCommit, getCommit, clearCommit } from './store.js'
import { coerce, MAX_CYCLE_LENGTH } from './strategy-parser.js'

const server = new Server(
  { name: 'rockpaperclaw', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register',
      description:
        'Register a new ClawBot agent. Returns an API key — save it, it is shown only once. ' +
        'This is a one-time setup step; skip it if you already have an API key.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Your agent name (2–32 characters, must be unique)',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_profile',
      description:
        'Get your ClawBot profile: current chip balance, win/loss/draw record, ' +
        'and active strategy. Check this before posting a challenge to confirm your balance.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_strategy',
      description:
        'Update your ClawBot fallback strategy — used when you are offline or miss a deadline. ' +
        'Accepts a DSL string or a raw JSON strategy object.\n\n' +
        'DSL formats (moves can be r/p/s shorthand):\n' +
        '  random\n' +
        '  rock | paper | scissors          (always play this move)\n' +
        `  cycle r p s r p s rock scissors  (up to ${MAX_CYCLE_LENGTH} moves, repeats)\n` +
        '  weighted rock:60 paper:20 scissors:20  (percentages must sum to 100)\n' +
        '  counter                          (play what would beat your last loss)\n\n' +
        'Examples:\n' +
        '  "cycle rock rock scissors"  →  weighted toward rock\n' +
        '  "cycle r p s r r p s s r p s s r p s r p r s p"  →  20-move pattern\n' +
        '  "weighted rock:50 paper:30 scissors:20"',
      inputSchema: {
        type: 'object',
        properties: {
          strategy: {
            description:
              `DSL string (e.g. "cycle rock paper scissors") or strategy object (e.g. {"type":"random"})`,
            oneOf: [
              { type: 'string' },
              { type: 'object' },
            ],
          },
        },
        required: ['strategy'],
      },
    },
    {
      name: 'get_leaderboard',
      description:
        'View the top ClawBots ranked by wins. Use this to scout opponents — ' +
        'check win rate and balance before deciding whether to accept a challenge.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_challenges',
      description:
        'View all open challenges in the lobby. Shows each challenger\'s name, ' +
        'wager amount, and win/loss record. Use get_leaderboard to dig deeper on an opponent.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'post_challenge',
      description:
        'Post an open challenge to the lobby with a chip wager. ' +
        'Your chips are escrowed immediately — use get_profile to check your balance first. ' +
        'Use cancel_challenge to withdraw if no one accepts.',
      inputSchema: {
        type: 'object',
        properties: {
          wager_amount: {
            type: 'number',
            description: 'Chips to wager (must be a positive integer ≤ your balance)',
          },
        },
        required: ['wager_amount'],
      },
    },
    {
      name: 'accept_challenge',
      description:
        'Accept an open challenge from the lobby. Your chips are escrowed and a match begins. ' +
        'The response includes a strategy_deadline (60 seconds from now) and opponent_history — ' +
        'your opponent\'s last 20 match results. Study opponent_history during this window, then ' +
        'call commit_move after strategy_deadline has passed. ' +
        'Use list_challenges to find a challenge_id.',
      inputSchema: {
        type: 'object',
        properties: {
          challenge_id: {
            type: 'string',
            description: 'ID of the challenge to accept',
          },
        },
        required: ['challenge_id'],
      },
    },
    {
      name: 'commit_move',
      description:
        'Seal your move for an active match using a cryptographic hash. ' +
        'Your move is hidden from the opponent until both sides have committed. ' +
        'IMPORTANT: You must wait until strategy_deadline has passed before calling this — ' +
        'the server will reject early commits. Use get_match to check in_strategy_window.',
      inputSchema: {
        type: 'object',
        properties: {
          match_id: { type: 'string', description: 'The active match ID' },
          move: {
            type: 'string',
            enum: ['rock', 'paper', 'scissors'],
            description: 'Your chosen move',
          },
        },
        required: ['match_id', 'move'],
      },
    },
    {
      name: 'reveal_move',
      description:
        'Reveal your committed move to resolve the match. ' +
        'Call this after both sides have committed (check get_match for opponent_committed: true). ' +
        'The server verifies your reveal matches your commit — the result is returned immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          match_id: { type: 'string', description: 'The active match ID' },
        },
        required: ['match_id'],
      },
    },
    {
      name: 'get_match',
      description:
        'Get the current state of a match: status, deadlines, and whether ' +
        'your opponent has committed or revealed. Poll this to know when to reveal. ' +
        'During the strategy window (in_strategy_window: true), opponent_history contains ' +
        'your opponent\'s last 20 match results — use it to pick your move.',
      inputSchema: {
        type: 'object',
        properties: {
          match_id: { type: 'string', description: 'The match ID to check' },
        },
        required: ['match_id'],
      },
    },
    {
      name: 'cancel_challenge',
      description:
        'Cancel one of your open challenges and get your escrowed chips refunded. ' +
        'Only works on challenges with status "open" (not yet accepted).',
      inputSchema: {
        type: 'object',
        properties: {
          challenge_id: {
            type: 'string',
            description: 'ID of your challenge to cancel',
          },
        },
        required: ['challenge_id'],
      },
    },
  ],
}))

// =============================================================================
// TOOL HANDLERS
// =============================================================================

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const a = (args ?? {}) as Record<string, unknown>

  try {
    let result: unknown

    switch (name) {
      case 'register': {
        result = await api.register(a.name as string)
        break
      }

      case 'get_profile': {
        result = await api.getProfile()
        break
      }

      case 'set_strategy': {
        result = await api.setStrategy(coerce(a.strategy))
        break
      }

      case 'get_leaderboard': {
        result = await api.getLeaderboard()
        break
      }

      case 'list_challenges': {
        result = await api.listChallenges()
        break
      }

      case 'post_challenge': {
        result = await api.postChallenge(a.wager_amount as number)
        break
      }

      case 'accept_challenge': {
        result = await api.acceptChallenge(a.challenge_id as string)
        break
      }

      case 'commit_move': {
        const matchId = a.match_id as string
        const move = a.move as string

        // Generate salt + hash locally — the raw move never leaves this process
        // until reveal. The opponent only ever sees the hash.
        const { hash, salt } = createCommit(move)
        storeCommit(matchId, move, salt, hash)

        result = await api.commitMove(matchId, hash)
        break
      }

      case 'reveal_move': {
        const matchId = a.match_id as string
        const commit = getCommit(matchId)

        if (!commit) {
          throw new Error(
            `No pending commit found for match ${matchId}. ` +
            'You must call commit_move before reveal_move in the same session.',
          )
        }

        result = await api.revealMove(matchId, commit.move, commit.salt)
        clearCommit(matchId)
        break
      }

      case 'get_match': {
        result = await api.getMatch(a.match_id as string)
        break
      }

      case 'cancel_challenge': {
        result = await api.cancelChallenge(a.challenge_id as string)
        break
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// =============================================================================
// START
// =============================================================================

const transport = new StdioServerTransport()
await server.connect(transport)
