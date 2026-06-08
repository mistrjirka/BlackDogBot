## ADDED Requirements

### Requirement: DAG attempts L3 batched summarization after L2 regardless of L2 improvement
The compaction DAG SHALL route to L3 (batched message summarization) after L2 (per-tool compaction) even when L2 does not improve the token count.

#### Scenario: L2 finds no tool results, DAG proceeds to L3
- **WHEN** L2 (`_compactToolResultsIndividuallyAsync`) processes messages with no tool results after the latest user message
- **THEN** L2 returns messages unchanged (no improvement)
- **AND** the DAG routes to L3 (`_compactBatchedMessagesAsync`) instead of jumping to L4
- **AND** L3 attempts batched summarization of conversation messages

#### Scenario: L3 improves token count, DAG continues to L1
- **WHEN** L3 successfully reduces token count through batched summarization
- **THEN** the DAG routes back to L1 (phase becomes "after_l3")
- **AND** L1 attempts further compaction on the reduced message set

#### Scenario: L3 does not improve, DAG falls through to L4
- **WHEN** L3 processes messages but cannot reduce token count below target
- **THEN** the DAG routes to L4 (aggressive batched summarization) as existing behavior
- **AND** the DAG path includes L3 before L4: ["L1", "L2", "L3", "L4"]