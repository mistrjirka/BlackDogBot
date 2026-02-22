# Pattern: Orphaned Configuration

## Definition

**Orphaned Configuration** occurs when configuration, schema, or data is:
1. **Accepted as input** (required or optional parameter)
2. **Stored somewhere** (in memory, file, database)
3. **Referenced in comments or strings** (e.g., "matching the expected schema")
4. **But NEVER actually used** in the execution path

This is a **silent bug** - the system appears to work, but the configuration has no effect.

## Detection Heuristics

### Pattern 1: The "Mentioned but Missing" Bug
```typescript
// BAD: Schema is mentioned but never injected
const instructions = `Output must match the expected schema. Call done() when finished.`;
// The schema exists in `config.outputSchema` but is never shown to the LLM!
```

### Pattern 2: The "Stored but Ignored" Bug
```typescript
// BAD: Config is saved but never read during execution
async function saveConfig(config: Config) {
  await fs.writeFile('config.json', JSON.stringify(config));
}

async function execute() {
  // Bug: Uses hardcoded defaults instead of reading saved config!
  const timeout = 30000; // Should read from config
}
```

### Pattern 3: The "Parameter Passed Through" Bug
```typescript
// BAD: Parameter accepted but not forwarded
async function createNode(options: { name: string, timeout?: number }) {
  return { name: options.name }; // timeout is lost!
}
```

### Pattern 4: The "Validated but Not Used" Bug
```typescript
// BAD: Schema validated but output not checked against it
const schema = z.object({ count: z.number() });
const parsed = schema.parse(input); // Validated...
return { success: true }; // ...but parsed data never used!
```

## Known Instances in This Codebase

### Fixed: Agent Node Output Schema
- **File**: `src/services/job-executor.service.ts`
- **Bug**: `outputSchema` was stored in the node but never injected into agent instructions
- **Fix**: Added `outputSchemaInstructions` that includes the schema in the prompt

### Fixed: Litesql Node Output Schema
- **File**: `src/tools/add-litesql-node.tool.ts`
- **Bug**: `outputSchema` was required but the actual output is always `{ insertedCount, lastRowId }`
- **Fix**: Made `outputSchema` optional with a sensible default

### Fixed: Test Case Updates
- **File**: `src/services/job-storage.service.ts`
- **Bug**: `addTestCaseAsync` appended tests instead of replacing by name
- **Fix**: Check for existing test with same name and replace

## Search Patterns

Use these grep patterns to find potential orphaned configs:

```bash
# Find parameters that might be ignored
grep -rn "\.describe\(" src/ | grep -i "schema\|config\|option"

# Find places where config is read but might not be used
grep -rn "config\." src/ | grep -v "test\|spec"

# Find "expected" or "should" in strings that might indicate missing injection
grep -rn "expected\|should match\|must match" src/ --include="*.ts"

# Find parameters that are destructured but might not be used
grep -rn "= async ({\|execute: async {" src/ -A 10
```

## Prevention Checklist

When adding a new configuration option:

- [ ] Is the parameter actually used in the execution path?
- [ ] Is it passed to all functions that need it?
- [ ] Is it included in any generated prompts/instructions?
- [ ] Does the test verify the config has an effect?
- [ ] Is there a default that makes sense if not provided?

## Related Patterns

- **Dead Code**: Code that is never executed
- **Zombie Config**: Config keys that are loaded but no code references them
- **Phantom Validation**: Validation that passes but results are discarded
