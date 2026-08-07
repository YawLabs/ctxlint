import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CATALOGS, REPO_ROOT, readCatalog, ruleCount } from '../catalog-meta.js';
// The prose generator (build.mjs's source of truth) keeps its OWN duplicate
// CATALOGS list. Import it here so drift between the two hand-maintained lists
// fails CI. It is plain .mjs (no TS) so build.mjs can call it without a compile
// step; vitest loads the .mjs directly here.
// @ts-expect-error generate-catalog-prose.mjs is plain JS with no type declarations
import { CATALOGS as PROSE_CATALOGS } from '../../../scripts/generate-catalog-prose.mjs';

/**
 * Guards against rule-count drift: the prose count headers in each spec and the
 * README "Specifications" family table must agree with the catalog's actual
 * `.rules.length`. Catalogs are the machine-readable source of truth; prose is
 * generated/verified from them (see build.mjs generate-from-catalog step).
 */

const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');

/**
 * Pull the "<N> rules ..." count from a spec body. Specs phrase this as either
 * "N rules organized into M categories" or "N rules in 1 category (...)".
 * Returns null if no such header is found.
 */
function specRuleCount(specBody: string): number | null {
  const m = specBody.match(/\b(\d+)\s+rules?\s+(?:organized into|in)\b/i);
  return m ? Number(m[1]) : null;
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
  for (const meta of CATALOGS) {
    describe(meta.key, () => {
      const count = ruleCount(meta);

      it('catalog has at least one rule', () => {
        expect(count).toBeGreaterThan(0);
      });

      if (meta.spec) {
        it(`${meta.spec} header count matches catalog (${count})`, () => {
          const body = fs.readFileSync(path.join(REPO_ROOT, meta.spec as string), 'utf-8');
          const stated = specRuleCount(body);
          expect(stated, `no "<N> rules" header found in ${meta.spec}`).not.toBeNull();
          expect(stated).toBe(count);
        });
      }

      it(`README family-table count matches catalog (${count})`, () => {
        const stated = readmeTableCount(meta.label);
        expect(
          stated,
          `no README "Specifications" row matched label "${meta.label}"`,
        ).not.toBeNull();
        expect(stated).toBe(count);
      });
    });
  }
});

/**
 * Guards against drift between the two hand-maintained catalog lists: the TS
 * `CATALOGS` in catalog-meta.ts and the duplicate `CATALOGS` in
 * scripts/generate-catalog-prose.mjs (which build.mjs reads via computeTargets).
 * The shared shape is the catalog/spec/label triple; the .mjs list omits the
 * TS-only `key` / `ruleIdFormat` fields, so only the triples are compared.
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

/**
 * Session-pillar ruleId mapping. The catalog publishes pillar-stable
 * `session/<slug>` IDs; the reference implementation namespaces emitted
 * ruleIds by check module (`<check>/<slug>`) and splits memory-index-overflow
 * into one slug per cap dimension. This map IS the published correspondence
 * (documented in AGENT_SESSION_LINT_SPEC.md section 3); the tests below pin
 * it against both the catalog and the ruleId literals in the implementation,
 * so neither side can drift without failing CI.
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
};

describe('session catalog ids map onto implementation ruleIds', () => {
  const sessionMeta = CATALOGS.find((m) => m.key === 'agent-session');
  if (!sessionMeta) throw new Error('agent-session catalog meta missing');

  it('every catalog session rule has a mapping entry (and no stale entries)', () => {
    const catalogIds = (readCatalog(sessionMeta).rules ?? []).map((r) => r.id).sort();
    expect(Object.keys(SESSION_IMPL_RULE_IDS).sort()).toEqual(catalogIds);
  });

  it('mapped impl ruleIds are exactly the ruleId literals in src/core/checks/session/', () => {
    const checksDir = path.join(REPO_ROOT, 'src', 'core', 'checks', 'session');
    const emitted = new Set<string>();
    for (const name of fs.readdirSync(checksDir)) {
      if (!name.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(checksDir, name), 'utf-8');
      for (const m of src.matchAll(/ruleId:\s*'([^']+)'/g)) emitted.add(m[1]);
    }
    const mapped = Object.values(SESSION_IMPL_RULE_IDS).flat().sort();
    expect([...emitted].sort()).toEqual(mapped);
  });
});

/**
 * Context-pillar ruleId mapping. Only the `ci` rules diverge: the catalog
 * publishes pillar-stable `ci/<slug>` IDs while the checks emit ruleIds
 * namespaced by check module. Every other context rule's catalog ID and
 * emitted ruleId are identical.
 *
 * This mirrors SESSION_IMPL_RULE_IDS above. The session pillar documented and
 * pinned its correspondence; the ci pair had the same two-level scheme with
 * neither, described only as a "legacy" prefix exception in CONTRIBUTING.md.
 * That asymmetry is actively misleading -- a reader greps for
 * `ci/no-release-docs` in src/, finds nothing, and concludes the catalog has
 * drifted. It is now documented in CONTEXT_LINT_SPEC.md section 4 and pinned
 * here.
 */
const CI_IMPL_RULE_IDS: Record<string, string> = {
  'ci/no-release-docs': 'ci-coverage/no-release-docs',
  'ci/undocumented-secret': 'ci-secrets/undocumented-secret',
};

describe('context catalog ids map onto implementation ruleIds', () => {
  const contextMeta = CATALOGS.find((m) => m.key === 'context');
  if (!contextMeta) throw new Error('context catalog meta missing');

  /** Every `ruleId: '...'` literal in the context-pillar checks. */
  function emittedContextRuleIds(): Set<string> {
    const emitted = new Set<string>();
    const skip = new Set(['__tests__', 'session', 'mcp']);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(full, 'utf-8');
        for (const m of src.matchAll(/ruleId:\s*'([^']+)'/g)) emitted.add(m[1]);
      }
    };
    walk(path.join(REPO_ROOT, 'src', 'core', 'checks'));
    return emitted;
  }

  it('the ci mapping has no stale entries and both sides still exist', () => {
    const catalogIds = new Set((readCatalog(contextMeta).rules ?? []).map((r) => r.id));
    const emitted = emittedContextRuleIds();
    for (const [catalogId, emittedId] of Object.entries(CI_IMPL_RULE_IDS)) {
      expect(catalogIds.has(catalogId), `${catalogId} missing from context-lint-rules.json`).toBe(
        true,
      );
      expect(emitted.has(emittedId), `${emittedId} is no longer emitted by any check`).toBe(true);
    }
  });

  it('ci is the ONLY context rule whose emitted ruleId differs from its catalog id', () => {
    // Guards the claim CONTEXT_LINT_SPEC.md section 4 makes. A new check that
    // namespaces its ruleId without documenting the correspondence fails here.
    //
    // skill/* ids are emitted from src/core/checks/skills.ts but belong to the
    // agent-skill catalog, so they are matched against that one -- they are a
    // different pillar sharing a directory, not a divergence.
    const contextIds = new Set((readCatalog(contextMeta).rules ?? []).map((r) => r.id));
    const skillMeta = CATALOGS.find((m) => m.key === 'agent-skill');
    if (!skillMeta) throw new Error('agent-skill catalog meta missing');
    const skillIds = new Set((readCatalog(skillMeta).rules ?? []).map((r) => r.id));

    const known = new Set(Object.values(CI_IMPL_RULE_IDS));
    const undocumented = [...emittedContextRuleIds()]
      .filter((id) => !contextIds.has(id) && !skillIds.has(id) && !known.has(id))
      .sort();

    expect(
      undocumented,
      'These ruleIds are emitted but are neither published under the same id nor listed in ' +
        'CI_IMPL_RULE_IDS. Either publish them under the emitted id, or add the correspondence ' +
        'here and to CONTEXT_LINT_SPEC.md section 4.',
    ).toEqual([]);
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
    const meta = CATALOGS.find((m) => m.key === 'context');
    if (!meta) throw new Error('context catalog meta missing');
    const formats = readCatalog(meta).formats;
    expect(Array.isArray(formats)).toBe(true);
    expect(readmeRowClientCount(meta.label)).toBe((formats as unknown[]).length);
  });

  it('mcp-config family-table row "across N clients" matches clients[] length', () => {
    const meta = CATALOGS.find((m) => m.key === 'mcp-config');
    if (!meta) throw new Error('mcp-config catalog meta missing');
    const clients = readCatalog(meta).clients;
    expect(Array.isArray(clients)).toBe(true);
    expect(readmeRowClientCount(meta.label)).toBe((clients as unknown[]).length);
  });

  it('"N supported format definitions" bullet matches the context formats[] length', () => {
    const meta = CATALOGS.find((m) => m.key === 'context');
    if (!meta) throw new Error('context catalog meta missing');
    const formats = readCatalog(meta).formats as unknown[];
    const m = README.match(/(\d+)\s+supported format definitions/i);
    expect(m, 'no "N supported format definitions" phrase found in README').not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1])).toBe(formats.length);
  });
});
