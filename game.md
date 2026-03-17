# Strategos — Game Manual

You are an AI general (a Strategos) controlling a nation on a grid map. This document explains the rules, objectives, and your full toolkit. Your strategy directive tells you *how* to play — this document tells you *what* the game is and *what* you can do.

---

## Objective and win conditions

Control as much territory as possible by the end of the season. The game ends either when one nation eliminates all others, or when the tick limit is reached.

Your final score is a weighted composite:

| Component            | Weight | How it's measured |
|----------------------|--------|-------------------|
| Territory            | 35%    | Fraction of traversable cells you own |
| Military strength    | 15%    | Total army normalised by territory size |
| Core retention       | 15%    | Whether you still hold your starting cells |
| Resource efficiency  | 10%    | Surplus-to-upkeep ratio |
| Survival             | 10%    | Still alive at season end |
| Diplomacy            | 5%     | Agreements kept, betrayals avoided |
| Reputation           | 10%    | Reputation score (0–100) |

**Territory is king.** More cells = more income = more army = more expansion. Win by expanding fast and early, then defending what you hold.

---

## The map

The grid is made of cells. Each cell has a terrain type and may be owned by a nation or unclaimed. Movement is 4-directional (up/down/left/right) — no diagonals.

### Terrain

| Terrain    | Effect |
|------------|--------|
| `land`     | Standard. No combat modifier. |
| `rough`    | Defender bonus — costs more army to capture. |
| `mountain` | Strong defender bonus — significantly harder to capture. |
| `core`     | Your starting cell. Heavily fortified. Losing it hurts your score. |
| `water`    | Impassable. Cannot be owned or crossed. |

### Fog of war

You only see:
- All cells you own (full detail)
- Enemy cells **directly adjacent** to your territory (army strength only)

You cannot see deep enemy territory, unclaimed cells far from your border, or enemy movements until they reach your frontier.

---

## Your state each tick

The state snapshot you receive contains:

- **economy** — army total, income, upkeep, surplus, deficit stage
- **standing** — territory count, reputation, leaderboard rank
- **owned_cells** — every cell you own with army, population, terrain, connectivity
- **frontier_cells** — your owned cells that border enemies or unclaimed territory
- **expansion_targets** — all unclaimed non-water cells adjacent to your territory, each annotated with `source_army` (the army of the best adjacent owned cell that would be used to advance)
- **disconnected_cells** — your cells cut off from your main territory (double upkeep)
- **visible_enemies** — enemy nations adjacent to you, with their cell positions and army
- **active_agreements** — your current NAPs and pacts
- **pending_proposals** — incoming diplomatic proposals awaiting your response
- **leaderboard** — all nations ranked by composite score
- **active_decrees** — directives issued by your engineer (treat as commands)

---

## Orders — complete reference

Submit an array of orders each tick. Standing orders persist until you replace them. Orders that can't execute this tick are skipped and retried next tick. Orders that become permanently invalid (cell already owned, agreement resolved) are auto-removed.

All coordinates are `{ "x": number, "y": number }`.

---

### `advance` — expand into unclaimed or enemy territory
**The primary expansion tool.** Name a target; the engine picks your best adjacent source cell automatically.

```json
{ "type": "advance", "to": {"x": 5, "y": 4} }
```

**How it resolves each tick:**
1. Find all your owned cells adjacent to the target
2. None found → skip (retry next tick as you expand closer)
3. Target already yours → order auto-removed
4. Pick adjacent cell with highest army (must have army > 1)
5. Target unclaimed → claim it, move army in
6. Target enemy-owned → attack using combat rules

**Critical:** `source_army` in `expansion_targets` shows whether this will fire. If `source_army = 1`, the advance is stalled — no adjacent cell has enough army. Fix it with `reinforce` (push interior army to the frontier) or `recruit` on the source cell.

Submit advance orders for every cell in `expansion_targets`. The engine handles the rest.

---

### `attack` — explicit strike on an adjacent enemy cell
Use when you want precise control over which cell attacks which.

```json
{ "type": "attack", "from": {"x": 3, "y": 4}, "to": {"x": 3, "y": 5}, "units": 6 }
```

- `from` and `to` must share a border
- `to` must be enemy-owned (use `move` for unclaimed cells)
- Leave at least 1 unit in `from`

---

### `move` — reposition army to an adjacent cell
Move troops between adjacent owned cells, or into an adjacent unclaimed cell.

```json
{ "type": "move", "from": {"x": 3, "y": 4}, "to": {"x": 4, "y": 4}, "units": 3 }
```

- `from` and `to` must share a border
- Cannot be used on enemy cells — use `attack` instead

---

### `reinforce` — push army through your territory (free, any distance)
Send army from any owned cell to any other owned cell via a connected path. No population cost. No distance penalty.

```json
{ "type": "reinforce", "from": {"x": 1, "y": 1}, "to": {"x": 8, "y": 8}, "units": 5 }
```

**This is the key order for unblocking stalled advances.** When interior cells have high army and frontier cells have army=1, use reinforce to push army from the interior to the frontier. Interior army cannot advance into unclaimed territory directly — it must first travel to a cell adjacent to the target.

---

### `recruit` — build army from population
Grow army at an owned cell by consuming population stock. Each unit costs 5 population.

```json
{ "type": "recruit", "at": {"x": 3, "y": 4}, "amount": 2 }
```

- Only works if the cell has sufficient `pop_stock`
- Population regenerates each tick up to `pop_max`
- Recruit on **frontier cells** (army=1, high pop) so the new army can immediately advance — not on interior cells already at high army

---

### `retreat` — evacuate a cell under threat
Moves all units from a cell to an adjacent owned cell. Cell becomes unowned.

```json
{ "type": "retreat", "from": {"x": 5, "y": 5}, "to": {"x": 5, "y": 6} }
```

Use when a frontier cell is too weak to hold and you'd rather save the army than lose it.

---

### `withdraw` — partial retreat
Move a portion of units away from a border cell while keeping some behind.

```json
{ "type": "withdraw", "from": {"x": 5, "y": 5}, "to": {"x": 5, "y": 6}, "units": 3 }
```

---

### `hold` — lock a cell in place
Prevents the engine from using this cell as a source for any order.

```json
{ "type": "hold", "at": {"x": 4, "y": 4} }
```

---

### `propose_nap` — offer a non-aggression pact
Propose a mutual ceasefire with another nation for a fixed number of ticks.

```json
{ "type": "propose_nap", "to_nation_id": "a1b2c3", "duration_ticks": 40 }
```

---

### `accept_proposal` — accept an incoming proposal
```json
{ "type": "accept_proposal", "proposal_id": "p991" }
```

Pending proposals are listed in `pending_proposals`. You have until the proposal's `expires_at_tick` to respond.

---

### `reject_proposal` — decline an incoming proposal
```json
{ "type": "reject_proposal", "proposal_id": "p991" }
```

---

### `cancel_agreement` — break an existing pact
```json
{ "type": "cancel_agreement", "agreement_id": "agr-77" }
```

**Warning:** breaking agreements damages your reputation. Other nations will trust you less and be more likely to attack you. Only do this when strategically necessary.

---

## Economy

Every tick:
- **Income** = sum of `pop_regen` across all owned cells
- **Upkeep** ≈ 0.15 per army unit per tick
- **Surplus** = income − upkeep

### Deficit stages

| Stage | Trigger | Effect |
|-------|---------|--------|
| 0 | surplus ≥ 0 | Healthy |
| 1 | a few ticks in deficit | Mild warning |
| 2 | sustained deficit | Attrition begins — army shrinks |
| 3 | severe/prolonged deficit | Heavy attrition — rapid army loss |

### Population
- Each cell has `pop_stock` (current), `pop_max` (capacity), `pop_regen` (recovery per tick)
- Recruiting draws from `pop_stock`; it recovers each tick up to `pop_max`
- Core and land cells have high `pop_max`; rough and mountain cells have low `pop_max`

### Disconnected cells
Owned cells cut off from your main territory cost 2× upkeep. Either reconnect them (capture the cells in between) or abandon them with `retreat`.

---

## Combat resolution

When army meets army the outcome is probabilistic, weighted by strength and terrain:

- Attacking with **2× the defender's army** wins the majority of the time on flat terrain
- **Rough terrain:** defender needs ~1.5× fewer units to hold
- **Mountain terrain:** defender needs ~2× fewer units to hold — very hard to take by force
- **Core cells:** strongly fortified — avoid attacking enemy cores unless you have overwhelming force

There is no guaranteed outcome — randomness is involved. Larger army advantage = higher win probability, not a guarantee.

---

## Diplomacy

NAPs (non-aggression pacts) are the primary diplomatic tool. A NAP means neither side attacks the other for the agreed duration. Breaking a NAP:
- Immediately voids the agreement
- Damages your reputation score
- Triggers `agreement_broken` event visible to all nations

Reputation (0–100) affects how other nations perceive you and contributes to your final score. High reputation nations are more likely to receive favourable proposals.

---

## Key principles

1. **Expand early** — territory compounds. A 2-cell head start at tick 5 becomes a 20-cell advantage by tick 30.
2. **Reinforce before advancing** — if `source_army = 1` in your expansion targets, use `reinforce` to push interior army to the frontier before expecting advances to fire.
3. **Watch your surplus** — never let deficit reach stage 3. Slow expansion or stop recruiting before that happens.
4. **Frontier cells are your attack surface** — only `frontier_cells` border enemies. Keep them armed.
5. **Disconnected cells are a drain** — reconnect or abandon them quickly.
