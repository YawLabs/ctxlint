import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import {
  mavenSelectors,
  parsePom,
  readMavenReactor,
  selectorMatches,
  templateMatches,
} from '../maven-modules.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const RULE = 'commands/maven-module-not-found';

const pom = (inner: string) =>
  `<?xml version="1.0"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n${inner}\n</project>`;

describe('parsePom', () => {
  it('reads the project id, inheriting groupId from the parent', () => {
    expect(
      parsePom(
        pom(`<parent><groupId>org.x</groupId><artifactId>parent</artifactId></parent>
<artifactId>core</artifactId>
<dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies>`),
      ),
    ).toEqual({ artifactId: 'core', groupId: 'org.x', modules: [] });
  });

  it('collects modules from the project and every profile, and Maven 4 subprojects', () => {
    const model = parsePom(
      pom(`<artifactId>root</artifactId>
<modules><module>a</module><module>nested/b</module></modules>
<!-- <modules><module>commented</module></modules> -->
<subprojects><subproject>c</subproject></subprojects>
<profiles><profile><id>x</id><modules><module>d</module></modules></profile></profiles>
<build><plugins><plugin><configuration><modules><module>not-a-module</module></modules></configuration></plugin></plugins></build>`),
    );
    expect(model?.modules).toEqual(['a', 'nested/b', 'c', 'd']);
  });

  it('is unreadable when a module path uses a property', () => {
    expect(parsePom(pom('<modules><module>flink-${scala}</module></modules>'))).toBeNull();
  });

  it('is unreadable on Maven 4 automatic subproject discovery: an aggregator with no list', () => {
    const v410 = (inner: string) =>
      `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.1.0</modelVersion>${inner}</project>`;
    expect(parsePom(v410('<packaging>pom</packaging>'))).toBeNull();
    // A module list inside a profile does not switch discovery off.
    expect(
      parsePom(
        v410(
          '<packaging>pom</packaging><profiles><profile><modules><module>a</module></modules></profile></profiles>',
        ),
      ),
    ).toBeNull();
    // The model version may come from the namespace alone (`mvnup` output).
    expect(
      parsePom(
        '<project xmlns="http://maven.apache.org/POM/4.1.0"><packaging>pom</packaging></project>',
      ),
    ).toBeNull();
    // A declared list, even an empty one, and a jar module are both readable.
    expect(
      parsePom(
        v410('<packaging>pom</packaging><subprojects><subproject>a</subproject></subprojects>'),
      ),
    ).not.toBeNull();
    expect(parsePom(v410('<packaging>pom</packaging><subprojects/>'))).not.toBeNull();
    expect(parsePom(v410('<artifactId>leaf</artifactId>'))).not.toBeNull();
    // A 4.0.0 parent POM with no modules is an ordinary parent.
    expect(
      parsePom(pom('<modelVersion>4.0.0</modelVersion><packaging>pom</packaging>')),
    ).not.toBeNull();
  });

  it('skips quoted attribute values and decodes numeric character references', () => {
    expect(
      parsePom(
        pom(
          '<artifactId>core&#45;api</artifactId><build><plugins><plugin><configuration><x expr="a > b"/></configuration></plugin></plugins></build><modules><module>core</module></modules>',
        ),
      ),
    ).toEqual({ artifactId: 'core-api', groupId: null, modules: ['core'] });
  });

  it('is unreadable when the element tree does not balance', () => {
    expect(parsePom(pom('<modules><module>a</modules></module>'))).toBeNull();
    expect(parsePom('<project><modules><module>a</module>')).toBeNull();
  });
});

describe('mavenSelectors', () => {
  it('returns null for anything that is not a Maven invocation', () => {
    expect(mavenSelectors('mvnd -pl a test')).toBeNull();
    expect(mavenSelectors('gradle build')).toBeNull();
  });

  it('splits -pl lists, strips exclusion prefixes and skips optional selectors and placeholders', () => {
    expect(
      mavenSelectors('./mvnw clean -pl a,!b,-c,+d,?e,<module>,{module} -rf :f -am install')?.map(
        (s) => `${s.option} ${s.selector}`,
      ),
    ).toEqual(['-pl a', '-pl b', '-pl c', '-pl d', '-rf :f']);
  });

  it('reads --projects=, and skips the values of other options', () => {
    expect(
      mavenSelectors('mvn -D skip=true -P it -T 4 --projects=core,web verify')?.map(
        (s) => s.selector,
      ),
    ).toEqual(['core', 'web']);
  });

  it('skips id-shaped placeholders and bails on a line continuation', () => {
    expect(
      mavenSelectors('mvn -pl :module,com.example:my-module,:real -rf :module-name test'),
    ).toEqual([{ selector: ':real', option: '-pl' }]);
    expect(mavenSelectors('./mvnw -pl \\')).toBeNull();
    expect(mavenSelectors('mvnw.cmd -pl core ^')).toBeNull();
    expect(mavenSelectors('mvn -pl %MODULE%,[module],path/to/module test')).toEqual([]);
  });

  it('bails when the command re-roots or shrinks the reactor', () => {
    for (const opt of [
      '-f other/pom.xml',
      '--file=other',
      '-fother/pom.xml',
      '-N',
      '--non-recursive',
    ]) {
      expect(mavenSelectors(`mvn ${opt} -pl a test`)).toBeNull();
    }
    expect(mavenSelectors('mvn -fae -pl a test')).toHaveLength(1);
  });
});

describe('templateMatches', () => {
  it('compares literals exactly and treats each property as a wildcard', () => {
    expect(templateMatches('core', 'core')).toBe(true);
    expect(templateMatches('core', 'cor')).toBe(false);
    expect(templateMatches('web_${scala.version}', 'web_2.13')).toBe(true);
    expect(templateMatches('web_${scala.version}', 'api_2.13')).toBe(false);
    expect(templateMatches(null, 'anything')).toBe(true);
  });
});

describe('reactor reading and selector matching', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-maven-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, content: string) => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('reads nested aggregators and matches by directory, POM file and id', () => {
    write(
      'pom.xml',
      pom(
        '<groupId>g</groupId><artifactId>root</artifactId><modules><module>libs</module></modules>',
      ),
    );
    write(
      'libs/pom.xml',
      pom(
        '<parent><groupId>g</groupId></parent><artifactId>libs</artifactId><modules><module>json/custom.xml</module></modules>',
      ),
    );
    write(
      'libs/json/custom.xml',
      pom('<parent><groupId>g</groupId></parent><artifactId>json</artifactId>'),
    );
    const reactor = readMavenReactor(tmp);
    expect(reactor?.map((p) => p.artifactId)).toEqual(['root', 'libs', 'json']);
    if (!reactor) return;
    expect(selectorMatches('libs', reactor, tmp)).toBe(true);
    expect(selectorMatches('libs/json/custom.xml', reactor, tmp)).toBe(true);
    expect(selectorMatches(':json', reactor, tmp)).toBe(true);
    expect(selectorMatches('g:json', reactor, tmp)).toBe(true);
    expect(selectorMatches('h:json', reactor, tmp)).toBe(false);
    expect(selectorMatches(':jsn', reactor, tmp)).toBe(false);
    // A directory that exists but is not a reactor project does not match.
    fs.mkdirSync(path.join(tmp, 'libs', 'json', 'src'), { recursive: true });
    expect(selectorMatches('libs/json/src', reactor, tmp)).toBe(false);
    expect(selectorMatches('nope', reactor, tmp)).toBe(false);
  });

  it('is unreadable when a POM is UTF-16, which reads as UTF-8 as an empty project', () => {
    fs.writeFileSync(
      path.join(tmp, 'pom.xml'),
      Buffer.from(
        `${String.fromCharCode(0xfeff)}${pom('<modules><module>core</module></modules>')}`,
        'utf16le',
      ),
    );
    write('core/pom.xml', pom('<artifactId>core</artifactId>'));
    expect(readMavenReactor(tmp)).toBeNull();
  });

  it('is unreadable when a listed module has no POM', () => {
    write(
      'pom.xml',
      pom('<artifactId>root</artifactId><modules><module>missing</module></modules>'),
    );
    expect(readMavenReactor(tmp)).toBeNull();
  });
});

describe('checkCommands — commands/maven-module-not-found', () => {
  let tmp: string;
  beforeEach(() => {
    resetPackageJsonCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-maven-cmd-'));
  });
  afterEach(() => {
    resetPackageJsonCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function lint(files: Record<string, string>, contextFile = 'AGENTS.md') {
    for (const [rel, content] of Object.entries(files)) {
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

  const reactor = {
    'pom.xml': pom(
      '<groupId>g</groupId><artifactId>root</artifactId><modules><module>core</module></modules>',
    ),
    'core/pom.xml': pom('<parent><groupId>g</groupId></parent><artifactId>app-core</artifactId>'),
  };

  it('flags the fixture typo and nothing else', async () => {
    const root = path.join(FIXTURES, 'maven-module-refs');
    const parsed = parseContextFile({
      absolutePath: path.join(root, 'CLAUDE.md'),
      relativePath: 'CLAUDE.md',
      isSymlink: false,
      type: 'context',
    });
    const found = (await checkCommands(parsed, root)).filter((i) => i.ruleId === RULE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', line: 7 });
    expect(found[0].message).toBe(
      '"./mvnw -pl cor -Dtest=CoreTest test" — -pl "cor" matches no module in the Maven reactor',
    );
    expect(found[0].suggestion).toBe('Did you mean "core"?');
  });

  it('reports each missing selector of a list separately', async () => {
    const found = await lint({ ...reactor, 'AGENTS.md': '`mvn -pl core,:app-cor,missing test`\n' });
    expect(found.map((i) => i.message)).toEqual([
      '"mvn -pl core,:app-cor,missing test" — -pl ":app-cor" matches no module in the Maven reactor',
      '"mvn -pl core,:app-cor,missing test" — -pl "missing" matches no module in the Maven reactor',
    ]);
  });

  it('accepts a selector that resolves from a nested context file’s own aggregator', async () => {
    const found = await lint(
      {
        ...reactor,
        'core/pom.xml': pom(
          '<artifactId>app-core</artifactId><modules><module>inner</module></modules>',
        ),
        'core/inner/pom.xml': pom('<artifactId>inner</artifactId>'),
        'core/AGENTS.md': '`mvn -pl inner test` and `mvn -pl core test` and `mvn -pl gone test`\n',
      },
      'core/AGENTS.md',
    );
    expect(found.map((i) => i.message)).toEqual([
      '"mvn -pl gone test" — -pl "gone" matches no module in the Maven reactor',
    ]);
  });

  it('is silent when .mvn/maven.config re-roots the reactor, in any spelling', async () => {
    for (const config of [
      '-f\nplatform/pom.xml\n',
      '-fplatform/pom.xml\n',
      '--file=platform\n',
      '-N\n',
    ]) {
      const found = await lint({
        ...reactor,
        '.mvn/maven.config': config,
        'AGENTS.md': '`mvn -pl missing test`\n',
      });
      expect(found, config).toEqual([]);
    }
    // Fail-mode flags are not `-f`.
    const found = await lint({
      ...reactor,
      '.mvn/maven.config': '-fae -ntp\n',
      'AGENTS.md': '`mvn -pl missing test`\n',
    });
    expect(found).toHaveLength(1);
  });

  it('resolves a nested context file’s ../ sibling path against the whole reactor', async () => {
    const found = await lint(
      {
        'pom.xml': pom(
          '<artifactId>root</artifactId><modules><module>core</module><module>web</module></modules>',
        ),
        'core/pom.xml': pom(
          '<artifactId>core</artifactId><packaging>pom</packaging><modules><module>api</module></modules>',
        ),
        'core/api/pom.xml': pom('<artifactId>api</artifactId>'),
        'web/pom.xml': pom('<artifactId>web</artifactId>'),
        'core/AGENTS.md': '`mvn -pl ../web test` and `mvn -pl ../gone test`\n',
      },
      'core/AGENTS.md',
    );
    expect(found.map((i) => i.message)).toEqual([
      '"mvn -pl ../gone test" — -pl "../gone" matches no module in the Maven reactor',
    ]);
  });

  it('is silent on a path that leaves the linted directory', async () => {
    const found = await lint({ ...reactor, 'AGENTS.md': '`mvn -pl ../sibling-repo/core test`\n' });
    expect(found).toEqual([]);
  });

  it('is silent when the reactor is not enumerable', async () => {
    const found = await lint({
      'pom.xml': pom('<modules><module>${module.dir}</module></modules>'),
      'AGENTS.md': '`mvn -pl missing test`\n',
    });
    expect(found).toEqual([]);
  });

  it('is silent without a POM', async () => {
    expect(await lint({ 'AGENTS.md': '`mvn -pl missing test`\n' })).toEqual([]);
  });
});
