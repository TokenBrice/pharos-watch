# Code-to-Doc Extraction System: Complete Executable Specification

## Section 1: File System Layout

Create exactly these directories:
```
scripts/doc-extraction/
scripts/doc-extraction/extractors/
scripts/doc-extraction/generators/
scripts/doc-extraction/templates/
scripts/doc-extraction/validators/
docs/_generated/
docs/_generated/.backups/
```

## Section 2: Package Dependencies

Add to package.json devDependencies section:
```json
"@ts-morph/ts-morph": "^24.0.0",
"@iarna/toml": "^2.2.5"
```

Run: npm install

## Section 3: Source Files

### 3.1 types.ts
```typescript
export interface ExtractableConstant {
  name: string;
  value: unknown;
  sourceFile: string;
  line: number;
  description?: string;
  category: 'scoring' | 'thresholds' | 'schedules' | 'limits' | 'schema';
  since?: string;
  isComputed?: boolean;
}

export interface DocFragment {
  id: string;
  title: string;
  content: string;
  sources: ReadonlyArray<ExtractableConstant>;
  targetFiles: ReadonlyArray<string>;
  generatedAt: string;
  contentHash: string;
}

export interface TemplateConfig {
  id: string;
  name: string;
  sourceFiles: ReadonlyArray<string>;
  constantNames: ReadonlyArray<string>;
  outputFragmentId: string;
  generator: string;
  injectInto: ReadonlyArray<string>;
  injectionMarker: string;
}
```

### 3.2 config.ts
PROJECT_ROOT = path.resolve(__dirname, '..', '..')
GENERATED_DIR = path.join(PROJECT_ROOT, 'docs', '_generated')
HASH_FILE = path.join(GENERATED_DIR, '.content-hashes.json')

Templates array with 8 configurations for:
1. safety-score-weights
2. depeg-thresholds
3. cron-schedules
4. api-rate-limits
5. circuit-breaker
6. d1-tables
7. liquidity-score-weights
8. dews-thresholds

### 3.3 extractors/typescript-ast.ts

Class TypeScriptExtractor
Constructor takes projectRoot: string
Method extractConstants(filePath, constantNames): ExtractionResult
Method evaluateExpression(node): { value, isComputed }

Supported syntax:
- Numeric literals
- String literals
- Boolean literals
- Null literal
- Array literals
- Object literals
- Binary expressions: +, -, *, /, **
- Unary expressions: -, +, !
- As expressions (type assertions)
- Parenthesized expressions

Not supported (throws error):
- Property access (enum members)
- Identifier references
- Template literals with expressions
- Spread operators
- Shorthand properties

### 3.4 extractors/toml-parser.ts

Function extractFromWranglerToml(filePath)
Returns ExtractableConstant[]

Extracts:
- CRON_SCHEDULES array
- Individual CRON_XX entries
- D1_DATABASES array
- VAR_* entries

### 3.5 templates/safety-score.ts

Input: DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT, NO_LIQUIDITY_PENALTY, SAFETY_SCORE_VERSION

Output markdown structure:
1. HTML comment with generation metadata
2. Dimension Weights section with table
3. Grade Thresholds section with table
4. Peg Stability Multiplier section with formula
5. No-Liquidity-Data Penalty section
6. Methodology Version section (conditional)

### 3.6 templates/depeg-thresholds.ts

Input: All 7 DEPEG_* constants

Output:
1. HTML comment header
2. Thresholds parameter table
3. Threshold Rationale explanation section

### 3.7 templates/cron-schedules.ts

Input: CRON_SCHEDULES from wrangler.toml

Output:
1. HTML comment header
2. Schedule overview table (Schedule, Frequency, Jobs)
3. Per-schedule detail sections
4. Total count summary

### 3.8 templates/api-limits.ts, circuit-breaker.ts, d1-tables.ts, liquidity-score.ts, dews-thresholds.ts

Each follows same pattern:
- Parse specific constants
- Generate markdown tables
- Include implementation details
- Add HTML comment header

## Section 4: Injection System

File: inject-fragments.ts

Function injectFragment(config):
1. Read target file content
2. Find injection marker: <!-- AUTO-GENERATED-CONSTANTS: ID -->
3. Find end marker: <!-- END AUTO-GENERATED-CONSTANTS: ID -->
4. If markers not found, log warning and return
5. Construct new content: before + fragment + after
6. Write back to file
7. Log success

## Section 5: CLI Entry Point

File: index.ts

Argument parsing:
- --check: run validation, exit 0 if valid, 1 if not
- --force: regenerate even if hashes match
- --template=<id>: process single template only
- --verbose: extra logging

Main function workflow:
1. Parse CLI args
2. Load templates from config
3. If check mode: validate and exit
4. Create backup directory if not exists
5. For each template:
   a. Extract constants from source files
   b. Call generator function
   c. Write fragment to docs/_generated/
   d. Calculate content hash
   e. Inject into target files
6. Write hash file
7. Log completion summary

## Section 6: Validation System

File: validators/freshness.ts

Function validateDocs(): ValidationResult

Steps:
1. Read expected hashes from HASH_FILE
2. For each expected fragment:
   a. Check file exists
   b. Calculate actual hash
   c. Compare to expected
3. Check all injection markers present in targets
4. Check for value inconsistencies across files
5. Return ValidationResult

## Section 7: Package Scripts

Add to package.json scripts:
```json
{
  "docs:extract": "tsx scripts/doc-extraction/index.ts",
  "docs:extract:check": "tsx scripts/doc-extraction/index.ts --check",
  "docs:validate": "npm run docs:extract:check",
  "prebuild": "npm run docs:extract && tsx scripts/generate-redirects.ts"
}
```

## Section 8: CI Workflow

File: .github/workflows/validate-docs.yml

Triggers:
- push:
    paths:
      - 'shared/lib/**/*.ts'
      - 'worker/src/lib/**/*.ts'
      - 'worker/wrangler.toml'
      - 'worker/migrations/*.sql'
      - 'docs/**/*.md'
- pull_request:
    paths: [same as above]

Jobs:
1. Checkout
2. Setup Node 20
3. npm ci
4. npm run docs:validate
5. Check git status for uncommitted changes in docs/_generated/
6. Fail if changes detected

## Section 9: Migration Steps

Step 1: Infrastructure
- Create all directories
- Add dependencies
- Create types.ts, config.ts

Step 2: Extractors
- Implement TypeScriptExtractor
- Implement TOML extractor
- Write unit tests

Step 3: Phase 1 Generators
- Implement safety-score.ts
- Implement depeg-thresholds.ts
- Implement cron-schedules.ts
- Test each generator

Step 4: Phase 1 Integration
- Add injection markers to target files
- Run extraction
- Verify output
- Commit generated files

Step 5: Phase 2 Generators
- Implement remaining 5 generators
- Test each

Step 6: Phase 2 Integration
- Add injection markers
- Run extraction
- Verify
- Commit

Step 7: Validation & CI
- Implement validators
- Create CI workflow
- Test CI locally
- Enable in GitHub

Step 8: Documentation
- Write developer guide
- Document workflow
- Train team

## Section 10: Testing

Per-template test:
1. Extractor finds correct constants from source
2. Generator produces valid markdown
3. Output contains HTML comment header
4. Content hash is stable
5. Injection places content at correct location

Integration test:
1. Full extraction completes without errors
2. All 8 fragments exist
3. All injections successful
4. Validation passes
5. Regeneration is idempotent

Error handling test:
1. Missing constant -> logs unevaluated, continues
2. Complex expression -> logs unevaluated, continues
3. Missing marker -> logs injection failure, continues
4. File not found -> logs error, continues

## Section 11: Success Metrics

Before system:
- 3-5 count drift incidents per quarter
- 1-2 day lag for doc updates
- 2-3 PR comments per PR about mismatches

After system:
- 0 count drift incidents
- Instant propagation (next build)
- 0 mismatch comments
- 100% CI pass rate on doc validation

