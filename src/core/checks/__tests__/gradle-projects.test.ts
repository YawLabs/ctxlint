import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import {
  findGradleBuildRoot,
  gradleProjectRefs,
  matchGradleName,
  parseSettings,
  readGradleProjectSet,
  shellWords,
  unresolvedGradleProject,
} from '../gradle-projects.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const RULE = 'commands/gradle-project-not-found';

function paths(source: string): string[] | null {
  const set = parseSettings(source);
  return set ? [...set.paths].sort() : null;
}

describe('parseSettings — what adds a project', () => {
  it('reads Groovy command-form includes across lines, with implicit parents', () => {
    const src = `rootProject.name = 'kafka'
include 'clients',
    'connect:api',
    'core'
include 'streams:test-utils'`;
    expect(paths(src)).toEqual([
      ':clients',
      ':connect',
      ':connect:api',
      ':core',
      ':streams',
      ':streams:test-utils',
    ]);
  });

  it('reads Kotlin calls, trailing commas, listOf spreads and a leading colon', () => {
    const src = `include(":a")
include(
    "b:c",
    "d",
)
include(*listOf("e", "f").toTypedArray())`;
    // `.toTypedArray()` after the listOf is a continuation, so that include is not literal.
    expect(paths(src)).toBeNull();
    expect(paths(`include(":a")\ninclude(\n  "b:c",\n  "d",\n)\ninclude(*arrayOf("e"))`)).toEqual([
      ':a',
      ':b',
      ':b:c',
      ':d',
      ':e',
    ]);
  });

  it('treats includeFlat names as whole root-level names', () => {
    expect(paths(`includeFlat 'sibling'`)).toEqual([':sibling']);
  });

  it('flattens conditional includes into a superset', () => {
    const src = `if (System.getenv('GITHUB_WORKFLOW') == null) {
  include 'provider:lein'
}`;
    expect(paths(src)).toEqual([':provider', ':provider:lein']);
  });

  it('records included builds by directory name, plus a literal name override', () => {
    const set = parseSettings(`pluginManagement {
  includeBuild 'api-checker'
}
includeBuild("../tooling/build-logic") { name = "logic" }
includeBuild(file("platform"))`);
    expect(set && [...set.builds].sort()).toEqual([
      'api-checker',
      'build-logic',
      'logic',
      'platform',
    ]);
  });

  it('keeps both the old and the new path of a literal rename, descendants included', () => {
    const src = `include 'storage:api', 'storage:api:impl'
project(':storage:api').name = 'storage-api'`;
    expect(paths(src)).toEqual([
      ':storage',
      ':storage:api',
      ':storage:api:impl',
      ':storage:storage-api',
      ':storage:storage-api:impl',
    ]);
  });

  it('reads a Groovy command-form setName rename and includes through any receiver', () => {
    expect(paths(`include 'old'\nproject(':old').setName 'renamed'`)).toEqual([':old', ':renamed']);
    expect(paths(`this.include 'x'\nsettings.include('y')`)).toEqual([':x', ':y']);
  });

  it('reads a setName override on an included build', () => {
    expect([...(parseSettings(`includeBuild('x') { setName('y') }`)?.builds ?? [])]).toEqual([
      'x',
      'y',
    ]);
  });

  it('ignores commented-out includes and single-quoted dollars', () => {
    expect(paths(`// include 'gone'\n/* include 'also-gone' */\ninclude 'cost$'`)).toEqual([
      ':cost$',
    ]);
  });

  it('stays closed through the settings DSL that cannot add projects', () => {
    const src = `pluginManagement {
  repositories { maven { name = 'internal'; url = 'https://repo' } }
  plugins { id 'org.jetbrains.kotlin.jvm' version '2.0.0' }
}
plugins {
  id 'com.gradle.develocity' version '3.19'
  id 'org.jetbrains.kotlin.jvm' version '2.0.0' apply false
}
def ci = System.getenv('CI') != null
System.setProperty('x', 'y')
develocity { buildScan { if (ci) { tag "CI" } } }
rootProject.name = 'app'
project(':app').projectDir = file('application')
if (ci) apply plugin: 'com.gradle.develocity'
include 'app'`;
    expect(paths(src)).toEqual([':app']);
  });
});

describe('parseSettings — what makes the set open', () => {
  const open: Array<[string, string]> = [
    ['a variable include', `def name = 'x'\ninclude name`],
    ['an interpolated include', `include ":lib-\${flavor}"`],
    ['an include in a loop', `file('modules').listFiles().each { include it.name }`],
    ['apply from', `apply from: 'gradle/projects.gradle'\ninclude 'a'`],
    ['a repo-local settings plugin', `plugins { id 'my.settings-conventions' }\ninclude 'a'`],
    ['a catalog alias plugin', `plugins { alias(libs.plugins.conventions) }`],
    ['a Kotlin shorthand plugin', `plugins { kotlin("jvm") }`],
    ['an unvetted apply plugin', `apply plugin: 'org.gradlex.java-module-dependencies'`],
    ['a buildscript classpath', `buildscript { dependencies { classpath 'g:a:1' } }\ninclude 'a'`],
    ['a settingsEvaluated hook', `gradle.settingsEvaluated { include 'a' }`],
    ['Groovy dynamic dispatch', `settings.'include'('a')`],
    ['invokeMethod', `settings.invokeMethod('include', 'a')`],
    ['a non-literal rename', `project(':a').name = "x-\${suffix}"`],
    ['a rename through children', `rootProject.children.each { it.name = 'x' }`],
    ['a bare rename inside a project block', `project(':a') {\n  name = 'b'\n}`],
    ['a non-literal included build', `includeBuild(buildDir)`],
    ['code loading', `evaluate(new File('more.gradle'))`],
    ['an unterminated string', `include 'a`],
    [
      'a compound rename in a loop',
      `include 'core'\nrootProject.children.each { it.name += '-lib' }`,
    ],
    ['a subscript rename', `include 'old'\nproject(':old')['name'] = 'renamed'`],
    ['a rename through with()', `include 'a'\nwith(project(':a')) { name = 'b' }`],
    [
      'a multi-line scope-function rename',
      `include 'a'\nproject(':a')\n  .run {\n    name = 'b'\n  }`,
    ],
    [
      'a classpath added through add()',
      `buildscript { dependencies { add('classpath', 'g:a:1') } }`,
    ],
    [
      'apply plugin with a from: script',
      `apply plugin: 'com.gradle.develocity', from: 'more.gradle'`,
    ],
    ['an applied plugin after a `;`', `plugins { id 'my.conventions'; id 'other' apply false }`],
    ['a Groovy slashy string', `def re = /it's/\ninclude 'a'`],
    ['a non-literal included-build name', `includeBuild('x') { name = "n-\${v}" }`],
  ];
  for (const [what, src] of open) {
    it(`is open on ${what}`, () => {
      expect(parseSettings(src)).toBeNull();
    });
  }
});

describe('matchGradleName (port of Gradle NameMatcher)', () => {
  const projects = ['server', 'server-core', 'serverCore', 'client', 'my-awesome-library', 'api'];

  it('returns an exact match first', () => {
    expect(matchGradleName('server', projects)).toBe('server');
  });

  it('accepts a unique case-insensitive or prefix match', () => {
    expect(matchGradleName('CLIENT', projects)).toBe('client');
    expect(matchGradleName('cli', projects)).toBe('client');
    expect(matchGradleName('my-awe', projects)).toBe('my-awesome-library');
  });

  it('accepts kebab-case abbreviations', () => {
    expect(matchGradleName('mAL', projects)).toBe('my-awesome-library');
  });

  it('reports a camel abbreviation matching a camel and a kebab project as ambiguous', () => {
    expect(matchGradleName('sC', projects)).toBe('ambiguous');
  });

  it('prefers a lowercase camel match over wider prefix matches, as Gradle does', () => {
    // `server-core` and `serverCore` also start with `ser`, but the camel
    // bucket (`ser` + lowercase letters) wins before prefixes are considered.
    expect(matchGradleName('ser', projects)).toBe('server');
  });

  it('reports a prefix shared by several projects as ambiguous', () => {
    expect(matchGradleName('cl', ['client', 'clients'])).toBe('ambiguous');
  });

  it('accepts matches only the kebab-prefix or case-insensitive camel bucket finds', () => {
    expect(matchGradleName('mA', ['my-awesome-library'])).toBe('my-awesome-library');
    expect(matchGradleName('Server', ['serverCore'])).toBe('serverCore');
  });

  it('returns null only when nothing matches at all', () => {
    expect(matchGradleName('sever', projects)).toBeNull();
    expect(matchGradleName('apix', projects)).toBeNull();
  });
});

describe('gradleProjectRefs', () => {
  it('returns null for anything that is not a Gradle invocation', () => {
    expect(gradleProjectRefs('npm test')).toBeNull();
    expect(gradleProjectRefs('gradle.properties')).toBeNull();
    expect(gradleProjectRefs('../../gradlew :a:test')).toBeNull();
  });

  it('extracts absolute and relative project paths, dropping the task', () => {
    expect(gradleProjectRefs('./gradlew :x-pack:plugin:esql:test clients:api:jar check')).toEqual([
      { token: ':x-pack:plugin:esql:test', segments: ['x-pack', 'plugin', 'esql'], absolute: true },
      { token: 'clients:api:jar', segments: ['clients', 'api'], absolute: false },
    ]);
  });

  it('unquotes, and ignores root-project tasks and bare task names', () => {
    expect(gradleProjectRefs('gradlew.bat ":rest-api-spec:yamlRestTest" :help test')).toEqual([
      { token: ':rest-api-spec:yamlRestTest', segments: ['rest-api-spec'], absolute: true },
    ]);
  });

  it('skips the values of build options and task options, even when they contain a colon', () => {
    expect(
      gradleProjectRefs(
        './gradlew -x :a:javadoc -Dfoo=a:b --console plain dependencyInsight --dependency org.x:y :b:check',
      ),
    ).toEqual([{ token: ':b:check', segments: ['b'], absolute: true }]);
  });

  it('bails on every option that retargets the build, in every spelling', () => {
    const spellings = [
      '-p core',
      '-pcore',
      '--project-dir core',
      '--project-dir=core',
      '-c s.gradle',
      '-cs.gradle',
      '--settings-file s.gradle',
      '--settings-file=s.gradle',
      '-b b.gradle',
      '-bb.gradle',
      '--build-file b.gradle',
      '--build-file=b.gradle',
      '--include-build ../x',
      '--include-build=../x',
      '-I i.gradle',
      '-Ii.gradle',
      '--init-script i.gradle',
      '--init-script=i.gradle',
    ];
    for (const opt of spellings) {
      expect(gradleProjectRefs(`./gradlew ${opt} :a:check`), opt).toBeNull();
    }
  });

  it('keeps an attached short value inside its own token', () => {
    expect(gradleProjectRefs('./gradlew -xjavadoc -Pflavor=free -Dk=v :a:check')).toEqual([
      { token: ':a:check', segments: ['a'], absolute: true },
    ]);
  });

  it('bails on a trailing line continuation', () => {
    expect(gradleProjectRefs('./gradlew :a:check \\')).toBeNull();
  });

  it('skips placeholders, marked or not', () => {
    expect(
      gradleProjectRefs('./gradlew :<module>:test :module-name:jvmTest :my-feature-impl:test'),
    ).toEqual([]);
    // A `<placeholder>` is not an input redirection: words after it still count.
    expect(gradleProjectRefs('./gradlew :ignite-<module>:test :core:check')).toEqual([
      { token: ':core:check', segments: ['core'], absolute: true },
    ]);
  });

  it('stops at a comment or a control operator', () => {
    expect(gradleProjectRefs('./gradlew :a:test   # runs :b:test too')).toHaveLength(1);
    expect(gradleProjectRefs('./gradlew :a:test && ./gradlew :b:test')).toHaveLength(1);
  });
});

describe('shellWords', () => {
  it('returns null on an unterminated quote', () => {
    expect(shellWords('./gradlew ":a:test')).toBeNull();
  });
});

describe('unresolvedGradleProject', () => {
  const set = {
    paths: new Set([':server', ':server:api', ':web-client']),
    builds: new Set(['build-logic', 'buildSrc']),
    settingsFile: 'settings.gradle',
  };
  const ref = (p: string) => gradleProjectRefs(`./gradlew ${p}`)?.[0] as never;

  it('resolves nested paths and abbreviations', () => {
    expect(unresolvedGradleProject(ref(':server:api:test'), set)).toBeNull();
    expect(unresolvedGradleProject(ref(':ser:a:test'), set)).toBeNull();
    expect(unresolvedGradleProject(ref(':wC:assemble'), set)).toBeNull();
  });

  it('names the first segment that matches nothing, with its parent path', () => {
    expect(unresolvedGradleProject(ref(':sever:test'), set)).toBe(':sever');
    expect(unresolvedGradleProject(ref(':server:apix:test'), set)).toBe(':server:apix');
  });

  it('stops at an included build or buildSrc', () => {
    expect(unresolvedGradleProject(ref(':build-logic:nope:check'), set)).toBeNull();
    expect(unresolvedGradleProject(ref(':buildSrc:jar'), set)).toBeNull();
  });

  it('stays silent on an ambiguous segment, first or nested', () => {
    const ambiguous = {
      paths: new Set([':server', ':server:api', ':service', ':service:api', ':service:apps']),
      builds: new Set<string>(),
      settingsFile: 'settings.gradle',
    };
    expect(unresolvedGradleProject(ref(':se:api:test'), ambiguous)).toBeNull();
    expect(unresolvedGradleProject(ref(':service:ap:test'), ambiguous)).toBeNull();
  });
});

describe('build root and settings discovery', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-gradle-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, content: string) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('uses the nearest settings file at or above the context file, within the project', () => {
    write('settings.gradle', `include 'a'`);
    write('examples/demo/settings.gradle.kts', `include("demo-app")`);
    write('examples/demo/CLAUDE.md', '');
    write('docs/AGENTS.md', '');
    expect(findGradleBuildRoot(path.join(tmp, 'examples/demo/CLAUDE.md'), tmp)).toBe(
      path.join(tmp, 'examples/demo'),
    );
    expect(findGradleBuildRoot(path.join(tmp, 'docs/AGENTS.md'), tmp)).toBe(tmp);
  });

  it('adds buildSrc only when it looks like a build', () => {
    write('settings.gradle', `include 'a'`);
    fs.mkdirSync(path.join(tmp, 'buildSrc'));
    expect(readGradleProjectSet(tmp)?.builds.has('buildSrc')).toBe(false);
    write('buildSrc/build.gradle.kts', '');
    expect(readGradleProjectSet(tmp)?.builds.has('buildSrc')).toBe(true);
  });

  it('is unreadable when the settings file is UTF-16', () => {
    fs.writeFileSync(path.join(tmp, 'settings.gradle'), Buffer.from(`include 'core'`, 'utf16le'));
    expect(readGradleProjectSet(tmp)).toBeNull();
  });

  it('is unreadable with both a Groovy and a Kotlin settings file', () => {
    write('settings.gradle', `include 'a'`);
    write('settings.gradle.kts', `include("a")`);
    expect(readGradleProjectSet(tmp)).toBeNull();
  });

  it('adds builds included by included builds, which Gradle addresses from the root', () => {
    write('settings.gradle', `include 'app'\nincludeBuild 'build-a'`);
    write('build-a/settings.gradle', `includeBuild '../build-b'`);
    write('build-b/settings.gradle.kts', `includeBuild("tools") { name = "tooling" }`);
    expect([...(readGradleProjectSet(tmp)?.builds ?? [])].sort()).toEqual([
      'build-a',
      'build-b',
      'tooling',
      'tools',
    ]);
  });

  it('is unreadable when an included build’s own settings are open', () => {
    write('settings.gradle', `include 'app'\npluginManagement { includeBuild 'build-logic' }`);
    write('build-logic/settings.gradle', `file('.').eachDir { includeBuild it }`);
    expect(readGradleProjectSet(tmp)).toBeNull();
  });

  it('requires the wrapper next to the settings file for ./gradlew', () => {
    write('settings.gradle', `include 'a'`);
    write('build-logic/settings.gradle', `include 'conventions'`);
    write('build-logic/AGENTS.md', '');
    const nested = path.join(tmp, 'build-logic/AGENTS.md');
    expect(findGradleBuildRoot(nested, tmp, true)).toBeNull();
    expect(findGradleBuildRoot(nested, tmp, false)).toBe(path.join(tmp, 'build-logic'));
  });
});

describe('checkCommands — commands/gradle-project-not-found', () => {
  let tmp: string;
  beforeEach(() => {
    resetPackageJsonCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-gradle-cmd-'));
  });
  afterEach(() => {
    resetPackageJsonCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function lint(files: Record<string, string>, contextFile = 'AGENTS.md') {
    // `./gradlew` is only checked where the wrapper exists.
    for (const [rel, content] of Object.entries({ gradlew: '', ...files })) {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const parsed = parseContextFile({
      absolutePath: path.join(tmp, contextFile),
      relativePath: contextFile,
      isSymlink: false,
      type: 'context',
    });
    return (await checkCommands(parsed, tmp)).filter((i) => i.ruleId === RULE);
  }

  it('flags the fixture typo and nothing else', async () => {
    const root = path.join(FIXTURES, 'gradle-project-refs');
    const parsed = parseContextFile({
      absolutePath: path.join(root, 'AGENTS.md'),
      relativePath: 'AGENTS.md',
      isSymlink: false,
      type: 'context',
    });
    const found = (await checkCommands(parsed, root)).filter((i) => i.ruleId === RULE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', line: 9 });
    expect(found[0].message).toBe(
      '"./gradlew :sever:test" — project ":sever" not found in settings.gradle.kts',
    );
    expect(found[0].suggestion).toBe('Did you mean ":server"?');
  });

  it('checks shell fences and $ prompts as well as inline code', async () => {
    const found = await lint({
      'settings.gradle': `include 'core'`,
      'AGENTS.md': '```bash\n./gradlew :cor3:test\n```\n\n$ gradle :kore:build\n',
    });
    expect(found.map((i) => i.line)).toEqual([2, 5]);
  });

  it('is silent when the settings file is not statically enumerable', async () => {
    const found = await lint({
      'settings.gradle': `plugins { id 'my.conventions' }\ninclude 'core'`,
      'AGENTS.md': '`./gradlew :nope:test`\n',
    });
    expect(found).toEqual([]);
  });

  it('is silent without a settings file', async () => {
    expect(await lint({ 'AGENTS.md': '`./gradlew :nope:test`\n' })).toEqual([]);
  });

  it('skips a command after a cd earlier in the same fence', async () => {
    const found = await lint({
      'settings.gradle': `include 'core'`,
      'AGENTS.md':
        '```bash\ncd tools/other-build\n./gradlew :nope:test\n```\n\n```bash\n./gradlew :nope:test\n```\n',
    });
    expect(found.map((i) => i.line)).toEqual([7]);
  });

  it('checks relative paths only from a context file in the build root', async () => {
    const files = {
      'settings.gradle': `include 'core'`,
      'AGENTS.md': '`./gradlew nope:test`\n',
      'docs/AGENTS.md': '`./gradlew nope:test` and `./gradlew :nope:test`\n',
    };
    expect(await lint(files)).toHaveLength(1);
    const nested = await lint(files, 'docs/AGENTS.md');
    expect(nested.map((i) => i.message)).toEqual([
      '"./gradlew :nope:test" — project ":nope" not found in settings.gradle',
    ]);
  });

  it('respects a prose prohibition like every other resolvability rule', async () => {
    const found = await lint({
      'settings.gradle': `include 'core'`,
      'AGENTS.md': 'Never run `./gradlew :legacy:publish` from a laptop.\n',
    });
    expect(found).toEqual([]);
  });

  it('skips a command after a cd in a run of $ prompt lines', async () => {
    const found = await lint({
      'settings.gradle': `include 'core'`,
      'AGENTS.md': '$ cd other-build\n$ ./gradlew :nope:test\n\nThen:\n\n$ ./gradlew :nope:test\n',
    });
    expect(found.map((i) => i.line)).toEqual([6]);
  });

  it('is silent for ./gradlew in a nested build that has no wrapper', async () => {
    const found = await lint(
      {
        'settings.gradle': `include 'core'`,
        'build-logic/settings.gradle': `include 'conventions'`,
        'build-logic/AGENTS.md': '`./gradlew :core:test`\n',
      },
      'build-logic/AGENTS.md',
    );
    expect(found).toEqual([]);
  });

  it('does not make exit-status-masked fire on a JVM command', async () => {
    const parsedFiles = {
      'settings.gradle': `include 'core'`,
      'AGENTS.md':
        '```bash\n./gradlew :core:test || true\n./gradlew test | tail -5 && echo "tests ok"\n```\n',
    };
    for (const [rel, content] of Object.entries(parsedFiles)) {
      fs.writeFileSync(path.join(tmp, rel), content);
    }
    const parsed = parseContextFile({
      absolutePath: path.join(tmp, 'AGENTS.md'),
      relativePath: 'AGENTS.md',
      isSymlink: false,
      type: 'context',
    });
    expect(await checkCommands(parsed, tmp)).toEqual([]);
  });

  it('now lets exit-status-masked see a verifier chained AFTER a JVM command', async () => {
    // Before extraction widened, this whole line was invisible. The masked
    // `tsc | tail` is a real defect, so the new finding is correct -- but it is
    // the one existing rule whose output the widening changes.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '5' } }),
    );
    fs.writeFileSync(
      path.join(tmp, 'AGENTS.md'),
      '```bash\n./gradlew assemble && npx tsc --noEmit | tail -3 && echo "types ok"\n```\n',
    );
    const parsed = parseContextFile({
      absolutePath: path.join(tmp, 'AGENTS.md'),
      relativePath: 'AGENTS.md',
      isSymlink: false,
      type: 'context',
    });
    const ids = (await checkCommands(parsed, tmp)).map((i) => i.ruleId);
    expect(ids).toEqual(['commands/exit-status-masked']);
  });
});
