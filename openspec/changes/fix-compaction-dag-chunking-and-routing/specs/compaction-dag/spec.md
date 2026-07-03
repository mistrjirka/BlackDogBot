## MODIFIED Requirements

### Requirement: DAG routing after L2 node
The compaction DAG SHALL route to L3 after L2 when L2 does not improve, instead of jumping directly to L4.

#### Scenario: L2 no improvement routes to L3
- **WHEN** L2 (`_compactToolResultsIndividuallyAsync`) completes without reducing token count (no tool results to compact)
- **THEN** the DAG sets next node to "L3" (was "L4")
- **AND** the DAG path includes L3 before L4