import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { ALL_SESSION_CHECKS } from '../audit.js';
import { CATALOGS, REPO_ROOT, readCatalog, ruleCount, type CatalogMeta } from '../catalog-meta.js';
// The prose generator (build.mjs's source of truth) keeps its OWN duplicate
// CATALOGS list. Import it here so drift between the two hand-maintained lists
// fails CI. It is plain .mjs (no TS) so build.mjs can call it without a compile
// step; vitest loads the .mjs directly here.
// @ts-expect-error generate-catalog-prose.mjs is plain JS with no type declarations
import * as prose from '../../../scripts/generate-catalog-prose.mjs';

const PROSE_CATALOGS: ReadonlyArray<{ catalog: string; spec: string | null; label: string }> =
  prose.CATALOGS;
const specCountHeaders: (body: string) => Array<{ rules: number; categories: number }> =
  prose.specCountHeaders;

/**
 * Guards against drift between the catalogs and everything that restates
 * them: the prose count headers in each spec and the README "Specifications"
 * family table (rule counts), the spec Version/Date headers, and -- most
 * importantly -- the implementation itself (rule ids, severities, fixability,
 * context file patterns and MCP clients). Catalogs are the machine-readable
 * source of truth for readers; the code is the source of truth for the
 * catalogs, so every comparison here reads the code, not a copy of it.
 */

const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');

function meta(key: string): CatalogMeta {
  const m = CATALOGS.find((c) => c.key === key);
  if (!m) throw new Error(`${key} catalog meta missing`);
  return m;
}

/**
 * Pull the count from the README "Specifications" family table row, matched by
 * the catalog's label. Rows look like:
 *   | **[AI Context File Linting Spec](...)** | 27 rules for validating ... |
 *   | **[MCP Config Linting Spec](...)**      | 10 rules for validating ... |
 */
function readmeTableCount(label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\*\\*[^*]*${escaped}[^*]*\\*\\*[^|]*\\|\\s*(\\d+)\\s+rules?\\b`, 'i');
  const m = README.match(re);
  return m ? Number(m[1]) : null;
}

describe('catalog rule-count consistency', () => {
  for (const m of CATALOGS) {
    describe(m.key, () => {
      const count = ruleCount(m);

      it('catalog has at least one rule', () => {
        expect(count).toBeGreaterThan(0);
      });

      if (m.spec) {
        it(`every ${m.spec} count header matches the catalog (${count} rules)`, () => {
          const body = fs.readFileSync(path.join(REPO_ROOT, m.spec as string), 'utf-8');
          const categories = new Set((readCatalog(m).rules ?? []).map((r) => r.category)).size;
          const headers = specCountHeaders(body);
          expect(
            headers.length,
            `no "<N> rules ... <M> categories" header in ${m.spec}`,
          ).toBeGreaterThan(0);
          // ALL of them, not the first: a second, stale header used to pass.
          for (const h of headers) expect(h).toEqual({ rules: count, categories });
        });
      }

      it(`README family-table count matches catalog (${count})`, () => {
        const stated = readmeTableCount(m.label);
        expect(stated, `no README "Specifications" row matched label "${m.label}"`).not.toBeNull();
        expect(stated).toBe(count);
      });
    });
  }
});

describe('spec prose counts other than rules match the catalogs', () => {
  const body = (m: CatalogMeta) => fs.readFileSync(path.join(REPO_ROOT, m.spec as string), 'utf-8');

  it('AGENT_SESSION_LINT_SPEC.md "N AI coding agents" matches dataSources[] length', () => {
    const m = meta('agent-session');
    const stated = body(m).match(/across (\d+) AI coding agents/)?.[1];
    expect(Number(stated)).toBe((readCatalog(m).dataSources as unknown[]).length);
  });

  it('CONTEXT_LINT_SPEC.md client and file-pattern counts match formats[]', () => {
    const m = meta('context');
    const formats = readCatalog(m).formats as Array<{ patterns: string[] }>;
    const stated = body(m).match(/across (\d+) AI coding clients \((\d+) file patterns\)/);
    expect(stated, 'no "across N AI coding clients (M file patterns)" phrase').not.toBeNull();
    const [, clients, patterns] = stated as RegExpMatchArray;
    expect(Number(clients)).toBe(formats.length);
    expect(Number(patterns)).toBe(formats.flatMap((f) => f.patterns).length);
  });

  it('AGENT_SKILL_LINT_SPEC.md "Run the N rules" matches the catalog', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const m = meta('agent-skill');
    const stated = body(m).match(/Run the (\w+) rules/)?.[1];
    expect(stated).toBe(words[ruleCount(m)]);
  });
});

describe('spec Version / Date / MCP Spec Compatibility headers match the catalog', () => {
  for (const m of CATALOGS) {
    if (!m.spec) continue;
    it(`${m.spec} headers equal ${m.catalog} metadata`, () => {
      const body = fs.readFileSync(path.join(REPO_ROOT, m.spec as string), 'utf-8');
      const c = readCatalog(m);
      const header = (name: string) =>
        body.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(\\S+)`, 'm'))?.[1] ?? null;
      expect(header('Version')).toBe(c.specVersion);
      expect(header('Date')).toBe(c.specDate);
      expect(header('MCP Spec Compatibility')).toBe(c.mcpSpecCompatibility ?? null);
    });
  }
});

/**
 * Guards against drift between the two hand-maintained catalog lists: the TS
 * `CATALOGS` in catalog-meta.ts and the duplicate `CATALOGS` in
 * scripts/generate-catalog-prose.mjs (which build.mjs reads via computeTargets).
 * The shared shape is the catalog/spec/label triple; the .mjs list omits the
 * TS-only `key` field, so only the triples are compared.
 */
describe('catalog-meta.ts and generate-catalog-prose.mjs CATALOGS agree', () => {
  it('declare the same number of catalogs', () => {
    expect(PROSE_CATALOGS.length).toBe(CATALOGS.length);
  });

  it('catalog/spec/label triples match element-wise', () => {
    const triples = (
      list: ReadonlyArray<{ catalog: string; spec: string | null; label: string }>,
    ) => list.map(({ catalog, spec, label }) => ({ catalog, spec, label }));
    expect(triples(PROSE_CATALOGS)).toEqual(triples(CATALOGS));
  });
});

// ---------------------------------------------------------------------------
// Emit sites: every `ruleId:` the checks emit, read from the TypeScript AST.
// ---------------------------------------------------------------------------

const CHECKS_DIR = path.join(REPO_ROOT, 'src', 'core', 'checks');

type Pillar = 'context' | 'mcp-config' | 'agent-session' | 'agent-skill';

interface EmitSite {
  ruleId: string;
  severities: Set<string>;
  hasFix: boolean;
  pillar: Pillar;
  where: string;
}

/** A resolved string value plus the ternary branches it depends on. */
interface Choice {
  value: string;
  conds: Record<string, boolean>;
}

function compatible(a: Choice, b: Choice): boolean {
  for (const [k, v] of Object.entries(a.conds)) if (k in b.conds && b.conds[k] !== v) return false;
  return true;
}

function allNodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Statically resolve the string values an expression can take. Deliberately
 * narrow: anything it does not understand throws with file:line, so a new
 * emit-site shape fails this test until the resolver (and the catalog check
 * it feeds) is taught about it, instead of silently dropping out.
 */
function resolveStrings(expr: ts.Expression, sf: ts.SourceFile, nodes: ts.Node[]): Choice[] {
  const where = () =>
    `${path.relative(REPO_ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1}`;
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    return resolveStrings(expr.expression, sf, nodes);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return [{ value: expr.text, conds: {} }];
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) return [];
  if (ts.isConditionalExpression(expr)) {
    const cond = expr.condition.getText(sf);
    return [
      ...resolveStrings(expr.whenTrue, sf, nodes).map((c) => ({
        value: c.value,
        conds: { ...c.conds, [cond]: true },
      })),
      ...resolveStrings(expr.whenFalse, sf, nodes).map((c) => ({
        value: c.value,
        conds: { ...c.conds, [cond]: false },
      })),
    ];
  }
  if (ts.isIdentifier(expr)) {
    const decls = nodes.filter(
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === expr.text &&
        n.initializer !== undefined,
    );
    if (decls.length === 0) throw new Error(`cannot resolve identifier ${expr.text} at ${where()}`);
    return decls.flatMap((d) => resolveStrings(d.initializer as ts.Expression, sf, nodes));
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;
    const fn = nodes.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    const type = fn?.type;
    const members: readonly ts.TypeNode[] =
      type && ts.isUnionTypeNode(type) ? type.types : type ? [type] : [];
    const values = members
      .filter(ts.isLiteralTypeNode)
      .map((t) => t.literal)
      .filter((l): l is ts.StringLiteral => ts.isStringLiteral(l))
      .map((l) => ({ value: l.text, conds: {} }));
    if (values.length === 0) throw new Error(`cannot resolve call ${name}() at ${where()}`);
    return values;
  }
  if (ts.isTemplateExpression(expr) && expr.templateSpans.length === 1) {
    // `content-secrets/${pattern.ruleSlug}`: every string literal assigned to
    // a property of that name in the same file.
    const span = expr.templateSpans[0];
    if (ts.isPropertyAccessExpression(span.expression)) {
      const prop = span.expression.name.text;
      const values = nodes
        .filter(
          (n): n is ts.PropertyAssignment =>
            ts.isPropertyAssignment(n) &&
            ts.isIdentifier(n.name) &&
            n.name.text === prop &&
            ts.isStringLiteral(n.initializer),
        )
        .map((n) => (n.initializer as ts.StringLiteral).text);
      if (values.length > 0) {
        return [...new Set(values)].map((v) => ({
          value: `${expr.head.text}${v}${span.literal.text}`,
          conds: {},
        }));
      }
    }
  }
  throw new Error(`cannot resolve ${ts.SyntaxKind[expr.kind]} at ${where()}`);
}

function propertyNamed(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
}

/** True when the object, or a later `<var>.fix = ...` on the variable it initialises, carries a fix. */
function objectHasFix(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean {
  if (propertyNamed(obj, 'fix')) return true;
  for (const p of obj.properties) {
    if (!ts.isSpreadAssignment(p)) continue;
    let found = false;
    const visit = (n: ts.Node) => {
      if (
        (ts.isShorthandPropertyAssignment(n) || ts.isPropertyAssignment(n)) &&
        ts.isIdentifier(n.name) &&
        n.name.text === 'fix'
      ) {
        found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(p);
    if (found) return true;
  }
  const decl = obj.parent;
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    let scope: ts.Node = decl;
    while (scope.parent && !ts.isBlock(scope)) scope = scope.parent;
    let found = false;
    const visit = (n: ts.Node) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === 'fix' &&
        n.left.expression.getText(sf) === name
      ) {
        found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }
  return false;
}

function pillarOf(file: string): Pillar {
  const rel = path.relative(CHECKS_DIR, file).replace(/\\/g, '/');
  if (rel.startsWith('session/')) return 'agent-session';
  if (rel.startsWith('mcp/')) return 'mcp-config';
  if (rel === 'skills.ts') return 'agent-skill';
  return 'context';
}

function collectEmitSites(): EmitSite[] {
  const sites: EmitSite[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const sf = ts.createSourceFile(
        full,
        fs.readFileSync(full, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const nodes = allNodes(sf);
      for (const n of nodes) {
        if (!ts.isObjectLiteralExpression(n)) continue;
        const idProp = propertyNamed(n, 'ruleId');
        if (!idProp || !ts.isPropertyAssignment(idProp)) continue;
        const where = `${path.relative(REPO_ROOT, full)}:${sf.getLineAndCharacterOfPosition(idProp.getStart(sf)).line + 1}`;
        const sevProp = propertyNamed(n, 'severity');
        let sevExpr: ts.Expression | undefined;
        if (sevProp && ts.isPropertyAssignment(sevProp)) sevExpr = sevProp.initializer;
        else if (sevProp && ts.isShorthandPropertyAssignment(sevProp)) sevExpr = sevProp.name;
        if (!sevExpr) throw new Error(`emit site without a severity at ${where}`);
        const ids = resolveStrings(idProp.initializer, sf, nodes);
        const sevs = resolveStrings(sevExpr, sf, nodes);
        const hasFix = objectHasFix(n, sf);
        for (const id of ids) {
          const severities = new Set(sevs.filter((s) => compatible(id, s)).map((s) => s.value));
          sites.push({ ruleId: id.value, severities, hasFix, pillar: pillarOf(full), where });
        }
      }
    }
  };
  walk(CHECKS_DIR);
  return sites;
}

const SITES = collectEmitSites();

function emittedIds(pillar: Pillar): string[] {
  return [...new Set(SITES.filter((s) => s.pillar === pillar).map((s) => s.ruleId))].sort();
}

describe('emit-site extraction (self-test)', () => {
  it('pairs a ternary ruleId with the ternary severity on the same condition', () => {
    const stale = SITES.filter((s) => s.ruleId === 'staleness/stale');
    const aging = SITES.filter((s) => s.ruleId === 'staleness/aging');
    expect(stale.length).toBeGreaterThan(0);
    expect(aging.length).toBeGreaterThan(0);
    expect(stale.every((s) => [...s.severities].join() === 'warning')).toBe(true);
    expect(aging.every((s) => [...s.severities].join() === 'info')).toBe(true);
  });

  it('expands the content-secrets template ruleId into one id per pattern slug', () => {
    const ids = emittedIds('context').filter((id) => id.startsWith('content-secrets/'));
    expect(ids).toContain('content-secrets/openai-key');
    expect(ids).toContain('content-secrets/private-key-header');
    expect(ids.length).toBeGreaterThan(5);
  });

  it('finds fixes written as a property, a spread, and a later `issue.fix =`', () => {
    const fixed = (id: string) => SITES.filter((s) => s.ruleId === id).some((s) => s.hasFix);
    expect(fixed('paths/not-found')).toBe(true); // fix: property
    expect(fixed('mcp-security/hardcoded-api-key')).toBe(true); // ...(fix ? { fix } : {})
    expect(fixed('mcp-deprecated/sse-transport')).toBe(true); // issue.fix = {...}
    expect(fixed('paths/glob-no-match')).toBe(false);
  });
});

/**
 * Session-pillar ruleId mapping. The catalog publishes pillar-stable
 * `session/<slug>` IDs; the reference implementation namespaces emitted
 * ruleIds by check module (`<check>/<slug>`) and splits memory-index-overflow
 * into one slug per cap dimension. This map IS the published correspondence
 * (documented in AGENT_SESSION_LINT_SPEC.md section 3); the tests below pin
 * it against both the catalog and the ruleIds in the implementation, so
 * neither side can drift without failing CI.
 */
const SESSION_IMPL_RULE_IDS: Record<string, string[]> = {
  'session/missing-secret': ['session-missing-secret/missing-secret'],
  'session/diverged-file': ['session-diverged-file/diverged-file'],
  'session/missing-workflow': ['session-missing-workflow/missing-workflow'],
  'session/stale-memory': ['session-stale-memory/stale-memory'],
  'session/duplicate-memory': ['session-duplicate-memory/duplicate-memory'],
  'session/consecutive-repeat': ['session-loop-detection/consecutive-repeat'],
  'session/cyclic-pattern': ['session-loop-detection/cyclic-pattern'],
  'session/memory-index-overflow': [
    'session-memory-index-overflow/line-overflow',
    'session-memory-index-overflow/byte-overflow',
  ],
  'session/shared-temp-path': ['session-shared-temp-path/shared-temp-path'],
  'session/unverified-gate-claimed-clean': [
    'session-unverified-gate-claimed-clean/unverified-gate-claimed-clean',
  ],
  'session/default-branch-accumulation': [
    'session-default-branch-accumulation/default-branch-accumulation',
  ],
  'session/unresolvable-sha': ['session-unresolvable-sha/unresolvable-sha'],
  'session/large-read': ['session-large-read/large-read'],
};

/**
 * Context-pillar ruleId mapping. Only the `ci` rules diverge: the catalog
 * publishes pillar-stable `ci/<slug>` IDs while the checks emit ruleIds
 * namespaced by check module. Every other context rule's catalog ID and
 * emitted ruleId are identical. Documented in CONTEXT_LINT_SPEC.md section 4
 * and pinned here (a reader grepping src/ for `ci/no-release-docs` finds
 * nothing and would otherwise conclude the catalog has drifted).
 */
const CI_IMPL_RULE_IDS: Record<string, string[]> = {
  'ci/no-release-docs': ['ci-coverage/no-release-docs'],
  'ci/undocumented-secret': ['ci-secrets/undocumented-secret'],
};

/** Catalog id -> emitted ruleIds, for every pillar. */
function implIdsFor(pillar: Pillar, catalogId: string): string[] {
  if (pillar === 'agent-session') return SESSION_IMPL_RULE_IDS[catalogId] ?? [];
  if (pillar === 'context') return CI_IMPL_RULE_IDS[catalogId] ?? [catalogId];
  return [catalogId];
}

describe('catalog rule ids map two-way onto emitted ruleIds', () => {
  it('every session catalog rule has a mapping entry (and no stale entries)', () => {
    const catalogIds = (readCatalog(meta('agent-session')).rules ?? []).map((r) => r.id).sort();
    expect(Object.keys(SESSION_IMPL_RULE_IDS).sort()).toEqual(catalogIds);
  });

  it('the ci mapping has no stale entries', () => {
    const catalogIds = new Set((readCatalog(meta('context')).rules ?? []).map((r) => r.id));
    for (const id of Object.keys(CI_IMPL_RULE_IDS)) {
      expect(catalogIds.has(id), `${id} missing from context-lint-rules.json`).toBe(true);
    }
  });

  for (const pillar of ['context', 'mcp-config', 'agent-session', 'agent-skill'] as const) {
    it(`${pillar}: catalog ids and emitted ruleIds are the same set (through the mapping)`, () => {
      const mapped = (readCatalog(meta(pillar)).rules ?? [])
        .flatMap((r) => implIdsFor(pillar, r.id))
        .sort();
      expect(
        emittedIds(pillar),
        'A ruleId is emitted but not published (or published but never emitted). Publish it ' +
          'under the emitted id, or document the correspondence in the mapping above and in ' +
          'the spec.',
      ).toEqual([...new Set(mapped)].sort());
    });
  }

  it('every session check module is listed in ALL_SESSION_CHECKS and dispatched', () => {
    // A check can be fully implemented, catalogued, mapped and unit-tested and
    // STILL never run: ALL_SESSION_CHECKS is what an audit iterates, and the
    // dispatch block in audit.ts is what actually calls it. Both were missed for
    // `session-shared-temp-path`, which shipped inert with a green suite --
    // nothing here compared the check modules against the runner.
    const modules = fs
      .readdirSync(path.join(CHECKS_DIR, 'session'))
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .map((n) => `session-${n.replace(/\.ts$/, '')}`);
    const auditSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'core', 'audit.ts'), 'utf-8');
    for (const name of modules) {
      expect(
        ALL_SESSION_CHECKS as readonly string[],
        `${name} missing from ALL_SESSION_CHECKS`,
      ).toContain(name);
      expect(auditSrc, `${name} is never dispatched in audit.ts`).toContain(`includes('${name}')`);
    }
  });
});

const RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

describe('catalog severity and fixable match the emit sites', () => {
  for (const pillar of ['context', 'mcp-config', 'agent-session', 'agent-skill'] as const) {
    describe(pillar, () => {
      for (const rule of readCatalog(meta(pillar)).rules ?? []) {
        const impl = new Set(implIdsFor(pillar, rule.id));
        const sites = SITES.filter((s) => s.pillar === pillar && impl.has(s.ruleId));
        if (sites.length === 0) continue; // reported by the two-way id test

        it(`${rule.id}: declared severities equal emitted severities`, () => {
          const emitted = new Set(sites.flatMap((s) => [...s.severities]));
          const declared = new Set(
            rule.severityByFormat
              ? Object.values(rule.severityByFormat)
              : rule.severityVariants
                ? rule.severityVariants.map((v) => v.severity)
                : [rule.severity],
          );
          expect(
            [...declared].sort(),
            `emit sites: ${sites.map((s) => `${s.where} (${[...s.severities].join('|')})`).join(', ')}`,
          ).toEqual([...emitted].sort());
          const max = [...emitted].sort((a, b) => RANK[b] - RANK[a])[0];
          expect(rule.severity, 'catalog severity must be the highest emitted').toBe(max);
        });

        it(`${rule.id}: fixable matches whether any emit site carries a fix`, () => {
          expect(rule.fixable).toBe(sites.some((s) => s.hasFix));
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// formats[] and clients[] against the scanner / parser.
// ---------------------------------------------------------------------------

function parseSource(rel: string): { sf: ts.SourceFile; nodes: ts.Node[] } {
  const full = path.join(REPO_ROOT, rel);
  const sf = ts.createSourceFile(
    full,
    fs.readFileSync(full, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return { sf, nodes: allNodes(sf) };
}

function stringArrayConst(rel: string, name: string): string[] {
  const { nodes } = parseSource(rel);
  const decl = nodes.find(
    (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name,
  );
  if (!decl?.initializer || !ts.isArrayLiteralExpression(decl.initializer)) {
    throw new Error(`${name} array literal not found in ${rel}`);
  }
  return decl.initializer.elements.filter(ts.isStringLiteral).map((e) => e.text);
}

describe('context formats[] match the scanner', () => {
  it('formats[].patterns is exactly CONTEXT_FILE_PATTERNS in src/core/scanner.ts', () => {
    const formats = readCatalog(meta('context')).formats as Array<{ patterns: string[] }>;
    const catalog = formats.flatMap((f) => f.patterns).sort();
    const scanned = stringArrayConst('src/core/scanner.ts', 'CONTEXT_FILE_PATTERNS').sort();
    expect(catalog).toEqual(scanned);
  });
});

describe('mcp-config clients[] match the parser and scanner', () => {
  const clients = readCatalog(meta('mcp-config')).clients as Array<{
    id: string;
    projectConfig: string | null;
    globalConfig: string | string[] | Record<string, string> | null;
  }>;
  const ids = clients.map((c) => c.id).sort();

  it('client ids equal the McpClient union in src/core/types.ts', () => {
    const { nodes } = parseSource('src/core/types.ts');
    const alias = nodes.find(
      (n): n is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(n) && n.name.text === 'McpClient',
    );
    if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error('McpClient union not found');
    const union = alias.type.types
      .filter(ts.isLiteralTypeNode)
      .map((t) => (t.literal as ts.StringLiteral).text)
      .sort();
    expect(ids).toEqual(union);
  });

  it('client ids equal the values detectClient can return (src/core/mcp-parser.ts)', () => {
    const { nodes } = parseSource('src/core/mcp-parser.ts');
    const fn = nodes.find(
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.text === 'detectClient',
    );
    if (!fn) throw new Error('detectClient not found');
    const returned = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression && ts.isStringLiteral(n.expression)) {
        returned.add(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    expect([...returned].sort()).toEqual(ids);
  });

  it('projectConfig values are exactly MCP_CONFIG_PATTERNS in src/core/scanner.ts', () => {
    const catalog = clients
      .map((c) => c.projectConfig)
      .filter((p): p is string => p !== null)
      .sort();
    expect(catalog).toEqual(stringArrayConst('src/core/scanner.ts', 'MCP_CONFIG_PATTERNS').sort());
  });

  /**
   * Clients whose global config `--mcp-global` does not read. Continue's
   * global config is YAML (~/.continue/config.yaml); the scanner reads JSON
   * only. MCP_CONFIG_LINT_SPEC.md section 1.3 says so.
   */
  const NOT_SCANNED_GLOBALLY = new Set(['continue']);

  it('every global config is read by scanGlobalMcpConfigs (except the documented exceptions)', () => {
    const { sf, nodes } = parseSource('src/core/scanner.ts');
    const fn = nodes.find(
      (n): n is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(n) && n.name?.text === 'scanGlobalMcpConfigs',
    );
    if (!fn) throw new Error('scanGlobalMcpConfigs not found');
    const text = fn.getText(sf);
    const scanned: string[] = [];
    for (const c of clients) {
      if (c.globalConfig === null) continue;
      const paths =
        typeof c.globalConfig === 'string'
          ? [c.globalConfig]
          : Array.isArray(c.globalConfig)
            ? c.globalConfig
            : Object.values(c.globalConfig);
      const all = paths.every((p) => {
        const base = p.split(/[\\/]/).pop() as string;
        return text.includes(`'${base}'`);
      });
      if (all) scanned.push(c.id);
    }
    const expected = clients
      .filter((c) => c.globalConfig !== null && !NOT_SCANNED_GLOBALLY.has(c.id))
      .map((c) => c.id);
    expect(scanned.sort()).toEqual(expected.sort());
  });
});

/**
 * README hand-maintained client/format counts. These aren't rewritten by the
 * prose generator (it only handles rule counts), so gate them here: the
 * family-table "across N clients" figures and the catalog-list "N supported
 * format definitions" bullet must match the catalogs' formats/clients arrays.
 */
describe('README client/format counts match the catalogs', () => {
  function readmeRowClientCount(label: string): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `\\*\\*[^*]*${escaped}[^*]*\\*\\*[^\\n]*?across\\s+(\\d+)\\s+clients`,
      'i',
    );
    const m = README.match(re);
    return m ? Number(m[1]) : null;
  }

  it('context family-table row "across N clients" matches formats[] length', () => {
    const m = meta('context');
    const formats = readCatalog(m).formats;
    expect(Array.isArray(formats)).toBe(true);
    expect(readmeRowClientCount(m.label)).toBe((formats as unknown[]).length);
  });

  it('mcp-config family-table row "across N clients" matches clients[] length', () => {
    const m = meta('mcp-config');
    const clients = readCatalog(m).clients;
    expect(Array.isArray(clients)).toBe(true);
    expect(readmeRowClientCount(m.label)).toBe((clients as unknown[]).length);
  });

  it('"N supported format definitions" bullet matches the context formats[] length', () => {
    const formats = readCatalog(meta('context')).formats as unknown[];
    const m = README.match(/(\d+)\s+supported format definitions/i);
    expect(m, 'no "N supported format definitions" phrase found in README').not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1])).toBe(formats.length);
  });
});
