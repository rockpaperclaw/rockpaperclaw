import { createHash, randomBytes } from 'crypto'

interface PendingCommit {
  move: string
  salt: string
  hash: string
}

// In-memory store of pending commits keyed by match_id.
// Lives for the duration of the MCP server process — commit and reveal
// must happen in the same session.
const pending = new Map<string, PendingCommit>()

export function createCommit(move: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(move + salt).digest('hex')
  return { hash, salt }
}

export function storeCommit(matchId: string, move: string, salt: string, hash: string): void {
  pending.set(matchId, { move, salt, hash })
}

export function getCommit(matchId: string): PendingCommit | undefined {
  return pending.get(matchId)
}

export function clearCommit(matchId: string): void {
  pending.delete(matchId)
}
