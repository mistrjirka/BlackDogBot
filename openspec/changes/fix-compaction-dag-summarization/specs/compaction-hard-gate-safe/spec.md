## ADDED Requirements

### Requirement: Zero truncation and zero cropping
The compaction DAG SHALL perform all compaction via LLM-based summarization. No content SHALL be truncated (string slicing) or cropped (message dropping). All DAG nodes (L1-L4) SHALL use LLM summarization.

#### Scenario: L1 uses chunked summarization, not truncation
- **WHEN** the prefix before the latest user message exceeds the hard gate budget
- **THEN** L1 splits the prefix into chunks and summarizes each chunk via LLM
- **AND** no content is truncated or dropped

#### Scenario: L3 uses per-message summarization, not truncation
- **WHEN** L3 is invoked and messages still exceed the target
- **THEN** L3 summarizes individual messages via LLM, starting with oldest
- **AND** no content is truncated via string slicing

#### Scenario: L4 uses aggressive summarization, not cropping
- **WHEN** L4 is invoked and messages still exceed the target
- **THEN** L4 summarizes individual messages via LLM with shorter budget
- **AND** no messages are dropped or cropped

### Requirement: No silent try-catch blocks
The `_summarizeTextAsync` function SHALL NOT swallow errors in a catch block. All errors SHALL propagate to the caller. The DAG SHALL handle propagated errors gracefully.

#### Scenario: Summarization error propagates to DAG
- **WHEN** `_summarizeTextAsync` throws any error (context-exceeded, network, model)
- **THEN** the error propagates to the DAG node execution
- **AND** the DAG catches it at the node level and treats it as "no improvement"
- **AND** the DAG advances to the next node

#### Scenario: DAG does not crash on summarization failure
- **WHEN** a DAG node throws an error during execution
- **THEN** the DAG logs a warning and continues to the next node
- **AND** message processing does not crash

### Requirement: Chunked prefix summarization fits hard gate
Each chunk in the L1 multi-pass summarization SHALL fit within the hard gate limit. The chunk size SHALL be chosen conservatively to account for JSON escaping overhead.

#### Scenario: Normal prefix splits into safe chunks
- **WHEN** the prefix is 55k tokens
- **THEN** it splits into 2 chunks of ~27.5k tokens each
- **AND** each chunk + instruction fits under the hard gate (93.5k for 110k window)

#### Scenario: Very large prefix splits into multiple chunks
- **WHEN** the prefix is 100k tokens
- **THEN** it splits into 4 chunks of ~25k tokens each
- **AND** each chunk fits under the hard gate
- **AND** the combining step also fits under the hard gate

### Requirement: Compaction reaches target percentage of context
The compaction DAG SHALL reduce message tokens to the target percentage of the context window (30% aggressive, 40% normal). The DAG SHALL iterate through nodes until the target is reached or all nodes are exhausted.

#### Scenario: Compaction reaches 30% target in aggressive mode
- **WHEN** aggressive compaction is triggered
- **THEN** the DAG targets 30% of context window (33k for 110k window)
- **AND** the DAG iterates through L1, L2, L3, L4 until target is reached

#### Scenario: Compaction reaches 40% target in normal mode
- **WHEN** normal compaction is triggered
- **THEN** the DAG targets 40% of context window (44k for 110k window)
- **AND** the DAG iterates through nodes until target is reached

### Requirement: DAG error handling does not hide unexpected errors
The DAG-level try/catch SHALL log all errors at warning level. Errors SHALL be visible in logs for debugging. The DAG SHALL not silently ignore errors.

#### Scenario: DAG logs node failures
- **WHEN** a DAG node throws an error
- **THEN** a warning is logged with the node name, phase, and error message
- **AND** the error is visible in the application logs

### Requirement: HARD_GATE_THRESHOLD_PERCENTAGE is defined once
The `HARD_GATE_THRESHOLD_PERCENTAGE` constant SHALL be defined exactly once in `src/shared/constants.ts` and imported by all consumers.

#### Scenario: Constant is shared across modules
- **WHEN** `base-agent.ts`, `ai-provider.service.ts`, or `summarization-compaction.ts` need `HARD_GATE_THRESHOLD_PERCENTAGE`
- **THEN** they import from `../shared/constants.js`
- **AND** no module defines its own copy of the constant
