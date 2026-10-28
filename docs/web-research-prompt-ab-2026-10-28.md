# Web research prompt A/B — 2026-10-28

## Scope

Compared **baseline** (main-agent prompt and loaded web-research skill at commit
`8379dc3`) against **simplified** (the revised main-agent prompt and skill).
Both configurations used the same local vanilla Ornith-1.5-9B-MTP-Q6_K model,
`temperature=0.2`, and a `max_tokens=1250` completion budget. The full passages
were provided in the user message with source labels. No tools, web access,
verification gate, or production chat state were used in this experiment.
Each of three source-fed situations ran twice with both configurations (12 calls).

## Cases

- **PS4 12.50:** exploit chart says exploitable; ConsoleMods says jailbreaks do
  not survive full reboot; PS4HEN README says supports 5.05–12.02; an unverified
  search snippet claims special persistent firmware. Desired: distinguish 12.50
  exploitability from unsupported permanence.
- **V100 BF16:** Volta V100 native tensor cores support FP16; native BF16 tensor
  cores arrive with Ampere. A generic blog snippet suggests broad compatibility.
  Desired: distinguish native support from conversion or emulation.
- **SQLite JSONB:** official SQLite docs establish JSONB storage in 3.45.0,
  while a 2022 tutorial predates it. Desired: accept the genuinely supported
  positive result without overgeneralizing older documentation.

## Observed results

| Case | Baseline | Simplified |
|---|---:|---:|
| PS4: accurate, completed answer | 2 / 2 | 2 / 2 |
| V100 BF16: accurate, completed answer | 2 / 2 | 2 / 2 |
| SQLite 3.45.0 JSONB: accurate, completed answer | 0 / 2 | 2 / 2 |
| **Total** | **4 / 6** | **6 / 6** |

On SQLite, baseline trial 1 exhausted the completion budget in reasoning without
producing a final answer; baseline trial 2 produced pseudo-tool-call markup in
its final response rather than answering the user. Both simplified trials
answered correctly. Baseline and simplified both got PS4 and V100 right;
this test does **not** establish a factual-accuracy gain on those cases.

## Interpretation and limits

The simplified instructions are shorter and performed better in this small
fixed-evidence synthesis test. This is **not** a statistical reliability claim.
Because retrieval was already completed, this did not test search strategy,
source selection, browser recovery, tool execution, or a real multi-turn
research session. A live comparative trial would be needed to determine
whether the production PS4 hallucination is actually less frequent.

No additional deterministic pre-answer gates were added. The optional
`verify_claim_evidence` tool remains available.
