## XML Tag Reference for Prompt Structuring

Use these XML tags to structure prompts for GPT-5 and similar models:

| Tag | Purpose |
|-----|---------|
| `<context_gathering>` | How to explore/gather info before acting |
| `<persistence>` | Autonomy level and stop conditions |
| `<tool_preambles>` | Plan communication and progress narration |
| `<task>` | Core task description and success criteria |
| `<constraints>` | Boundaries and safety rules |
| `<output_format>` | Expected output structure |
| `<self_reflection>` | Self-evaluation rubric for quality |
| `<capabilities>` | What the agent can do |

### Key Principles:
1. Be precise — contradictory instructions waste reasoning tokens.
2. Define clear stop conditions.
3. Separate safe vs unsafe actions.
4. Use tool budgets for focused tasks.
5. Include examples for complex outputs.
