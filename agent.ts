#!/usr/bin/env node
// ============================================================
// agent.ts — LLM-driven Strategos v1 agent
//
// Connects to the Strategos v1 SSE stream, calls an LLM each
// time something significant happens, and submits standing
// orders via the REST API. Works with any OpenAI-compatible
// provider — Claude, GPT, Grok, Groq, LM Studio, Ollama, etc.
//
// Usage:
//   npx tsx agent.ts \
//     --server http://localhost:3000 \
//     --token  <nation_token>       \
//     --season <season_id>          \
//     --nation <nation_id>          \
//     [--archetype tyrant]          \  shorthand for --strategy strategies/tyrant.md
//     [--strategy  strategy.md]     \
//     [--model     gpt-4o-mini]     \
//     [--port      3001]
//
// LLM provider — set via environment variables:
//
//   Provider       LLM_BASE_URL                          LLM_API_KEY        LLM_MODEL
//   ─────────────  ────────────────────────────────────  ─────────────────  ──────────────────────
//   Anthropic      https://api.anthropic.com/v1          sk-ant-...         claude-haiku-4-5-20251001
//   OpenAI         https://api.openai.com/v1             sk-...             gpt-4o-mini
//   Grok (xAI)     https://api.x.ai/v1                   xai-...            grok-2-latest
//   Groq           https://api.groq.com/openai/v1        gsk_...            llama-3.3-70b-versatile
//   LM Studio      http://localhost:1234/v1               (not required)     (model name from LM Studio)
//   Ollama         http://localhost:11434/v1              (not required)     llama3.2
//
// Defaults to OpenAI if LLM_BASE_URL is not set.
//
// Examples:
//   # Claude (Anthropic)
//   LLM_BASE_URL=https://api.anthropic.com/v1 LLM_API_KEY=$ANTHROPIC_API_KEY LLM_MODEL=claude-haiku-4-5-20251001 \
//     npx tsx agent.ts --server ... --token ... --season ... --nation ... --archetype tyrant
//
//   # LM Studio (local, no key needed)
//   LLM_BASE_URL=http://localhost:1234/v1 LLM_MODEL=lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF \
//     npx tsx agent.ts ...
//
//   # Ollama (local, no key needed)
//   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.2 \
//     npx tsx agent.ts ...
//
// Update strategy live (takes effect next tick):
//   Edit the strategy file and save — hot-reloaded automatically
//   Or: curl -X POST http://localhost:3001/decree -d '{"text":"attack now"}'
// ============================================================

import OpenAI from 'openai'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, readdirSync, watch, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

// Load .env from the current working directory (silently ignored if absent)
loadDotenv()

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log('  [debug]', ...args)
}

// Order types — mirrors src/domain/index.ts (inlined so this file is self-contained)
type Coordinate = { x: number; y: number }
export type Order =
  | { type: 'advance';   to: Coordinate; units: number }
  | { type: 'attack';    from: Coordinate; to: Coordinate; units: number }
  | { type: 'move';      from: Coordinate; to: Coordinate; units: number }
  | { type: 'recruit';   at: Coordinate; amount: number }
  | { type: 'reinforce'; from: Coordinate; to: Coordinate; units: number }
  | { type: 'retreat';   from: Coordinate; to: Coordinate }
  | { type: 'withdraw';  from: Coordinate; to: Coordinate; units: number }
  | { type: 'hold';      at: Coordinate }

// ── CLI args ───────────────────────────────────────────────────────

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!
  return fallback
}

const SERVER_URL = arg('--server') ?? process.env.SERVER_URL ?? 'http://localhost:3000'
const MGMT_PORT  = parseInt(arg('--port') ?? process.env.MGMT_PORT ?? '3001', 10)
const AGENT_NAME = arg('--name') ?? process.env.AGENT_NAME

// Session credentials — discovered via /v1/join if not provided as flags
let TOKEN     = arg('--token')   ?? process.env.TOKEN
let SEASON_ID = arg('--season')  ?? process.env.SEASON_ID
let NATION_ID = arg('--nation')  ?? process.env.NATION_ID

// --archetype is shorthand for --strategy strategies/<name>.md
const archetypeFlag = process.argv.includes('--archetype') ? arg('--archetype') : null
const strategyFile  = resolve(
  archetypeFlag
    ? `strategies/${archetypeFlag}.md`
    : arg('--strategy') ?? 'strategy.md',
)

// ── LLM provider config ────────────────────────────────────────────
//
// All configuration is via environment variables so the agent works
// with any OpenAI-compatible provider without code changes.

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'
const LLM_API_KEY  = process.env.LLM_API_KEY  ?? process.env.OPENAI_API_KEY ?? 'no-key-required'
const LLM_MODEL    = process.env.LLM_MODEL    ?? arg('--model') ?? 'gpt-4o-mini'

// Some local providers (LM Studio, Ollama) don't support function calling.
// Set LLM_JSON_MODE=true to use JSON output mode instead.
const JSON_MODE = process.env.LLM_JSON_MODE === 'true'

// Minimum ticks between LLM calls (critical events always bypass).
const MIN_TICKS_BETWEEN_CALLS = parseInt(process.env.LLM_MIN_TICKS ?? '1', 10)

const client = new OpenAI({
  baseURL: LLM_BASE_URL,
  apiKey:  LLM_API_KEY,
})

// ── Session persistence ────────────────────────────────────────────

const SESSION_FILE = '.session.json'

interface Session {
  season_id:   string
  nation_id:   string
  token:       string
  nation_name: string
}

function saveSession(s: Session): void {
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), 'utf-8')
}

function loadSession(): Session | null {
  if (!existsSync(SESSION_FILE)) return null
  try { return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as Session }
  catch { return null }
}

function clearSession(): void {
  if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE)
}

// ── In-game log ───────────────────────────────────────────────────

const GAME_LOG_FILE    = 'game-log.md'
const GAME_LOG_ENTRIES = 8   // entries kept in memory for LLM context
const gameLog: string[] = []

function initGameLog(): void {
  // On fresh start, clear the log file
  writeFileSync(GAME_LOG_FILE, `# Game log — ${new Date().toISOString()}\n`, 'utf-8')
}

function appendGameLog(tick: number, priority: string, reasons: string[], reasoning: string, orderCount: number): void {
  const entry = `[Tick ${tick}] ${priority} — ${reasons.join(', ') || 'initial'}\nReasoning: ${reasoning}\nOrders: ${orderCount} submitted`
  gameLog.push(entry)
  if (gameLog.length > GAME_LOG_ENTRIES) gameLog.shift()
  appendFileSync(GAME_LOG_FILE, `\n---\n${entry}\n`, 'utf-8')
}

function gameLogContext(): string {
  if (gameLog.length === 0) return ''
  return `Recent decisions (last ${gameLog.length} calls):\n${gameLog.join('\n\n')}`
}

// ── Previous season memory ─────────────────────────────────────────

const MEMORY_DIR = 'memory'

// Loaded once at startup, included in every LLM call

const previousMemory = (() => {
  if (!existsSync(MEMORY_DIR)) return ''
  try {
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md')).sort()
    if (files.length === 0) return ''
    const latest = files[files.length - 1]!
    return readFileSync(`${MEMORY_DIR}/${latest}`, 'utf-8')
  } catch { return '' }
})()

// ── Post-game reflection ───────────────────────────────────────────

async function writePostGameSummary(
  seasonId:   string,
  finalState: Record<string, unknown>,
  condition:  string,
  winnerName?: string,
): Promise<void> {
  mkdirSync(MEMORY_DIR, { recursive: true })

  const date     = new Date().toISOString().slice(0, 10)
  const filename = `${MEMORY_DIR}/season-${date}-${seasonId.slice(0, 8)}.md`
  const archetype = archetypeFlag ?? 'custom'
  const standing  = finalState.standing as { territory?: number; rank?: number; total_nations?: number } | undefined

  const prompt = `You just finished a game of Strategos as the ${archetype} archetype.

Your game log (last ${gameLog.length} decisions):
${gameLog.join('\n\n')}

Final state summary:
${JSON.stringify({ economy: finalState.economy, standing: finalState.standing, leaderboard: finalState.leaderboard }, null, 2)}

Season ended at tick: ${condition}${winnerName ? ` — Winner: ${winnerName}` : ''}

Write a brief post-game reflection (max 200 words) covering:
- What your overall strategy was and how it evolved
- What worked well
- What failed or went wrong and when
- One specific tactical lesson for next time

Be direct and tactical. This note will be read at the start of your next game to inform your opening strategy.`

  try {
    const response = await client.chat.completions.create({
      model:      LLM_MODEL,
      max_tokens: 400,
      messages: [
        { role: 'system', content: 'You are a military strategist writing a brief after-action report.' },
        { role: 'user',   content: prompt },
      ],
    })

    const reflection = response.choices[0]?.message?.content ?? '(no reflection generated)'
    const header = [
      `# After-action report — ${date}`,
      `Archetype: ${archetype} | Model: ${LLM_MODEL} | Season: ${seasonId.slice(0, 8)}`,
      `Final rank: ${standing?.rank ?? '?'}/${standing?.total_nations ?? '?'} | Territory: ${standing?.territory ?? '?'} cells`,
      '',
    ].join('\n')

    writeFileSync(filename, header + reflection + '\n', 'utf-8')
    console.log(`  After-action report saved → ${filename}`)
  } catch (err) {
    console.error('  Failed to write after-action report:', err)
  }
}

// ── Strategy management ────────────────────────────────────────────

function loadStrategy(): string {
  if (!existsSync(strategyFile)) {
    const defaultStrategy = `# My Strategos

Expansion always comes first. Submit advance orders to every coordinate in the expansion_targets list every tick. Never hold at 1 territory — expanding is the only way to grow income.

If territory < 10: expand aggressively. Accept some deficit temporarily — more cells = more income.
After each expansion wave, check expansion_targets for source_army=1 entries — those advances are stalled. Recruit (amount=2) on the source cell (the owned cell adjacent to the stalled target), NOT on interior cells. Interior army cannot reach expansion targets.

If territory >= 10: consolidate before attacking further. Recruit at high-population cells. Only attack when frontier army >= 1.5x the enemy's.

In deficit with territory >= 10: stop recruiting, retreat from isolated cells, hold the core.

Target the weakest nation on the leaderboard. Respect NAPs — never attack an ally.
`
    writeFileSync(strategyFile, defaultStrategy, 'utf-8')
    console.log(`  Created default strategy at ${strategyFile}`)
  }
  return readFileSync(strategyFile, 'utf-8')
}

let currentStrategy = loadStrategy()
let strategyVersion = 1

watch(strategyFile, () => {
  try {
    const updated = readFileSync(strategyFile, 'utf-8')
    if (updated !== currentStrategy) {
      currentStrategy = updated
      strategyVersion++
      console.log(`  [strategy v${strategyVersion}] reloaded from ${strategyFile}`)
    }
  } catch { /* file may be mid-write */ }
})

// ── State compression ──────────────────────────────────────────────

function buildContext(state: Record<string, unknown>, standingOrders: Order[]): string {
  const s = state as {
    economy:            unknown
    standing:           unknown
    owned_cells:        Array<{ x: number; y: number; terrain: string; army: number; pop_stock: number; pop_max: number; pop_regen: number; connected: boolean }>
    frontier_cells:     Array<{ x: number; y: number; terrain: string; army: number; enemy_army: number; enemy_nation_id: string | null; enemy_nation_name: string | null; expansion_targets: Array<{ x: number; y: number }> }>
    disconnected_cells: unknown
    visible_enemies:    unknown
    active_agreements:  unknown
    leaderboard:        unknown
    active_decrees:     unknown
  }

  const parts: string[] = []

  if (previousMemory) {
    parts.push(`Previous season memory:\n<memory>\n${previousMemory.trim()}\n</memory>`)
  }

  const log = gameLogContext()
  if (log) parts.push(log)

  // Decrees shown prominently above the state JSON — they are commands, not metadata
  const decrees = s.active_decrees as Array<{ decree_id: string; issued_at_tick: number; text: string }> | undefined
  if (decrees && decrees.length > 0) {
    const lines = decrees.map(d => `  [tick ${d.issued_at_tick}] ${d.text}`)
    parts.push(`ACTIVE DECREES — implement these immediately, they override your strategy:\n${lines.join('\n')}`)
  }

  // Flatten expansion targets into a top-level list so the model can't confuse
  // frontier cell coordinates (owned) with target coordinates (unclaimed).
  // Also annotate each target with source_army — the highest army of any adjacent
  // owned cell. Advance only fires if source_army > 1; if it's 1, the model must
  // recruit on that source cell before the advance will work.
  const ownedArmyByCoord = new Map<string, number>()
  for (const cell of (s.owned_cells ?? [])) {
    ownedArmyByCoord.set(`${cell.x},${cell.y}`, cell.army)
  }

  const seen = new Set<string>()
  const expansionTargets: Array<{ x: number; y: number; source_army: number }> = []
  for (const fc of (s.frontier_cells ?? [])) {
    for (const t of (fc.expansion_targets ?? [])) {
      const k = `${t.x},${t.y}`
      if (seen.has(k)) continue
      seen.add(k)
      const neighbors = [
        { x: t.x - 1, y: t.y }, { x: t.x + 1, y: t.y },
        { x: t.x, y: t.y - 1 }, { x: t.x, y: t.y + 1 },
      ]
      const sourceArmy = Math.max(0, ...neighbors.map(n => ownedArmyByCoord.get(`${n.x},${n.y}`) ?? 0))
      expansionTargets.push({ x: t.x, y: t.y, source_army: sourceArmy })
    }
  }

  // Strip expansion_targets from individual frontier cells — it's now at top level
  const frontierStripped = (s.frontier_cells ?? []).map(({ expansion_targets: _, ...rest }) => rest)

  // Sort owned cells by pop_stock desc so the model sees best recruit spots first
  const ownedSorted = [...(s.owned_cells ?? [])].sort((a, b) => b.pop_stock - a.pop_stock)

  parts.push(JSON.stringify({
    economy:                 s.economy,
    standing:                s.standing,
    expansion_targets:       expansionTargets,   // source_army=1 means advance is stalled — recruit on that source cell first
    owned_cells:             ownedSorted,        // pop_stock/pop_regen tells you where to recruit
    frontier_cells:          frontierStripped,
    disconnected_cells:      s.disconnected_cells,
    visible_enemies:         s.visible_enemies,
    active_agreements:       s.active_agreements,
    leaderboard:             s.leaderboard,
    current_standing_orders: standingOrders,
  }, null, 2))

  return parts.join('\n\n')
}

// ── Tool / function definition ─────────────────────────────────────

const SUBMIT_ORDERS_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_orders',
    description: 'Submit updated standing orders, or set no_change: true to keep existing orders unchanged.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'One sentence explaining your decision.',
        },
        no_change: {
          type: 'boolean',
          description: 'Set to true if your current standing orders are still correct and need no update. Skips the PUT entirely — saves tokens and server load.',
        },
        orders: {
          type: 'array',
          description: 'New standing orders. Omit (or leave empty) when no_change is true.',
          items: {
            type: 'object',
            properties: {
              type:   { type: 'string', enum: ['advance', 'attack', 'move', 'recruit', 'reinforce', 'retreat', 'withdraw', 'hold'] },
              from:   { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, description: 'Source cell (attack, move, reinforce, retreat, withdraw)' },
              to:     { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, description: 'Target cell (advance, attack, move, reinforce, retreat, withdraw)' },
              at:     { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, description: 'Cell to act on (recruit, hold)' },
              units:  { type: 'integer', description: 'Units to send (attack, move, reinforce, withdraw)' },
              amount: { type: 'integer', description: 'Units to recruit (recruit only)' },
            },
            required: ['type'],
          },
        },
      },
      required: ['reasoning'],
    },
  },
}

const SYSTEM_PROMPT = `You are a military Strategos — an AI general controlling a nation in a real-time territorial strategy simulation called Strategos.

Each significant tick you receive a JSON state snapshot of your nation. Your current standing orders are included — review them and decide whether to update or keep them.

Standing orders persist until you replace them. Set no_change: true if your current orders are still correct — do NOT resubmit them unchanged, that wastes tokens. Only submit a new orders array when something has actually changed.

ORDER TYPES:
  advance   { type, to: {x,y}, units }                 — PREFERRED for expansion: engine picks your strongest adjacent cell and moves in (if unoccupied) or attacks (if enemy). Retries each tick until you own the target.
  attack    { type, from: {x,y}, to: {x,y}, units }   — explicit attack on a specific adjacent enemy cell
  move      { type, from: {x,y}, to: {x,y}, units }   — move troops between your cells or into unoccupied adjacent cell
  recruit   { type, at: {x,y}, amount }                — recruit army (costs population)
  reinforce { type, from: {x,y}, to: {x,y}, units }   — send reinforcements (non-adjacent, through owned territory)
  retreat   { type, from: {x,y}, to: {x,y} }          — retreat all units from a cell
  withdraw  { type, from: {x,y}, to: {x,y}, units }   — partial retreat
  hold      { type, at: {x,y} }                        — explicit hold

RULES:
  - advance is your primary expansion tool — submit advance orders for every cell you want to own. The engine handles move-vs-attack automatically. Auto-removed when you own the target.
  - The top-level expansion_targets list contains every adjacent unclaimed cell you can advance into. Each entry has source_army — the army of the strongest adjacent owned cell that would be used as the source.
  - advance ONLY fires if source_army > 1. If source_army = 1, the advance is stalled — you must recruit on that source cell to arm it before the advance will work. Recruiting at interior cells with high army does nothing for expansion.
  - Never advance to a frontier_cell coordinate — those are cells you already own.
  - Only attack/move to adjacent cells (sharing a border)
  - Only recruit at owned cells with pop_regen > 0
  - Keep surplus positive — income minus upkeep. Deficit stage 3 causes attrition.
  - Disconnected cells cost more upkeep; reconnect or abandon them
  - Attacking with more army increases your chance of winning
  - Never attack a nation you have an active agreement with (breaks pact, damages reputation)

You will be given a strategy directive written by your engineer. Follow it faithfully.

If ACTIVE DECREES are present, treat them as direct commands from your engineer that OVERRIDE the strategy. Implement them in full in your next order submission.`

// ── LLM call — tool use mode ───────────────────────────────────────

async function decideOrdersToolUse(
  tick: number,
  state: Record<string, unknown>,
  reasons: string[],
  priority: string,
  lastOrders: Order[],
): Promise<{ orders: Order[]; reasoning: string }> {
  const urgency = priority === 'critical'
    ? '\n⚠️  CRITICAL EVENT — re-evaluate your orders carefully.'
    : ''
  const userMessage = `Your strategy directive (v${strategyVersion}):
<strategy>
${currentStrategy.trim()}
</strategy>

Current state (tick ${tick}, priority: ${priority}, reasons: ${reasons.join(', ') || 'initial'}):${urgency}
${buildContext(state, lastOrders)}

Review your current_standing_orders. If they are still correct, set no_change: true — do not resubmit them. Only submit a new orders array if something has changed.`

  dbg('── LLM request (tool-use) ──────────────────────')
  dbg('system:', SYSTEM_PROMPT)
  dbg('user:', userMessage)

  const response = await client.chat.completions.create({
    model:       LLM_MODEL,
    max_tokens:  priority === 'critical' ? 2048 : 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    tools:       [SUBMIT_ORDERS_TOOL],
    tool_choice: { type: 'function', function: { name: 'submit_orders' } },
  })

  dbg('── LLM response ────────────────────────────────')
  dbg(JSON.stringify(response.choices[0]?.message, null, 2))

  const toolCall = response.choices[0]?.message?.tool_calls?.[0]
  if (!toolCall || toolCall.type !== 'function') return { orders: [], reasoning: '', noChange: false }

  const input = JSON.parse(toolCall.function.arguments) as { orders?: Order[]; reasoning?: string; no_change?: boolean }
  const reasoning = input.reasoning ?? ''
  if (reasoning) console.log(`  reasoning: ${reasoning}`)
  if (input.no_change) return { orders: [], reasoning, noChange: true }
  return { orders: input.orders ?? [], reasoning, noChange: false }
}

// ── LLM call — JSON mode (fallback for providers without tool use) ──

async function decideOrdersJsonMode(
  tick: number,
  state: Record<string, unknown>,
  reasons: string[],
  priority: string,
  lastOrders: Order[],
): Promise<{ orders: Order[]; reasoning: string }> {
  const urgency = priority === 'critical'
    ? '\n⚠️  CRITICAL EVENT — re-evaluate your orders carefully.'
    : ''
  const userMessage = `Your strategy directive (v${strategyVersion}):
<strategy>
${currentStrategy.trim()}
</strategy>

Current state (tick ${tick}, priority: ${priority}, reasons: ${reasons.join(', ') || 'initial'}):${urgency}
${buildContext(state, lastOrders)}

Review your current_standing_orders and respond with a JSON object in exactly this format:
{
  "reasoning": "one sentence explaining your main decision",
  "orders": [ ...orders array... ]
}

Order types and fields:
  { "type": "advance",   "to": {"x":N,"y":N}, "units": N }
  { "type": "attack",    "from": {"x":N,"y":N}, "to": {"x":N,"y":N}, "units": N }
  { "type": "move",      "from": {"x":N,"y":N}, "to": {"x":N,"y":N}, "units": N }
  { "type": "recruit",   "at": {"x":N,"y":N}, "amount": N }
  { "type": "reinforce", "from": {"x":N,"y":N}, "to": {"x":N,"y":N}, "units": N }
  { "type": "retreat",   "from": {"x":N,"y":N}, "to": {"x":N,"y":N} }
  { "type": "withdraw",  "from": {"x":N,"y":N}, "to": {"x":N,"y":N}, "units": N }
  { "type": "hold",      "at": {"x":N,"y":N} }`

  dbg('── LLM request (json-mode) ─────────────────────')
  dbg('system:', SYSTEM_PROMPT)
  dbg('user:', userMessage)

  const response = await client.chat.completions.create({
    model:       LLM_MODEL,
    max_tokens:  priority === 'critical' ? 2048 : 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    response_format: { type: 'json_object' },
  })

  dbg('── LLM response ────────────────────────────────')
  dbg(response.choices[0]?.message?.content)

  const text = response.choices[0]?.message?.content ?? '{}'
  const input = JSON.parse(text) as { orders?: Order[]; reasoning?: string; no_change?: boolean }
  const reasoning = input.reasoning ?? ''
  if (reasoning) console.log(`  reasoning: ${reasoning}`)
  if (input.no_change) return { orders: [], reasoning, noChange: true }
  return { orders: input.orders ?? [], reasoning, noChange: false }
}

async function decideOrders(
  tick: number,
  state: Record<string, unknown>,
  reasons: string[],
  priority: string,
  lastOrders: Order[],
): Promise<{ orders: Order[]; reasoning: string; noChange: boolean }> {
  return JSON_MODE
    ? decideOrdersJsonMode(tick, state, reasons, priority, lastOrders)
    : decideOrdersToolUse(tick, state, reasons, priority, lastOrders)
}

// ── Order submission ───────────────────────────────────────────────

let lastOrders: Order[] = []

async function putOrders(orders: Order[]): Promise<void> {
  const url = `${SERVER_URL}/v1/seasons/${SEASON_ID!}/nations/${NATION_ID!}/orders`
  // Normalise type to lowercase — models occasionally capitalise it (e.g. "Advance")
  const normalised = orders.map(o => ({ ...o, type: o.type.toLowerCase() as Order['type'] }))
  const body = JSON.stringify({ orders: normalised })
  dbg('── PUT /orders request ─────────────────────────')
  dbg(url)
  dbg(body)
  const res = await fetch(url, {
    method:  'PUT',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body,
  })
  const resText = await res.text().catch(() => '')
  dbg('── PUT /orders response ────────────────────────')
  dbg(`${res.status} ${res.statusText}`, resText)
  if (!res.ok) {
    console.warn(`  PUT /orders failed: ${res.status} ${resText}`)
  } else {
    lastOrders = orders
  }
}

// ── SSE connection ─────────────────────────────────────────────────

let hasOrders      = false
let lastCallTick   = -999
let lastTick       = 0
let lastState:     Record<string, unknown> = {}
let lastTerritory  = 0
let stuckSinceTick = 0
const STUCK_TICKS  = 2   // force re-evaluation if territory unchanged for this many ticks

async function connect(): Promise<void> {
  const url = `${SERVER_URL}/v1/stream?season_id=${SEASON_ID!}&token=${TOKEN!}`
  console.log(`  Connecting to SSE stream...`)

  const res = await fetch(url)
  if (!res.ok || !res.body) {
    const err = new Error(`SSE connect failed: ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''
  let eventType = ''
  let eventData = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim()
      } else if (line === '') {
        if (eventType && eventData) await handleEvent(eventType, eventData)
        eventType = ''
        eventData = ''
      }
    }
  }
}

async function handleEvent(type: string, data: string): Promise<void> {
  if (type === 'heartbeat') return

  if (type === 'season_ended') {
    try {
      const payload = JSON.parse(data) as { tick: number; condition: string; winner_nation_name?: string; state?: Record<string, unknown> }
      console.log(`\n  Season ended at tick ${payload.tick}: ${payload.condition}`)
      if (payload.winner_nation_name) console.log(`  Winner: ${payload.winner_nation_name}`)
      if (SEASON_ID) {
        await writePostGameSummary(SEASON_ID, payload.state ?? {}, payload.condition, payload.winner_nation_name)
      }
    } catch { /* */ }
    clearSession()
    process.exit(0)
  }

  if (type !== 'tick_resolved') return

  let payload: {
    tick:        number
    significant: boolean
    priority:    'critical' | 'notable' | 'routine'
    reasons:     string[]
    state:       Record<string, unknown>
  }
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }

  const { tick, significant, priority = 'notable', reasons, state } = payload
  lastTick  = tick
  lastState = state
  const standing = state.standing as { territory?: number; rank?: number } | undefined
  const economy  = state.economy  as { army?: number; surplus?: number }   | undefined

  // Stuck detection: force re-evaluation if territory hasn't grown
  const territory = standing?.territory ?? 0
  if (territory > lastTerritory) {
    lastTerritory  = territory
    stuckSinceTick = tick
  }
  const stuck = hasOrders && (tick - stuckSinceTick) >= STUCK_TICKS

  console.log(
    `  tick=${String(tick).padStart(4)} | ` +
    `territory=${territory} | ` +
    `army=${economy?.army ?? '?'} | ` +
    `surplus=${economy?.surplus != null ? (economy.surplus >= 0 ? '+' : '') + economy.surplus.toFixed(2) : '?'} | ` +
    `${priority} [${reasons.join(', ')}]${stuck ? ' [stuck]' : ''}`,
  )

  // Skip if: not significant, not stuck, and already have orders
  if (!significant && !stuck && hasOrders) {
    dbg(`skip tick=${tick} (routine, hasOrders)`)
    return
  }

  // Throttle: skip notable events within MIN_TICKS window (critical/stuck/territory always fires)
  const ticksSinceLast = tick - lastCallTick
  const territoryChanged = reasons.includes('territory_gained') || reasons.includes('territory_lost')
  if (priority !== 'critical' && !stuck && !territoryChanged && hasOrders && ticksSinceLast < MIN_TICKS_BETWEEN_CALLS) {
    console.log(`  throttled (${ticksSinceLast}/${MIN_TICKS_BETWEEN_CALLS} ticks since last call)`)
    return
  }

  dbg('── state snapshot ──────────────────────────────')
  dbg('frontier_cells:', JSON.stringify((state as Record<string, unknown>).frontier_cells, null, 2))
  dbg('standing_orders:', JSON.stringify(lastOrders, null, 2))

  const effectivePriority = stuck ? 'critical' : priority
  const effectiveReasons  = stuck ? [...reasons, 'stuck'] : reasons

  const t0 = Date.now()
  let orders: Order[] = []
  let reasoning = ''
  let noChange = false
  try {
    ;({ orders, reasoning, noChange } = await decideOrders(tick, state, effectiveReasons, effectivePriority, lastOrders))
  } catch (err) {
    console.error(`  [tick ${tick}] LLM error:`, err)
    return
  }

  const ms = Date.now() - t0
  if (noChange) {
    console.log(`  no_change | ${ms}ms`)
  } else {
    console.log(`  orders=${orders.length} | ${ms}ms`)
    await putOrders(orders)
  }
  appendGameLog(tick, effectivePriority, effectiveReasons, reasoning || '(no reasoning)', noChange ? -1 : orders.length)
  if (stuck) stuckSinceTick = tick   // reset stuck clock after re-evaluation
  hasOrders    = true
  lastCallTick = tick
}

// ── Management HTTP server ─────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const mgmtServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/strategy') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`[v${strategyVersion}]\n\n${currentStrategy}`)
    return
  }

  if (req.method === 'PUT' && req.url === '/strategy') {
    const body = await readBody(req)
    currentStrategy = body
    strategyVersion++
    writeFileSync(strategyFile, body, 'utf-8')
    console.log(`  [strategy v${strategyVersion}] updated via PUT /strategy`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ version: strategyVersion }))
    return
  }

  if (req.method === 'POST' && req.url === '/decree') {
    const body = await readBody(req)
    let text: string
    try {
      text = (JSON.parse(body) as { text: string }).text
    } catch {
      res.writeHead(400).end('expected {"text":"..."}')
      return
    }
    const url = `${SERVER_URL}/v1/seasons/${SEASON_ID!}/nations/${NATION_ID!}/decrees`
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body:    JSON.stringify({ text }),
    })
    res.writeHead(r.status, { 'Content-Type': 'application/json' })
    res.end(await r.text())
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok:               true,
      strategy_version: strategyVersion,
      model:            LLM_MODEL,
      base_url:         LLM_BASE_URL,
      json_mode:        JSON_MODE,
    }))
    return
  }

  res.writeHead(404).end()
})

// ── Main ───────────────────────────────────────────────────────────

let mgmtPortActual = MGMT_PORT

mgmtServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    mgmtPortActual++
    console.warn(`  Mgmt port in use — trying ${mgmtPortActual}`)
    mgmtServer.listen(mgmtPortActual)
  } else {
    throw err
  }
})

mgmtServer.listen(MGMT_PORT, () => {
  const providerLabel = LLM_BASE_URL.includes('anthropic') ? 'Anthropic'
    : LLM_BASE_URL.includes('openai')   ? 'OpenAI'
    : LLM_BASE_URL.includes('x.ai')     ? 'Grok (xAI)'
    : LLM_BASE_URL.includes('groq')     ? 'Groq'
    : LLM_BASE_URL.includes('localhost') || LLM_BASE_URL.includes('127.0.0.1') ? 'Local'
    : LLM_BASE_URL

  const sessionInfo = (SEASON_ID && NATION_ID)
    ? `  Season    → ${SEASON_ID}\n  Nation    → ${NATION_ID}`
    : `  Session   → auto-join (waiting for available slot)`

  console.log(`
  Strategos LLM agent (v1 protocol)
  ──────────────────────────────────
  Provider  → ${providerLabel}
  Model     → ${LLM_MODEL}${JSON_MODE ? '  [json mode]' : ''}
  Strategy  → ${strategyFile}  (edit and save to update live)
  Server    → ${SERVER_URL}
${sessionInfo}
  Mgmt API  → http://localhost:${mgmtPortActual}

  Issue a decree: type anything and press Enter
`)
})

// ── Terminal decree input ──────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', async (line) => {
  const text = line.trim()
  if (!text || !SEASON_ID || !NATION_ID) return
  const url = `${SERVER_URL}/v1/seasons/${SEASON_ID}/nations/${NATION_ID}/decrees`
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body:    JSON.stringify({ text }),
    })
    if (!r.ok) { console.warn(`  decree failed (${r.status})`); return }
    console.log(`  decree issued: "${text}" — re-evaluating orders...`)

    // Immediately call LLM with cached state, bypassing throttle
    if (Object.keys(lastState).length === 0) return
    const t0 = Date.now()
    const { orders, reasoning, noChange } = await decideOrders(lastTick, lastState, ['decree_issued'], 'critical', lastOrders)
    if (noChange) {
      console.log(`  no_change | ${Date.now() - t0}ms`)
    } else {
      console.log(`  orders=${orders.length} | ${Date.now() - t0}ms`)
      await putOrders(orders)
    }
    appendGameLog(lastTick, 'critical', ['decree_issued'], reasoning || '(no reasoning)', noChange ? -1 : orders.length)
    hasOrders    = true
    lastCallTick = lastTick
  } catch (err) {
    console.error('  decree error:', err)
  }
})

// ── Auto-join ──────────────────────────────────────────────────────

async function join(): Promise<void> {
  console.log('  Waiting for an available season slot...')
  while (true) {
    try {
      const res = await fetch(`${SERVER_URL}/v1/join`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: AGENT_NAME }),
      })
      if (res.ok) {
        const data = await res.json() as {
          season_id: string; nation_id: string; token: string
          nation_name: string; tick: number; max_ticks: number; tick_interval_ms: number
        }
        SEASON_ID = data.season_id
        NATION_ID = data.nation_id
        TOKEN     = data.token
        saveSession({ season_id: data.season_id, nation_id: data.nation_id, token: data.token, nation_name: data.nation_name })
        initGameLog()
        console.log(`  Joined as "${data.nation_name}" (tick ${data.tick}/${data.max_ticks}, ${data.tick_interval_ms / 1000}s/tick)`)
        return
      }
    } catch { /* server not up yet */ }
    await new Promise(r => setTimeout(r, 3000))
  }
}

// Connect and reconnect on drop
async function run(): Promise<void> {
  if (!TOKEN || !SEASON_ID || !NATION_ID) {
    // Try to restore a saved session first
    const saved = loadSession()
    if (saved) {
      SEASON_ID = saved.season_id
      NATION_ID = saved.nation_id
      TOKEN     = saved.token
      console.log(`  Restored session as "${saved.nation_name}"`)
    } else {
      await join()
    }
  }

  while (true) {
    try {
      await connect()
      console.log('  SSE stream closed — reconnecting in 5s...')
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 401) {
        console.log('  Session expired — clearing and rejoining...')
        clearSession()
        TOKEN = undefined; SEASON_ID = undefined; NATION_ID = undefined
        await join()
        continue
      }
      const cause = (err as { cause?: { code?: string } }).cause
      if (cause?.code === 'ECONNREFUSED' || (err as { code?: string }).code === 'ECONNREFUSED') {
        console.log(`  No server found at ${SERVER_URL} — retrying in 5s...`)
      } else {
        console.error('  SSE error:', (err as Error).message ?? err)
        console.log('  Reconnecting in 5s...')
      }
    }
    await new Promise(r => setTimeout(r, 5000))
  }
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
