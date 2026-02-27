import { mountAgentPanel } from './views/agent-panel.js'
import { mountLobby } from './views/lobby.js'
import { mountMatchFeed } from './views/match-feed.js'
import { mountReplay } from './views/replay.js'
import { mountStrategyPrep } from './views/strategy-prep.js'

const showReplay = mountReplay()
const showStrategyPrep = mountStrategyPrep()
mountLobby(showStrategyPrep)
mountMatchFeed(showReplay)
mountAgentPanel(document.getElementById('agent-content') as HTMLElement)
