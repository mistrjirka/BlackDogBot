## ADDED Requirements

### Requirement: L1 chunked summarization requests stay within hard gate limits
The compaction DAG SHALL ensure that L1 Stage A chunked summarization requests stay within the hard gate token limit (85% of context window) by using prompt-based token estimation for chunking decisions.

#### Scenario: Large prefix triggers chunked summarization with safe chunk size
- **WHEN** the unpinned prefix messages exceed the target token count and require chunked summarization
- **THEN** the system estimates actual prompt tokens using `_messagesToPlainText()` + instruction template
- **AND** splits the prefix into chunks where each chunk's estimated prompt tokens ≤ `contextWindow * 0.60`
- **AND** the chunking uses a plain text token counter to avoid overcounting instruction template overhead

#### Scenario: Chunking uses plain text token counter for boundary decisions
- **WHEN** `_splitMessagesIntoChunks` is called for prefix chunking
- **THEN** the token counter SHALL measure plain text tokens (without instruction template)
- **AND** this avoids overcounting by including the instruction template N times for N messages
- **AND** the initial "fits in one chunk" check uses the full prompt token counter (with template)

#### Scenario: Chunked summarization completes without hard gate rejection
- **WHEN** L1 Stage A processes a large prefix using chunked summarization
- **THEN** no hard gate rejection occurs during chunk summarization or combine step
- **AND** the DAG logs "L1 chunked prefix summarization" with chunk count and sizes