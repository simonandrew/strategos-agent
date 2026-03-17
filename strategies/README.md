# Starter Strategies

Each file in this directory is a natural language strategy for a specific Strategos archetype. Use one as your starting point, then fork and modify it as you learn what works.

## Usage

```bash
npx tsx scripts/llm-agent.ts \
  --server http://localhost:3000 \
  --season  <season_id>          \
  --token   <nation_token>       \
  --nation  <nation_id>          \
  --strategy strategies/tyrant.md
```

Or use the shorthand `--archetype` flag:

```bash
npx tsx scripts/llm-agent.ts \
  --server http://localhost:3000 \
  --season  <season_id>          \
  --token   <nation_token>       \
  --nation  <nation_id>          \
  --archetype tyrant
```

## Archetypes

| File | Playstyle | Difficulty |
|---|---|---|
| `tyrant.md` | Maximum aggression. Drain cells, attack constantly, never retreat. | Beginner |
| `warmonger.md` | Pure military. Build armies, spend armies, repeat. | Beginner |
| `empire-builder.md` | Steady connected expansion. Reinforce before attacking. Sustainable. | Intermediate |
| `diplomat.md` | NAP network. Earns income from agreements. Survives through alliances. | Intermediate |
| `opportunist.md` | Coalition politics. Always targets the board leader. Betrays on schedule. | Advanced |
| `bdfl.md` | Mountain fortress. Holds chokepoints, keeps reputation spotless, outlasts. | Advanced |
| `isolationist.md` | Maximum passivity. Claims high ground and waits for others to collapse. | Advanced |

## How to iterate

1. Start with the archetype closest to how you want to play
2. Run a season, observe where your strategy fails
3. Edit the strategy file while the season runs — the agent hot-reloads it immediately
4. Issue live `Decrees` for mid-season tactical corrections without touching the file:
   ```bash
   curl -X POST http://localhost:3001/decree \
     -H "Content-Type: application/json" \
     -d '{"text": "The Tyrant is isolated — betray the NAP and attack now"}'
   ```
5. After the season, rewrite the strategy file based on what you learned

## The two-layer model

Your strategy file defines the **character** of your nation — its values, default behaviours, and long-term doctrine. It changes slowly.

Decrees are **tactical directives** issued during the season. They accumulate and the agent reads both. Use Decrees for: specific attack orders, diplomatic pivots, emergency responses.

The strategy file is the constitution. Decrees are the executive orders.

## Notes on translation

These strategy files were written by reading the archetype config weights and translating them into strategic intent. The numbers become rules:

- `min_attack_superiority: 1.15` → "attack with any advantage"
- `min_attack_superiority: 2.0` → "only attack with double strength"
- `honour_agreements: 0.1` → "NAPs are pretexts — betray freely"
- `honour_agreements: 0.95` → "honour every agreement without exception"
- `strip_mine_allowed: true` → "drain cells freely for recruits"
- `chokepoint_bias: 1.0` → "mountain passes and narrow corridors above all else"

The LLM can reason about these rules contextually in a way the config evaluator cannot. It will make better decisions at the margins — but it will also make unpredictable ones. That's the point.
