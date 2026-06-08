## MODIFIED Requirements

### Requirement: L1 prefix chunk size threshold
The L1 Stage A chunked summarization SHALL use a dynamic chunk size threshold based on the context window, measured by prompt-based token estimation.

#### Scenario: Chunk size derived from context window
- **WHEN** `_compactPrefixBeforeLastUserAsync` splits unpinned prefix messages into chunks
- **THEN** the chunk size threshold SHALL be `contextWindow * 0.60` (60% of context window)
- **AND** this provides 25% headroom below the 85% hard gate threshold
- **AND** the token estimation uses `_messagesToPlainText()` to measure actual prompt tokens, not structured message tokens

#### Scenario: Default context window when not configured
- **WHEN** `options.contextWindow` is not provided
- **THEN** the system SHALL default to 128,000 tokens
- **AND** the chunk size threshold SHALL be 76,800 tokens (60% of 128,000)