# Code-to-Doc Extraction System: Executable Specification

## 1. Overview

This specification defines a complete implementation with zero ambiguity.

## 2. Directory Structure

Create these directories exactly:
```
scripts/doc-extraction/           (mode: 755)
scripts/doc-extraction/extractors/ (mode: 755)
scripts/doc-extraction/generators/ (mode: 755)
scripts/doc-extraction/templates/  (mode: 755)
scripts/doc-extraction/validators/ (mode: 755)
docs/_generated/                   (mode: 755)
docs/_generated/.backups/          (mode: 755)
```

## 3. Dependencies

Add to package.json devDependencies:
- `@ts-morph/ts-morph`: ^24.0.0
- `@iarna/toml`: ^2.2.5

Then run: npm install

## 4. Core Implementation Files

### 4.1 types.ts - Type Definitions

Key interfaces:
- ExtractableConstant: name, value, sourceFile, line, description, category, since
- DocFragment: id, title, content, sources, targetFiles, generatedAt, contentHash
- TemplateConfig: id, name, sourceFiles, constantNames, outputFragmentId, generator, injectInto, injectionMarker
- ExtractionResult: extracted, unevaluated, errors, timestamp
- ValidationResult: isValid, staleFragments, missingFragments, injectionFailures, inconsistencies

### 4.2 config.ts - Central Configuration

Define PROJECT_ROOT as path.resolve(__dirname, '..', '..')
Define GENERATED_DIR as path.join(PROJECT_ROOT, 'docs', '_generated')
Define 8 template configurations for Phase 1 and 2

### 4.3 TypeScript Extractor (extractors/typescript-ast.ts)

Class TypeScriptExtractor with methods:
- constructor(projectRoot: string)
- extractConstants(filePath, constantNames): Promise<ExtractionResult>
- processDeclaration(decl, filePath): ExtractableConstant | null
- evaluateExpression(node): { value, isComputed }
- inferCategory(name): category string

Supported expression types:
- Numeric literals
- String literals
- Boolean literals
- Null literal
- Array literals
- Object literals (PropertyAssignment only)
- Binary expressions (+, -, *, /, **)
- Unary expressions (-, +, !)
- As expressions (type assertions)
- Parenthesized expressions

### 4.4 TOML Extractor (extractors/toml-parser.ts)

Function extractFromWranglerToml(filePath):
- Parse wrangler.toml
- Extract CRON_SCHEDULES
- Extract individual CRON_XX entries
- Extract D1_DATABASES
- Extract VAR_* entries

## 5. Template Generators (Phase 1)

### 5.1 Safety Score (templates/safety-score.ts)

Input constants: DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT, NO_LIQUIDITY_PENALTY, SAFETY_SCORE_VERSION

Output format:
- HTML comment header with generation timestamp
- Dimension Weights table (Dimension, Weight, Description)
- Grade Thresholds table (Grade, Score Range, Description)
- Peg Stability Multiplier section with formula
- No-Liquidity-Data Penalty section
- Methodology Version section (if version present)

### 5.2 Depeg Thresholds (templates/depeg-thresholds.ts)

Input constants: All DEPEG_* constants from worker/src/lib/constants.ts

Output format:
- HTML comment header
- Thresholds table (Parameter, Value, Description)
- Threshold Rationale section explaining USD vs non-USD, major coin confirmation, extreme moves

### 5.3 Cron Schedules (templates/cron-schedules.ts)

Input: CRON_SCHEDULES array from wrangler.toml

Output format:
- Schedules table (Schedule, Frequency, Jobs)
- Schedule Details section with individual job lists
- Total count summary

## 6. Template Generators (Phase 2)

### 6.1 API Rate Limits (templates/api-limits.ts)

Input: PUBLIC_API_RATE_LIMIT, FEEDBACK_RATE_LIMIT_* constants
Output: Rate limits table and implementation details

### 6.2 Circuit Breaker (templates/circuit-breaker.ts)

Input: CIRCUIT_OPEN_THRESHOLD, CIRCUIT_PROBE_INTERVAL_SEC
Output: Configuration table and behavior description

### 6.3 D1 Tables (templates/d1-tables.ts)

Input: SQL migration files from worker/migrations/
Output: Tables overview list and detailed table documentation

### 6.4 Liquidity Score (templates/liquidity-score.ts)

Input: TVL_DEPTH_WEIGHT, VOLUME_ACTIVITY_WEIGHT, POOL_QUALITY_WEIGHT, DURABILITY_WEIGHT, PAIR_DIVERSITY_WEIGHT
Output: Component weights table and detailed descriptions

### 6.5 DEWS Thresholds (templates/dews-thresholds.ts)

Input: DEWS_BAND_* constants
Output: Threat bands table with color indicators and semantic descriptions

## 7. Injection System

File: inject-fragments.ts

Function injectFragment(config: InjectionConfig):
1. Read target file
2. Read fragment file
3. Find injection marker
4. Replace content between marker and end marker
5. Write back to target file

Marker format: <!-- AUTO-GENERATED-CONSTANTS: FRAGMENT_ID -->
End marker format: <!-- END AUTO-GENERATED-CONSTANTS: FRAGMENT_ID -->

## 8. CLI Entry Point

File: index.ts

Parse CLI args:
- --check: validation mode
- --force: force regeneration
- --template=<id>: single template mode
- --verbose: verbose logging

Main workflow:
1. Load configuration
2. If check mode: run validation and exit
3. Otherwise: generate all fragments
4. Inject fragments into target files
5. Write content hashes

## 9. Validation System

File: validators/freshness.ts

Function validateDocs(): ValidationResult

Checks:
- All expected fragment files exist
- Content hashes match
- Injection markers present in target files
- No cross-document inconsistencies

## 10. Package.json Scripts

Add:
- "docs:extract": "tsx scripts/doc-extraction/index.ts"
- "docs:extract:check": "tsx scripts/doc-extraction/index.ts --check"
- "docs:validate": "npm run docs:extract:check"

## 11. CI Integration

File: .github/workflows/validate-docs.yml

Triggers:
- push to paths: shared/lib/**, worker/src/lib/**, worker/wrangler.toml, worker/migrations/*.sql, docs/**
- pull_request to same paths

Steps:
1. Checkout code
2. Setup Node 20
3. npm ci
4. npm run docs:validate
5. Check for uncommitted changes in docs/_generated/

## 12. Migration Strategy

Phase 0 (Setup):
1. Create directory structure
2. Install dependencies
3. Create all source files
4. Run first extraction

Phase 1 (Safety Score):
1. Add injection marker to methodology sections
2. Generate and review PARTIAL_SAFETY_SCORE.md
3. Inject into targets
4. Verify visually

Phase 2 (Depeg Thresholds):
1. Add marker to depeg-detection.md
2. Generate PARTIAL_DEPEG_THRESHOLDS.md
3. Inject and verify

Phase 3 (Cron Schedules):
1. Add markers to README, architecture, worker-infrastructure
2. Generate PARTIAL_CRON_SCHEDULES.md
3. Inject to all three files

Phase 4 (Phase 2 Templates):
1. Implement remaining 5 generators
2. Add markers to target files
3. Generate and inject all
4. Full validation

Phase 5 (Enforcement):
1. Enable CI workflow
2. Add docs:extract to prebuild script
3. Document workflow for developers

## 13. Testing Checklist

Per-template tests:
- [ ] Extractor finds expected constants
- [ ] Generator produces valid markdown
- [ ] Content includes HTML comment header
- [ ] Injection places content correctly
- [ ] Validation passes after injection
- [ ] Target file renders correctly in markdown viewer

Integration tests:
- [ ] Full extraction runs without errors
- [ ] All 8 fragments generated
- [ ] All injections successful
- [ ] Validation passes
- [ ] CI check passes
- [ ] Regeneration produces identical output (idempotent)

Edge cases:
- [ ] Constant not found: logged as unevaluated, not error
- [ ] Expression too complex: logged as unevaluated
- [ ] Missing injection marker: logged as injection failure
- [ ] File read error: captured in result.errors

## 14. Success Criteria

Quantitative:
- Zero count drift incidents per quarter
- 100% of GRADE_THRESHOLDS changes reflected in docs within 1 build
- CI validation passes on every PR

Qualitative:
- Developers trust documentation accuracy
- No manual updates needed for constant changes
- Review comments about doc/constant mismatches eliminated
