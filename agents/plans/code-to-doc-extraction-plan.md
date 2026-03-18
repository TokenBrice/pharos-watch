# Code-to-Doc Extraction System: Implementation Plan

## Overview

A system to auto-generate documentation fragments from TypeScript source constants, ensuring documentation always matches implementation. This eliminates manual drift in counts, formulas, thresholds, and configurations.

---

## Phase 0: Foundation (Base Setup)

### 0.1 Project Structure

```
scripts/
├── doc-extraction/
│   ├── index.ts                 # Main orchestrator
│   ├── extractors/
│   │   ├── typescript-ast.ts    # AST-based constant extraction
│   │   ├── module-import.ts     # Direct module import fallback
│   │   └── toml-parser.ts       # wrangler.toml extraction
│   ├── generators/
│   │   ├── markdown-table.ts    # Table formatting utilities
│   │   ├── markdown-list.ts     # List formatting utilities
│   │   └── inline-value.ts      # Inline value formatting
│   ├── templates/
│   │   ├── safety-score.ts      # Safety score doc generator
│   │   ├── depeg-detection.ts   # Depeg threshold generator
│   │   ├── cron-schedules.ts    # Cron schedule generator
│   │   ├── api-limits.ts        # Rate limit generator
│   │   ├── d1-schema.ts         # D1 tables generator
│   │   └── methodology-versions.ts # Version cross-reference
│   ├── validators/
│   │   ├── consistency-check.ts # Cross-doc consistency validation
│   │   └── freshness-check.ts   # Check if generated docs are stale
│   └── types.ts                 # Shared type definitions
docs/
├── _generated/                  # Auto-generated fragments (git-tracked)
│   ├── PARTIAL-SAFETY-SCORE.md
│   ├── PARTIAL-DEPEG-THRESHOLDS.md
│   ├── PARTIAL-CRON-SCHEDULES.md
│   ├── PARTIAL-API-LIMITS.md
│   ├── PARTIAL-D1-TABLES.md
│   └── README.md                # Index of all generated fragments
├── _templates/                  # Include templates for injection
│   ├── methodology-sections-safety-score.md
│   └── api-reference-rate-limits.md
└── README.md                    # Master index
```

### 0.2 Dependencies

```bash
npm install --save-dev @ts-morph/ts-morph toml
```

- `@ts-morph/ts-morph`: TypeScript AST manipulation (more robust than raw TS compiler API)
- `toml`: Parse wrangler.toml for cron schedules and env bindings

### 0.3 Core Infrastructure Files

#### 0.3.1 Type Definitions (`scripts/doc-extraction/types.ts`)

```typescript
/**
 * Represents a single extractable constant from source code
 */
export interface ExtractableConstant {
  /** Fully qualified name (e.g., "DIMENSION_WEIGHTS.liquidity") */
  name: string;
  
  /** The actual value */
  value: unknown;
  
  /** Source file path relative to project root */
  sourceFile: string;
  
  /** Line number in source file */
  line: number;
  
  /** JSDoc comment if present */
  description?: string;
  
  /** Category for grouping */
  category: 'scoring' | 'thresholds' | 'schedules' | 'limits' | 'schema';
  
  /** Version this constant was introduced */
  since?: string;
  
  /** Whether this is a derived/computed value */
  isComputed?: boolean;
}

/**
 * A generated documentation fragment
 */
export interface DocFragment {
  /** Fragment identifier (PascalCase, no spaces) */
  id: string;
  
  /** Human-readable title */
  title: string;
  
  /** The generated markdown content */
  content: string;
  
  /** Source constants that feed into this fragment */
  sources: ExtractableConstant[];
  
  /** Files that should include this fragment */
  targetFiles: string[];
  
  /** Generation timestamp */
  generatedAt: string;
  
  /** Content hash for freshness checking */
  contentHash: string;
}

/**
 * Configuration for a documentation template
 */
export interface TemplateConfig {
  /** Unique template identifier */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Source files to extract from */
  sourceFiles: string[];
  
  /** Specific constants to extract (if empty, extract all exported) */
  constantNames?: string[];
  
  /** Output fragment ID */
  outputFragmentId: string;
  
  /** Generator function name */
  generator: string;
  
  /** Target documentation files */
  injectInto: string[];
  
  /** Injection marker in target files */
  injectionMarker: string;
}

/**
 * Extraction result with metadata
 */
export interface ExtractionResult {
  /** Successfully extracted constants */
  extracted: ExtractableConstant[];
  
  /** Constants that couldn't be evaluated */
  unevaluated: Array<{ name: string; reason: string }>;
  
  /** Errors during extraction */
  errors: Array<{ file: string; error: string }>;
  
  /** Timestamp of extraction */
  timestamp: string;
}

/**
 * Validation result for CI checks
 */
export interface ValidationResult {
  /** Whether all docs are up-to-date */
  isValid: boolean;
  
  /** Outdated fragments */
  staleFragments: Array<{
    fragmentId: string;
    expectedHash: string;
    actualHash: string;
  }>;
  
  /** Missing fragments */
  missingFragments: string[];
  
  /** Files with failed injections */
  injectionFailures: Array<{
    file: string;
    marker: string;
    reason: string;
  }>;
  
  /** Cross-document inconsistencies */
  inconsistencies: Array<{
    constant: string;
    foundIn: Array<{ file: string; value: unknown }>;
  }>;
}
```

#### 0.3.2 Main Orchestrator (`scripts/doc-extraction/index.ts`)

```typescript
#!/usr/bin/env tsx
/**
 * Documentation Extraction System
 * 
 * Usage:
 *   npm run docs:extract       # Generate all fragments and inject
 *   npm run docs:extract --check  # Validate docs are up-to-date (CI mode)
 *   npm run docs:extract --force  # Regenerate even if unchanged
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Project, SourceFile } from 'ts-morph';
import { parse } from 'toml';
import type { 
  ExtractableConstant, 
  DocFragment, 
  TemplateConfig,
  ExtractionResult,
  ValidationResult 
} from './types';

// Configuration
const CONFIG = {
  projectRoot: process.cwd(),
  generatedDir: 'docs/_generated',
  templatesDir: 'scripts/doc-extraction/templates',
  backupDir: 'docs/_generated/.backups',
  hashFile: 'docs/_generated/.content-hashes.json',
  encoding: 'utf-8' as const,
};

// Template registry - Phase 1 & 2
const TEMPLATES: TemplateConfig[] = [
  // Phase 1: High ROI
  {
    id: 'safety-score-weights',
    name: 'Safety Score Weights & Thresholds',
    sourceFiles: ['shared/lib/report-cards.ts'],
    constantNames: [
      'DIMENSION_WEIGHTS',
      'GRADE_THRESHOLDS', 
      'PEG_MULTIPLIER_EXPONENT',
      'NO_LIQUIDITY_PENALTY',
      'SAFETY_SCORE_VERSION'
    ],
    outputFragmentId: 'PARTIAL-SAFETY-SCORE',
    generator: 'generateSafetyScoreDoc',
    injectInto: [
      'docs/methodology-page.md',
      'src/app/methodology/methodology-sections.tsx'
    ],
    injectionMarker: '<!-- AUTO-GENERATED: SAFETY_SCORE_CONSTANTS -->'
  },
  {
    id: 'depeg-thresholds',
    name: 'Depeg Detection Thresholds',
    sourceFiles: ['worker/src/lib/constants.ts'],
    constantNames: [
      'DEPEG_THRESHOLD_BPS',
      'DEPEG_THRESHOLD_BPS_NON_USD',
      'DEPEG_CONFIRMATION_SUPPLY_THRESHOLD',
      'DEPEG_PENDING_MIN_AGE_SEC',
      'DEPEG_PENDING_EXPIRY_SEC',
      'DEPEG_SECONDARY_THRESHOLD_RATIO',
      'DEPEG_EXTREME_MOVE_BPS'
    ],
    outputFragmentId: 'PARTIAL-DEPEG-THRESHOLDS',
    generator: 'generateDepegThresholdsDoc',
    injectInto: ['docs/depeg-detection.md'],
    injectionMarker: '<!-- AUTO-GENERATED: DEPEG_THRESHOLDS -->'
  },
  {
    id: 'cron-schedules',
    name: 'Cron Job Schedules',
    sourceFiles: [
      'worker/wrangler.toml',
      'shared/lib/cron-jobs.ts'
    ],
    outputFragmentId: 'PARTIAL-CRON-SCHEDULES',
    generator: 'generateCronSchedulesDoc',
    injectInto: [
      'README.md',
      'docs/architecture.md',
      'docs/worker-infrastructure.md'
    ],
    injectionMarker: '<!-- AUTO-GENERATED: CRON_SCHEDULES -->'
  },
  
  // Phase 2: Medium ROI
  {
    id: 'api-rate-limits',
    name: 'API Rate Limits',
    sourceFiles: [
      'worker/src/handlers/http.ts',
      'worker/src/api/feedback.ts'
    ],
    constantNames: [
      'PUBLIC_API_RATE_LIMIT',
      'FEEDBACK_RATE_LIMIT_WINDOW_SEC',
      'FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS'
    ],
    outputFragmentId: 'PARTIAL-API-LIMITS',
    generator: 'generateApiLimitsDoc',
    injectInto: [
      'docs/api-reference.md',
      'docs/worker-and-api-limits.md'
    ],
    injectionMarker: '<!-- AUTO-GENERATED: API_LIMITS -->'
  },
  {
    id: 'circuit-breaker-config',
    name: 'Circuit Breaker Configuration',
    sourceFiles: ['worker/src/lib/circuit-breaker.ts'],
    constantNames: [
      'CIRCUIT_OPEN_THRESHOLD',
      'CIRCUIT_PROBE_INTERVAL_SEC'
    ],
    outputFragmentId: 'PARTIAL-CIRCUIT-BREAKER',
    generator: 'generateCircuitBreakerDoc',
    injectInto: ['docs/worker-and-api-limits.md'],
    injectionMarker: '<!-- AUTO-GENERATED: CIRCUIT_BREAKER -->'
  },
  {
    id: 'd1-tables',
    name: 'D1 Database Schema',
    sourceFiles: ['worker/migrations/'],
    outputFragmentId: 'PARTIAL-D1-TABLES',
    generator: 'generateD1TablesDoc',
    injectInto: ['README.md'],
    injectionMarker: '<!-- AUTO-GENERATED: D1_TABLES -->'
  },
  {
    id: 'liquidity-score-weights',
    name: 'Liquidity Score Weights',
    sourceFiles: ['worker/src/cron/dex-liquidity/scoring.ts'],
    constantNames: [
      'TVL_DEPTH_WEIGHT',
      'VOLUME_ACTIVITY_WEIGHT',
      'POOL_QUALITY_WEIGHT',
      'DURABILITY_WEIGHT',
      'PAIR_DIVERSITY_WEIGHT'
    ],
    outputFragmentId: 'PARTIAL-LIQUIDITY-SCORE',
    generator: 'generateLiquidityScoreDoc',
    injectInto: [
      'docs/dex-liquidity.md',
      'src/app/methodology/methodology-sections.tsx'
    ],
    injectionMarker: '<!-- AUTO-GENERATED: LIQUIDITY_SCORE_WEIGHTS -->'
  },
  {
    id: 'dews-thresholds',
    name: 'DEWS Threat Bands',
    sourceFiles: ['worker/src/lib/dews.ts', 'shared/lib/classification.ts'],
    constantNames: [
      'DEWS_BAND_CALM',
      'DEWS_BAND_WATCH', 
      'DEWS_BAND_ALERT',
      'DEWS_BAND_WARNING',
      'DEWS_BAND_DANGER'
    ],
    outputFragmentId: 'PARTIAL-DEWS-THRESHOLDS',
    generator: 'generateDewsThresholdsDoc',
    injectInto: ['docs/dews.md', 'src/app/methodology/methodology-sections.tsx'],
    injectionMarker: '<!-- AUTO-GENERATED: DEWS_THRESHOLDS -->'
  }
];

// Main execution
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCheckMode = args.includes('--check');
  const forceRegenerate = args.includes('--force');
  
  console.log(`📚 Doc Extraction: ${isCheckMode ? 'VALIDATION' : 'GENERATION'} mode\n`);
  
  try {
    if (isCheckMode) {
      const result = await validateDocs();
      process.exit(result.isValid ? 0 : 1);
    } else {
      await generateAllFragments(forceRegenerate);
      await injectFragments();
      console.log('\n✅ Documentation extraction complete');
    }
  } catch (error) {
    console.error('\n❌ Extraction failed:', error);
    process.exit(1);
  }
}

// ... implementation continues

main();
```

### 0.4 AST-Based Extraction Engine

#### 0.4.1 TypeScript AST Extractor (`scripts/doc-extraction/extractors/typescript-ast.ts`)

```typescript
/**
 * Extracts constants from TypeScript source files using ts-morph
 */

import { Project, SourceFile, SyntaxKind, VariableDeclaration } from 'ts-morph';
import * as path from 'path';
import type { ExtractableConstant, ExtractionResult } from '../types';

export class TypeScriptExtractor {
  private project: Project;
  
  constructor(projectRoot: string) {
    this.project = new Project({
      tsConfigFilePath: path.join(projectRoot, 'tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }
  
  /**
   * Extract specific constants from a source file
   */
  async extractConstants(
    filePath: string,
    constantNames?: string[]
  ): Promise<ExtractionResult> {
    const result: ExtractionResult = {
      extracted: [],
      unevaluated: [],
      errors: [],
      timestamp: new Date().toISOString()
    };
    
    try {
      const sourceFile = this.project.addSourceFileAtPath(filePath);
      
      // Get all variable statements
      const variables = sourceFile.getVariableStatements();
      
      for (const stmt of variables) {
        // Only process exported constants
        if (!stmt.isExported()) continue;
        if (!stmt.isDeclaredConst()) continue;
        
        for (const decl of stmt.getDeclarations()) {
          const name = decl.getName();
          
          // Skip if not in requested names (unless no filter specified)
          if (constantNames && !constantNames.includes(name)) {
            continue;
          }
          
          try {
            const constant = this.processDeclaration(decl, filePath);
            if (constant) {
              result.extracted.push(constant);
            }
          } catch (evalError) {
            result.unevaluated.push({
              name,
              reason: evalError instanceof Error ? evalError.message : 'Unknown error'
            });
          }
        }
      }
      
      // Also handle nested constants (e.g., DIMENSION_WEIGHTS.liquidity)
      if (constantNames) {
        for (const fullName of constantNames) {
          if (fullName.includes('.')) {
            const [parentName, childName] = fullName.split('.');
            const parent = result.extracted.find(c => c.name === parentName);
            
            if (parent && typeof parent.value === 'object' && parent.value !== null) {
              const childValue = (parent.value as Record<string, unknown>)[childName];
              if (childValue !== undefined) {
                result.extracted.push({
                  name: fullName,
                  value: childValue,
                  sourceFile: filePath,
                  line: parent.line,
                  category: this.inferCategory(fullName),
                  description: `${parentName}.${childName} sub-constant`
                });
              }
            }
          }
        }
      }
      
    } catch (error) {
      result.errors.push({
        file: filePath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    return result;
  }
  
  /**
   * Process a single variable declaration
   */
  private processDeclaration(
    decl: VariableDeclaration,
    filePath: string
  ): ExtractableConstant | null {
    const name = decl.getName();
    const { line } = decl.getSourceFile().getLineAndCharacterOfPosition(
      decl.getNameNode().getStart()
    );
    
    // Get JSDoc
    const jsDocs = decl.getVariableStatement()?.getJsDocs() || [];
    const description = jsDocs[0]?.getDescription();
    
    // Get since tag
    const sinceTag = jsDocs[0]?.getTag('since');
    const since = sinceTag?.getComment();
    
    // Evaluate the initializer
    const initializer = decl.getInitializer();
    if (!initializer) {
      throw new Error(`No initializer for ${name}`);
    }
    
    const value = this.evaluateExpression(initializer);
    
    return {
      name,
      value,
      sourceFile: filePath,
      line: line + 1,
      description,
      since,
      category: this.inferCategory(name)
    };
  }
  
  /**
   * Safely evaluate a TypeScript expression to its runtime value
   */
  private evaluateExpression(node: import('ts-morph').Expression): unknown {
    const kind = node.getKind();
    
    // Primitives
    if (kind === SyntaxKind.NumericLiteral) {
      return parseFloat(node.getText());
    }
    
    if (kind === SyntaxKind.StringLiteral) {
      return node.getLiteralValue();
    }
    
    if (kind === SyntaxKind.TrueKeyword) return true;
    if (kind === SyntaxKind.FalseKeyword) return false;
    if (kind === SyntaxKind.NullKeyword) return null;
    
    // Arrays
    if (kind === SyntaxKind.ArrayLiteralExpression) {
      const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      return arr.getElements().map(el => this.evaluateExpression(el));
    }
    
    // Objects
    if (kind === SyntaxKind.ObjectLiteralExpression) {
      const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const result: Record<string, unknown> = {};
      
      for (const prop of obj.getProperties()) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const assign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          const propName = assign.getName();
          result[propName] = this.evaluateExpression(assign.getInitializer());
        }
        else if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
          const shorthand = prop.asKindOrThrow(SyntaxKind.ShorthandPropertyAssignment);
          const propName = shorthand.getName();
          // For shorthand, we'd need to resolve the reference
          // This is complex - mark as unevaluated
          throw new Error(`Cannot evaluate shorthand property: ${propName}`);
        }
      }
      
      return result;
    }
    
    // Arithmetic expressions (simple cases)
    if (kind === SyntaxKind.BinaryExpression) {
      const binary = node.asKindOrThrow(SyntaxKind.BinaryExpression);
      const left = this.evaluateExpression(binary.getLeft());
      const right = this.evaluateExpression(binary.getRight());
      const op = binary.getOperatorToken().getText();
      
      if (typeof left === 'number' && typeof right === 'number') {
        switch (op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/': return left / right;
          case '**': return Math.pow(left, right);
        }
      }
    }
    
    // Enum member references
    if (kind === SyntaxKind.PropertyAccessExpression) {
      // Try to resolve enum members
      const propAccess = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const symbol = propAccess.getSymbol();
      
      if (symbol) {
        const valueDeclaration = symbol.getValueDeclaration();
        if (valueDeclaration) {
          // This is getting complex - may need to skip
          throw new Error(`Cannot evaluate property access: ${node.getText()}`);
        }
      }
    }
    
    // If we can't evaluate it, throw
    throw new Error(`Unsupported expression kind: ${node.getKindName()}`);
  }
  
  /**
   * Infer documentation category from constant name
   */
  private inferCategory(name: string): ExtractableConstant['category'] {
    const lower = name.toLowerCase();
    
    if (lower.includes('weight') || lower.includes('score')) return 'scoring';
    if (lower.includes('threshold') || lower.includes('limit') || lower.includes('bps')) return 'thresholds';
    if (lower.includes('cron') || lower.includes('interval') || lower.includes('schedule')) return 'schedules';
    if (lower.includes('rate') || lower.includes('budget') || lower.includes('timeout')) return 'limits';
    if (lower.includes('table') || lower.includes('column') || lower.includes('schema')) return 'schema';
    
    return 'thresholds'; // Default
  }
}
```

#### 0.4.2 TOML Extractor (`scripts/doc-extraction/extractors/toml-parser.ts`)

```typescript
/**
 * Extracts cron schedules and env bindings from wrangler.toml
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parse } from 'toml';
import type { ExtractableConstant } from '../types';

interface WranglerConfig {
  triggers?: {
    crons?: string[];
  };
  vars?: Record<string, unknown>;
  'd1_databases'?: Array<{
    binding: string;
    database_name: string;
  }>;
}

export async function extractFromWranglerToml(
  filePath: string
): Promise<ExtractableConstant[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const config = parse(content) as WranglerConfig;
  
  const constants: ExtractableConstant[] = [];
  
  // Extract cron schedules
  if (config.triggers?.crons) {
    constants.push({
      name: 'CRON_SCHEDULES',
      value: config.triggers.crons,
      sourceFile: filePath,
      line: findLineNumber(content, 'crons'),
      category: 'schedules',
      description: 'Cron job schedules from wrangler.toml'
    });
    
    // Also add individual schedules with parsed descriptions
    config.triggers.crons.forEach((cron, idx) => {
      constants.push({
        name: `CRON_SCHEDULE_${idx + 1}`,
        value: cron,
        sourceFile: filePath,
        line: findLineNumber(content, cron),
        category: 'schedules',
        description: parseCronDescription(cron)
      });
    });
  }
  
  // Extract D1 database bindings
  if (config['d1_databases']) {
    constants.push({
      name: 'D1_DATABASES',
      value: config['d1_databases'].map(db => db.database_name),
      sourceFile: filePath,
      line: findLineNumber(content, 'd1_databases'),
      category: 'schema',
      description: 'D1 database bindings'
    });
  }
  
  return constants;
}

/**
 * Find line number for a string in content
 */
function findLineNumber(content: string, search: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(search)) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Parse a cron expression into human-readable description
 */
function parseCronDescription(cron: string): string {
  // Simple parsing for common patterns
  const parts = cron.split(' ');
  
  if (parts[0] === '*/15' && parts[1] === '*' && parts[2] === '*') {
    return 'Every 15 minutes';
  }
  if (parts[0].includes(',')) {
    const minutes = parts[0].split(',').length;
    return `Every hour at ${minutes} specific minute offsets`;
  }
  if (parts[0] === '0' && parts[1] === '8') {
    return 'Daily at 08:00 UTC';
  }
  if (parts[0] === '5' && parts[1] === '8') {
    return 'Daily at 08:05 UTC';
  }
  if (parts[0] === '11' && parts[1] === '*') {
    return 'Hourly at :11';
  }
  
  return `Cron: ${cron}`;
}
```

---

## Phase 1: High ROI Implementation

### 1.1 Safety Score Generator (`scripts/doc-extraction/templates/safety-score.ts`)

```typescript
/**
 * Generates documentation for safety score weights and thresholds
 */

import type { ExtractableConstant, DocFragment } from '../types';

export interface SafetyScoreData {
  weights: Record<string, number>;
  thresholds: Array<{ grade: string; min: number; max?: number }>;
  pegExponent: number;
  noLiquidityPenalty: number;
  version?: string;
}

export function generateSafetyScoreDoc(
  constants: ExtractableConstant[]
): string {
  const data = parseConstants(constants);
  
  return `<!-- 
  AUTO-GENERATED from shared/lib/report-cards.ts
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### Dimension Weights

Base dimensions and their relative importance in the overall safety score:

| Dimension | Weight | Description |
|-----------|--------|-------------|
${formatWeightsTable(data.weights)}

**Total base weight:** ${Object.values(data.weights).reduce((a, b) => a + b, 0) * 100}%

### Grade Thresholds

Scores are mapped to letter grades using these thresholds:

| Grade | Score Range | Description |
|-------|-------------|-------------|
${formatThresholdsTable(data.thresholds)}

### Peg Stability Multiplier

After computing the base score, peg stability is applied as a power-curve multiplier:

\`\`\`
final = base × (pegScore / 100)^${data.pegExponent}
\`\`\`

- Strong pegs (90+) are barely affected (~2% penalty)
- Broken pegs are properly penalized (e.g., pegScore 10 → 37% penalty)
- NAV tokens receive multiplier 1.0 (peg tracking does not apply)

### No-Liquidity-Data Penalty

When exit liquidity is NR (no DEX or redemption signal):

- **Penalty:** ${((1 - data.noLiquidityPenalty) * 100).toFixed(0)}% reduction (${data.noLiquidityPenalty}× multiplier)
- **Application:** Applied to final score after peg multiplier
- **Weight handling:** Weights are redistributed across available dimensions

${data.version ? `### Methodology Version

Current version: **${data.version}**

See \`/methodology/scoring-changelog/\` for version history.
` : ''}`;
}

function parseConstants(constants: ExtractableConstant[]): SafetyScoreData {
  const data: Partial<SafetyScoreData> = {};
  
  for (const c of constants) {
    switch (c.name) {
      case 'DIMENSION_WEIGHTS':
        data.weights = c.value as Record<string, number>;
        break;
      case 'GRADE_THRESHOLDS':
        data.thresholds = Object.entries(c.value as Record<string, number>)
          .map(([grade, min]) => ({ grade, min }))
          .sort((a, b) => b.min - a.min);
        break;
      case 'PEG_MULTIPLIER_EXPONENT':
        data.pegExponent = c.value as number;
        break;
      case 'NO_LIQUIDITY_PENALTY':
        data.noLiquidityPenalty = c.value as number;
        break;
      case 'SAFETY_SCORE_VERSION':
        data.version = c.value as string;
        break;
    }
  }
  
  return data as SafetyScoreData;
}

function formatWeightsTable(weights: Record<string, number>): string {
  const descriptions: Record<string, string> = {
    liquidity: 'Exit liquidity quality (DEX + redemption)',
    resilience: 'Collateral quality, custody, blacklist capability',
    decentralization: 'Governance quality and chain risk',
    dependencyRisk: 'Upstream exposure and systemic risk',
    pegStability: 'Applied as multiplier, not base weight'
  };
  
  return Object.entries(weights)
    .map(([key, value]) => {
      const pct = (value * 100).toFixed(0);
      const desc = descriptions[key] || key;
      const label = key === 'pegStability' 
        ? `*${key}*` 
        : key.charAt(0).toUpperCase() + key.slice(1);
      return `| ${label} | ${pct}% | ${desc} |`;
    })
    .join('\n');
}

function formatThresholdsTable(thresholds: SafetyScoreData['thresholds']): string {
  const descriptions: Record<string, string> = {
    'A+': 'Excellent - Strong across all dimensions',
    'A': 'Very Good - Minor weaknesses acceptable',
    'A-': 'Good - Solid but not exceptional',
    'B+': 'Above Average - Some areas need attention',
    'B': 'Average - Moderate risk profile',
    'B-': 'Below Average - Notable weaknesses',
    'C+': 'Weak - Several concerns',
    'C': 'Poor - Significant risks',
    'C-': 'Very Poor - Major red flags',
    'D': 'Bad - Critical issues',
    'F': 'Failed - Avoid'
  };
  
  return thresholds.map((t, i) => {
    const range = t.max !== undefined 
      ? `${t.min}–${t.max}` 
      : `${t.min}+`;
    const desc = descriptions[t.grade] || '';
    return `| ${t.grade} | ${range} | ${desc} |`;
  }).join('\n');
}
```

### 1.2 Depeg Thresholds Generator (`scripts/doc-extraction/templates/depeg-detection.ts`)

```typescript
/**
 * Generates documentation for depeg detection thresholds
 */

import type { ExtractableConstant } from '../types';

export interface DepegThresholdsData {
  thresholdBps: number;
  thresholdNonUsdBps: number;
  confirmationSupplyThreshold: number;
  pendingMinAgeSec: number;
  pendingExpirySec: number;
  secondaryThresholdRatio: number;
  extremeMoveBps: number;
}

export function generateDepegThresholdsDoc(
  constants: ExtractableConstant[]
): string {
  const data = parseConstants(constants);
  
  return `<!-- 
  AUTO-GENERATED from worker/src/lib/constants.ts
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### Depeg Detection Thresholds

| Parameter | Value | Description |
|-----------|-------|-------------|
| USD Peg Threshold | ${data.thresholdBps} bps (${(data.thresholdBps / 100).toFixed(2)}%) | Deviation required to trigger depeg detection for USD-pegged stablecoins |
| Non-USD Threshold | ${data.thresholdNonUsdBps} bps (${(data.thresholdNonUsdBps / 100).toFixed(2)}%) | Higher threshold for non-USD pegs due to FX volatility |
| Major Coin Supply | $${(data.confirmationSupplyThreshold / 1e9).toFixed(0)}B+ | Market cap threshold for requiring secondary confirmation |
| Pending Min Age | ${data.pendingMinAgeSec / 60} min | Minimum time in pending state before major coin confirmation |
| Pending Expiry | ${data.pendingExpirySec / 60} min | Maximum time a pending depeg can remain unconfirmed |
| Secondary Ratio | ${data.secondaryThresholdRatio * 100}% | Required secondary source confirmation threshold |
| Extreme Move | ${data.extremeMoveBps} bps (${(data.extremeMoveBps / 100).toFixed(0)}%) | Threshold for immediate extreme depeg classification |

### Threshold Rationale

**USD vs Non-USD:** Non-USD stablecoins use a ${((data.thresholdNonUsdBps / data.thresholdBps - 1) * 100).toFixed(0)}% higher threshold to account for:
- Foreign exchange rate volatility
- Lower liquidity on non-USD pairs
- Higher basis risk

**Major Coin Confirmation:** Stablecoins with $${(data.confirmationSupplyThreshold / 1e9).toFixed(0)}B+ market cap require:
1. Initial depeg detection (primary threshold)
2. ${data.pendingMinAgeSec / 60}-minute pending period
3. Secondary source confirmation at ${data.secondaryThresholdRatio * 100}% of primary threshold

**Extreme Moves:** Prices deviating >${(data.extremeMoveBps / 100).toFixed(0)}% are immediately flagged as extreme depegs regardless of confirmation status.`;
}

function parseConstants(constants: ExtractableConstant[]): DepegThresholdsData {
  const data: Partial<DepegThresholdsData> = {};
  
  for (const c of constants) {
    switch (c.name) {
      case 'DEPEG_THRESHOLD_BPS':
        data.thresholdBps = c.value as number;
        break;
      case 'DEPEG_THRESHOLD_BPS_NON_USD':
        data.thresholdNonUsdBps = c.value as number;
        break;
      case 'DEPEG_CONFIRMATION_SUPPLY_THRESHOLD':
        data.confirmationSupplyThreshold = c.value as number;
        break;
      case 'DEPEG_PENDING_MIN_AGE_SEC':
        data.pendingMinAgeSec = c.value as number;
        break;
      case 'DEPEG_PENDING_EXPIRY_SEC':
        data.pendingExpirySec = c.value as number;
        break;
      case 'DEPEG_SECONDARY_THRESHOLD_RATIO':
        data.secondaryThresholdRatio = c.value as number;
        break;
      case 'DEPEG_EXTREME_MOVE_BPS':
        data.extremeMoveBps = c.value as number;
        break;
    }
  }
  
  return data as DepegThresholdsData;
}
```

### 1.3 Cron Schedule Generator (`scripts/doc-extraction/templates/cron-schedules.ts`)

```typescript
/**
 * Generates cron schedule documentation from wrangler.toml
 */

import type { ExtractableConstant } from '../types';

interface CronJob {
  schedule: string;
  description: string;
  jobs: string[];
}

export function generateCronSchedulesDoc(constants: ExtractableConstant[]): string {
  const schedules = extractSchedules(constants);
  
  return `<!-- 
  AUTO-GENERATED from worker/wrangler.toml and shared/lib/cron-jobs.ts
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### Cron Job Schedules

| Schedule | Frequency | Jobs |
|----------|-----------|------|
${schedules.map(s => `| ${s.schedule} | ${s.description} | ${s.jobs.join(', ')} |`).join('\n')}

### Schedule Details

${schedules.map(s => `
#### ${s.schedule} — ${s.description}

${s.jobs.map(j => `- ${j}`).join('\n')}
`).join('\n')}

### Total: ${schedules.length} cron triggers, ${schedules.reduce((sum, s) => sum + s.jobs.length, 0)} jobs
`;
}

function extractSchedules(constants: ExtractableConstant[]): CronJob[] {
  // Parse from CRON_SCHEDULES constant
  const schedulesConst = constants.find(c => c.name === 'CRON_SCHEDULES');
  if (!schedulesConst) return [];
  
  const rawSchedules = schedulesConst.value as string[];
  
  // Map schedules to descriptions and jobs
  // This would need to cross-reference with CRON_JOB_DEFINITIONS
  const scheduleMap: Record<string, { desc: string; jobs: string[] }> = {
    '*/15 * * * *': {
      desc: 'Every 15 minutes',
      jobs: ['sync-stablecoins', 'enrich-prices', 'detect-depegs', 'confirm-pending-depegs']
    },
    '3,23,43 * * * *': {
      desc: 'Every 20 minutes (at :03, :23, :43)',
      jobs: ['sync-blacklist']
    },
    '4,24,44 * * * *': {
      desc: 'Every 20 minutes (at :04, :24, :44)',
      jobs: ['sync-mint-burn (critical lane)']
    },
    '13,33,53 * * * *': {
      desc: 'Every 20 minutes (at :13, :33, :53)',
      jobs: ['sync-mint-burn (extended lane)']
    },
    '6,36 * * * *': {
      desc: 'Every 30 minutes (at :06, :36)',
      jobs: ['sync-dex-discovery']
    },
    '10,40 * * * *': {
      desc: 'Every 30 minutes (at :10, :40)',
      jobs: ['sync-dex-liquidity', 'sync-yield-data', 'sync-stablecoin-charts']
    },
    '11 * * * *': {
      desc: 'Hourly at :11',
      jobs: ['sync-live-reserves']
    },
    '2,7,12,17,22,27,32,37,42,47,52,57 * * * *': {
      desc: 'Every 5 minutes',
      jobs: ['dispatch-telegram-alerts']
    },
    '0 8 * * *': {
      desc: 'Daily at 08:00 UTC',
      jobs: ['snapshot-supply', 'snapshot-safety-grade-history', 'snapshot-tbill-rate', 'snapshot-psi-daily', 'snapshot-usds-status']
    },
    '5 8 * * *': {
      desc: 'Daily at 08:05 UTC',
      jobs: ['sync-bluechip', 'daily-digest', 'discovery-scan']
    }
  };
  
  return rawSchedules.map(schedule => ({
    schedule,
    description: scheduleMap[schedule]?.desc || 'Custom schedule',
    jobs: scheduleMap[schedule]?.jobs || ['Unknown jobs']
  }));
}
```

---

## Phase 2: Medium ROI Implementation

### 2.1 API Rate Limits Generator (`scripts/doc-extraction/templates/api-limits.ts`)

```typescript
/**
 * Generates API rate limit documentation
 */

import type { ExtractableConstant } from '../types';

interface RateLimitData {
  publicApiRateLimit: number;
  feedbackWindowSec: number;
  feedbackMaxSubmissions: number;
}

export function generateApiLimitsDoc(constants: ExtractableConstant[]): string {
  const data = parseConstants(constants);
  
  return `<!-- 
  AUTO-GENERATED from worker source files
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### Rate Limits

| Endpoint | Limit | Window | Notes |
|----------|-------|--------|-------|
| Public API (all endpoints) | ${data.publicApiRateLimit} requests | 60 seconds | Per-IP hash, D1-backed bucketing |
| Feedback submission | ${data.feedbackMaxSubmissions} submissions | ${data.feedbackWindowSec / 60} minutes | Per-salted IP hash |

### Implementation Details

**Public API Rate Limiting:**
- Uses D1 table \`public_api_rate_limit\` for distributed bucketing
- IP addresses are hashed with \`PUBLIC_API_RATE_LIMIT_SALT\`
- Returns 429 status with \`Retry-After\` header when exceeded

**Feedback Rate Limiting:**
- Uses D1 table \`feedback_rate_limit\`
- Windows are rolling (not fixed)
- Returns 429 with explanatory message when exceeded`;
}

function parseConstants(constants: ExtractableConstant[]): RateLimitData {
  return {
    publicApiRateLimit: constants.find(c => c.name === 'PUBLIC_API_RATE_LIMIT')?.value as number || 300,
    feedbackWindowSec: constants.find(c => c.name === 'FEEDBACK_RATE_LIMIT_WINDOW_SEC')?.value as number || 600,
    feedbackMaxSubmissions: constants.find(c => c.name === 'FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS')?.value as number || 3
  };
}
```

### 2.2 D1 Tables Generator (`scripts/doc-extraction/templates/d1-schema.ts`)

```typescript
/**
 * Generates D1 table documentation from migration files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExtractableConstant } from '../types';

interface TableInfo {
  name: string;
  purpose: string;
  columns: string[];
  indexes?: string[];
  migration: string;
}

export async function generateD1TablesDoc(
  _constants: ExtractableConstant[],
  migrationsDir: string
): Promise<string> {
  const tables = await extractTablesFromMigrations(migrationsDir);
  
  return `<!-- 
  AUTO-GENERATED from worker/migrations/*.sql
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
  Migration count: ${tables.length}
-->

### D1 Database Tables

| Table | Purpose | Migration |
|-------|---------|-----------|
${tables.map(t => `| ${t.name} | ${t.purpose.substring(0, 50)}${t.purpose.length > 50 ? '...' : ''} | ${t.migration} |`).join('\n')}

### Table Details

${tables.map(t => `
#### ${t.name}

**Purpose:** ${t.purpose}

**Migration:** \`${t.migration}\`

**Columns:**
${t.columns.map(c => `- ${c}`).join('\n')}
${t.indexes?.length ? `
**Indexes:**
${t.indexes.map(i => `- ${i}`).join('\n')}
` : ''}
`).join('\n---\n')}

**Total tables:** ${tables.length}
`;
}

async function extractTablesFromMigrations(migrationsDir: string): Promise<TableInfo[]> {
  const tables: TableInfo[] = [];
  
  const files = await fs.readdir(migrationsDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
  
  for (const file of sqlFiles) {
    const content = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
    
    // Extract CREATE TABLE statements
    const createTableRegex = /CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([^)]+)\)/gi;
    let match;
    
    while ((match = createTableRegex.exec(content)) !== null) {
      const tableName = match[1];
      const columnsText = match[2];
      
      // Parse columns
      const columns = columnsText
        .split(',')
        .map(col => col.trim().split(/\s+/)[0])
        .filter(col => col && !col.startsWith('--'));
      
      // Extract indexes
      const indexRegex = new RegExp(`CREATE INDEX.*?ON\\s+${tableName}\\s*\\(([^)]+)\\)`, 'gi');
      const indexes: string[] = [];
      let indexMatch;
      while ((indexMatch = indexRegex.exec(content)) !== null) {
        indexes.push(indexMatch[1]);
      }
      
      tables.push({
        name: tableName,
        purpose: inferTablePurpose(tableName),
        columns,
        indexes: indexes.length > 0 ? indexes : undefined,
        migration: file
      });
    }
  }
  
  return tables;
}

function inferTablePurpose(tableName: string): string {
  const purposes: Record<string, string> = {
    'cache': 'JSON blobs with CAS write guard',
    'blacklist_events': 'Freeze/blacklist event log',
    'depeg_events': 'Peg deviation events',
    'price_cache': 'Historical price snapshots',
    'dex_liquidity': 'DEX liquidity scores and pool data',
    'supply_history': 'Daily supply snapshots',
    'reserve_composition': 'Live reserve slices',
    'stability_index': 'Ecosystem health scores',
    'mint_burn_events': 'Mint/burn event log',
    'yield_data': 'Yield snapshots',
    'telegram_subscribers': 'Telegram bot subscribers',
    'daily_digest': 'AI-generated market summaries'
  };
  
  return purposes[tableName] || 'Application data storage';
}
```

### 2.3 Liquidity Score Generator (`scripts/doc-extraction/templates/liquidity-score.ts`)

```typescript
/**
 * Generates liquidity score weights documentation
 */

import type { ExtractableConstant } from '../types';

interface LiquidityScoreData {
  tvlDepthWeight: number;
  volumeActivityWeight: number;
  poolQualityWeight: number;
  durabilityWeight: number;
  pairDiversityWeight: number;
}

export function generateLiquidityScoreDoc(constants: ExtractableConstant[]): string {
  const data = parseConstants(constants);
  
  const weights = [
    { key: 'TVL Depth', value: data.tvlDepthWeight, desc: 'Total Value Locked and depth metrics' },
    { key: 'Volume Activity', value: data.volumeActivityWeight, desc: 'Trading volume and velocity' },
    { key: 'Pool Quality', value: data.poolQualityWeight, desc: 'Pool mechanism health and balance' },
    { key: 'Durability', value: data.durabilityWeight, desc: 'Historical stability and longevity' },
    { key: 'Pair Diversity', value: data.pairDiversityWeight, desc: 'Number and variety of trading pairs' }
  ];
  
  return `<!-- 
  AUTO-GENERATED from worker/src/cron/dex-liquidity/scoring.ts
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### Liquidity Score Weights

The DEX Liquidity Score is a composite 0–100 metric combining:

| Component | Weight | Description |
|-----------|--------|-------------|
${weights.map(w => `| ${w.key} | ${(w.value * 100).toFixed(1)}% | ${w.desc} |`).join('\n')}

**Total:** ${weights.reduce((sum, w) => sum + w.value, 0) * 100}%

### Component Details

**TVL Depth (${(data.tvlDepthWeight * 100).toFixed(1)}%):**
- Measures total pool liquidity
- Log-scaled scoring to avoid whale pool bias
- Minimum viable TVL thresholds per chain

**Volume Activity (${(data.volumeActivityWeight * 100).toFixed(1)}%):**
- 24h and 7d trading volume
- Velocity-adjusted for market conditions
- Excludes wash trading patterns

**Pool Quality (${(data.poolQualityWeight * 100).toFixed(1)}%):**
- Balance health (ratio drift)
- Mechanism type (AMM vs orderbook)
- Fee tier attractiveness

**Durability (${(data.durabilityWeight * 100).toFixed(1)}%):**
- Pool age and historical consistency
- Concentration metrics (HHI)
- Depth stability over time

**Pair Diversity (${(data.pairDiversityWeight * 100).toFixed(1)}%):**
- Number of distinct trading pairs
- Quality-weighted pair count
- Avoids duplicate pool counting`;
}

function parseConstants(constants: ExtractableConstant[]): LiquidityScoreData {
  return {
    tvlDepthWeight: findConstant(constants, 'TVL_DEPTH_WEIGHT', 0.35),
    volumeActivityWeight: findConstant(constants, 'VOLUME_ACTIVITY_WEIGHT', 0.20),
    poolQualityWeight: findConstant(constants, 'POOL_QUALITY_WEIGHT', 0.225),
    durabilityWeight: findConstant(constants, 'DURABILITY_WEIGHT', 0.15),
    pairDiversityWeight: findConstant(constants, 'PAIR_DIVERSITY_WEIGHT', 0.075)
  };
}

function findConstant(constants: ExtractableConstant[], name: string, defaultValue: number): number {
  const c = constants.find(c => c.name === name);
  return (c?.value as number) ?? defaultValue;
}
```

### 2.4 DEWS Thresholds Generator (`scripts/doc-extraction/templates/dews-thresholds.ts`)

```typescript
/**
 * Generates DEWS (Distressed Ecosystem Warning System) threshold documentation
 */

import type { ExtractableConstant } from '../types';

interface DewsThresholdsData {
  calm: number;
  watch: number;
  alert: number;
  warning: number;
  danger: number;
}

export function generateDewsThresholdsDoc(constants: ExtractableConstant[]): string {
  const data = parseConstants(constants);
  
  return `<!-- 
  AUTO-GENERATED from worker/src/lib/dews.ts and shared/lib/classification.ts
  Do not edit manually. Run 'npm run docs:extract' to regenerate.
  Generated at: ${new Date().toISOString()}
-->

### DEWS Threat Bands

The Distressed Ecosystem Warning System uses rolling 15-minute stress signals with these bands:

| Band | Score Range | Color | Description |
|------|-------------|-------|-------------|
| CALM | 0–${data.calm} | 🟢 | Normal market conditions |
| WATCH | ${data.calm + 1}–${data.watch} | 🔵 | Elevated attention warranted |
| ALERT | ${data.watch + 1}–${data.alert} | 🟡 | Active stress signals present |
| WARNING | ${data.alert + 1}–${data.warning} | 🟠 | Significant ecosystem distress |
| DANGER | ${data.warning + 1}–100 | 🔴 | Critical stability threat |

### Band Semantics

**CALM (0–${data.calm}):**
- No active depegs
- Low DEWS contributors
- Healthy liquidity across major stablecoins

**WATCH (${data.calm + 1}–${data.watch}):**
- Minor peg deviations
- Early warning indicators
- Elevated but manageable risk

**ALERT (${data.watch + 1}–${data.alert}):**
- Active depeg events
- Multiple stress signals firing
- Requires monitoring

**WARNING (${data.alert + 1}–${data.warning}):**
- Broad market stress
- Flight-to-quality indicators
- Contagion risk elevated

**DANGER (${data.warning + 1}+):**
- Systemic stability threat
- Multiple major depegs
- Crisis conditions`;
}

function parseConstants(constants: ExtractableConstant[]): DewsThresholdsData {
  return {
    calm: findThreshold(constants, 'DEWS_BAND_CALM', 15),
    watch: findThreshold(constants, 'DEWS_BAND_WATCH', 35),
    alert: findThreshold(constants, 'DEWS_BAND_ALERT', 55),
    warning: findThreshold(constants, 'DEWS_BAND_WARNING', 75),
    danger: 100 // Implicit
  };
}

function findThreshold(constants: ExtractableConstant[], name: string, defaultValue: number): number {
  const c = constants.find(c => c.name === name);
  return (c?.value as number) ?? defaultValue;
}
```

---

## Phase 3: Integration & Tooling

### 3.1 Fragment Injection System

```typescript
// scripts/doc-extraction/inject-fragments.ts

import * as fs from 'fs/promises';
import * as path from 'path';

interface InjectionConfig {
  targetFile: string;
  marker: string;
  fragmentPath: string;
}

/**
 * Inject generated fragments into target documentation files
 */
export async function injectFragments(configs: InjectionConfig[]): Promise<void> {
  for (const config of configs) {
    await injectFragment(config);
  }
}

async function injectFragment(config: InjectionConfig): Promise<void> {
  const { targetFile, marker, fragmentPath } = config;
  
  // Read files
  const targetContent = await fs.readFile(targetFile, 'utf-8');
  const fragmentContent = await fs.readFile(fragmentPath, 'utf-8');
  
  // Find marker
  const markerRegex = new RegExp(
    `(${escapeRegex(marker)}\\s*\\n)([\\s\\S]*?)(?=\\n?${escapeRegex(marker.replace('START', 'END').replace('BEGIN', 'END'))}|\\n?$)`,
    'g'
  );
  
  // Alternative: simpler marker replacement
  const simpleMarker = marker;
  const endMarker = marker.replace('AUTO-GENERATED:', 'END AUTO-GENERATED:');
  
  const startIdx = targetContent.indexOf(simpleMarker);
  const endIdx = targetContent.indexOf(endMarker);
  
  if (startIdx === -1) {
    console.warn(`Marker not found in ${targetFile}: ${marker}`);
    return;
  }
  
  // Replace content between markers
  const before = targetContent.substring(0, startIdx + simpleMarker.length);
  const after = endIdx === -1 ? '' : targetContent.substring(endIdx);
  
  const newContent = before + '\n\n' + fragmentContent + '\n\n' + after;
  
  // Write back
  await fs.writeFile(targetFile, newContent, 'utf-8');
  console.log(`✓ Injected ${path.basename(fragmentPath)} into ${path.basename(targetFile)}`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### 3.2 CI Validation (`scripts/doc-extraction/validate.ts`)

```typescript
// scripts/doc-extraction/validate.ts

import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import type { ValidationResult } from './types';

/**
 * Validates that all documentation is up-to-date
 */
export async function validateDocs(): Promise<ValidationResult> {
  const result: ValidationResult = {
    isValid: true,
    staleFragments: [],
    missingFragments: [],
    injectionFailures: [],
    inconsistencies: []
  };
  
  // Load expected hashes
  const hashFile = 'docs/_generated/.content-hashes.json';
  let expectedHashes: Record<string, string>;
  
  try {
    const hashContent = await fs.readFile(hashFile, 'utf-8');
    expectedHashes = JSON.parse(hashContent);
  } catch {
    console.error('No hash file found. Run full extraction first.');
    result.isValid = false;
    return result;
  }
  
  // Check each fragment
  for (const [fragmentId, expectedHash] of Object.entries(expectedHashes)) {
    const fragmentPath = `docs/_generated/${fragmentId}.md`;
    
    try {
      const content = await fs.readFile(fragmentPath, 'utf-8');
      const actualHash = createHash('md5').update(content).digest('hex');
      
      if (actualHash !== expectedHash) {
        result.isValid = false;
        result.staleFragments.push({
          fragmentId,
          expectedHash,
          actualHash
        });
      }
    } catch {
      result.isValid = false;
      result.missingFragments.push(fragmentId);
    }
  }
  
  // Report results
  console.log('\n=== Validation Results ===\n');
  
  if (result.staleFragments.length > 0) {
    console.log('❌ Stale fragments (source constants changed):');
    result.staleFragments.forEach(f => console.log(`   - ${f.fragmentId}`));
  }
  
  if (result.missingFragments.length > 0) {
    console.log('❌ Missing fragments:');
    result.missingFragments.forEach(f => console.log(`   - ${f}`));
  }
  
  if (result.isValid) {
    console.log('✅ All documentation is up-to-date');
  } else {
    console.log('\nRun: npm run docs:extract');
  }
  
  return result;
}
```

### 3.3 Package.json Scripts

```json
{
  "scripts": {
    "docs:extract": "tsx scripts/doc-extraction/index.ts",
    "docs:extract:check": "tsx scripts/doc-extraction/index.ts --check",
    "docs:extract:force": "tsx scripts/doc-extraction/index.ts --force",
    "docs:validate": "npm run docs:extract:check",
    "prebuild": "npm run docs:extract && tsx scripts/generate-redirects.ts"
  }
}
```

### 3.4 CI Integration (`.github/workflows/validate-docs.yml`)

```yaml
name: Validate Documentation

on:
  push:
    paths:
      - 'shared/lib/**/*.ts'
      - 'worker/src/lib/**/*.ts'
      - 'worker/wrangler.toml'
      - 'worker/migrations/*.sql'
      - 'docs/**/*.md'
  pull_request:
    paths:
      - 'shared/lib/**/*.ts'
      - 'worker/src/lib/**/*.ts'
      - 'worker/wrangler.toml'
      - 'worker/migrations/*.sql'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Validate documentation is up-to-date
        run: npm run docs:validate
        
      - name: Check for uncommitted changes
        run: |
          if [ -n "$(git status --porcelain docs/_generated/)" ]; then
            echo "❌ Generated documentation not committed"
            git diff docs/_generated/
            exit 1
          fi
```

---

## Implementation Timeline

### Week 1: Foundation
- Day 1-2: Set up project structure, install dependencies
- Day 3-4: Implement TypeScript AST extractor
- Day 5: Implement TOML parser

### Week 2: Phase 1
- Day 1-2: Safety score generator + injection
- Day 3-4: Depeg thresholds generator
- Day 5: Cron schedules generator
- Day 6-7: Testing and refinement

### Week 3: Phase 2
- Day 1-2: API rate limits + circuit breaker
- Day 3-4: D1 tables generator (SQL parsing)
- Day 5-6: Liquidity score + DEWS generators
- Day 7: Integration testing

### Week 4: Polish & Integration
- Day 1-2: CI/CD integration
- Day 3-4: Cross-document consistency validation
- Day 5-6: Documentation and migration guide
- Day 7: Final testing and rollout

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| AST parsing fails on complex expressions | Fallback to manual values, log warnings |
| Generated content incorrect | Content review required before commit |
| CI noise from frequent regenerations | Only check in CI, generate locally |
| Merge conflicts in generated files | Clear "DO NOT EDIT" headers, regenerate after merge |
| Performance on large files | Cache parsed AST, incremental updates |

---

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| Documentation count drift incidents | 3-5 per quarter | 0 |
| Time to update docs after constant change | 1-2 days | Instant (automated) |
| PR comments about doc/constant mismatch | 2-3 per PR | 0 |
| Developer confidence in documentation | Medium | High |

---

## Migration Strategy

### Step 1: Parallel Implementation (Week 1-2)
- Run extraction alongside existing docs
- Compare outputs manually
- Do not inject yet

### Step 2: Gradual Replacement (Week 3-4)
- Replace one section at a time
- Add injection markers to target files
- Review each generated fragment

### Step 3: Enforcement (Week 5)
- Enable CI validation
- Require `docs:extract` in prebuild
- Document the new workflow

### Step 4: Maintenance Mode (Ongoing)
- Monitor for edge cases
- Add new extractors as needed
- Refine generators based on feedback
