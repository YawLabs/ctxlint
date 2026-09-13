import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripBom } from '../../utils/fs.js';
import { shellWords } from './gradle-projects.js';

/**
 * Static analysis behind `commands/maven-module-not-found`.
 *
 * `./mvnw -pl flink-core-api -Dtest=MemorySizeTest test` selects a module of
 * the reactor. Maven matches each selector against the reactor projects
 * (DefaultGraphBuilder.isMatchingProject in 3.9, ProjectSelector in 4.0):
 *
 *  - a selector containing `:` is an id: `:artifactId` or `groupId:artifactId`,
 *    compared exactly against the effective model;
 *  - anything else is a path relative to the directory of the POM Maven
 *    starts from, and must be that project's directory or POM file.
 *
 * A selector matching nothing fails the build before anything is built
 * ("Could not find the selected project in the reactor: x" in 3.9, "The
 * requested required projects x do not exist." in 4.0). Goals are contributed
 * by plugins and are never checked.
 *
 * The reactor is read from `<modules>` / `<subprojects>` (every profile's too:
 * a superset only suppresses findings). Anything that makes the module set
 * unknowable -- a property in a module path, Maven 4 automatic subproject
 * discovery, a POM we cannot read -- yields null and the rule stays silent.
 * Never executes Maven.
 */

/** A project in the statically read reactor. */
export interface ReactorProject {
  /** Absolute directory of the project. */
  basedir: string;
  /** Absolute path of its POM file. */
  pomFile: string;
  /**
   * artifactId as written. A `${property}` inside it can resolve to anything,
   * so ids are compared as templates (see templateMatches); null when absent.
   */
  artifactId: string | null;
  /** groupId as written (own, else inherited from `<parent>`), or null. */
  groupId: string | null;
}

/** Hard cap on POMs read per reactor; a larger tree is treated as unknowable. */
const MAX_POMS = 20_000;

/**
 * Read the reactor rooted at `baseDir/pom.xml`, or null when there is no POM
 * or the module set cannot be enumerated statically.
 */
export function readMavenReactor(baseDir: string): ReactorProject[] | null {
  const rootPom = path.join(baseDir, 'pom.xml');
  if (!fs.existsSync(rootPom)) return null;

  const projects: ReactorProject[] = [];
  const seen = new Set<string>();
  const queue = [path.resolve(rootPom)];
  while (queue.length > 0) {
    const pomFile = queue.shift() as string;
    const key = pomFile.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_POMS) return null;

    let xml: string;
    try {
      xml = stripBom(fs.readFileSync(pomFile, 'utf-8'));
    } catch {
      // A module listed but absent fails the build on its own; it cannot be
      // proven absent from the reactor either way, so the set is unknowable.
      return null;
    }
    const model = parsePom(xml);
    if (!model) return null;
    const basedir = path.dirname(pomFile);
    projects.push({ basedir, pomFile, artifactId: model.artifactId, groupId: model.groupId });

    for (const module of model.modules) {
      const target = path.resolve(basedir, module);
      let childPom = target;
      try {
        if (fs.statSync(target).isDirectory()) childPom = path.join(target, 'pom.xml');
      } catch {
        return null;
      }
      queue.push(childPom);
    }
  }
  return projects;
}

interface PomModel {
  artifactId: string | null;
  groupId: string | null;
  modules: string[];
}

/**
 * A deliberately small POM reader: it walks the element tree (comments and
 * CDATA removed) and reads only the handful of paths the rule needs. Null when
 * the module list cannot be trusted.
 */
export function parsePom(xml: string): PomModel | null {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  const text: Record<string, string> = {};
  const modules: string[] = [];
  let hasModuleList = false;
  let lastEnd = 0;

  for (const m of cleaned.matchAll(tagRe)) {
    const [whole, closing, rawName, , selfClosing] = m;
    const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    const start = m.index ?? 0;
    if (closing) {
      const elementPath = stack.join('/');
      const value = cleaned.slice(lastEnd, start).trim();
      if (stack[stack.length - 1] === name) {
        if (/^project\/(?:artifactId|groupId|modelVersion)$/.test(elementPath))
          text[elementPath] = value;
        if (elementPath === 'project/parent/groupId') text[elementPath] = value;
        if (
          /^project\/(?:profiles\/profile\/)?(?:modules\/module|subprojects\/subproject)$/.test(
            elementPath,
          )
        ) {
          if (!value || value.includes('${')) return null;
          modules.push(decodeEntities(value));
        }
        stack.pop();
      }
    } else if (!selfClosing && !whole.startsWith('<?')) {
      stack.push(name);
      const elementPath = stack.join('/');
      if (/^project\/(?:profiles\/profile\/)?(?:modules|subprojects)$/.test(elementPath)) {
        hasModuleList = true;
      }
    }
    lastEnd = start + whole.length;
  }

  // Maven 4.1.0 discovers subprojects from the directory tree when a POM
  // declares neither list; that set is not in the file.
  if (text['project/modelVersion'] === '4.1.0' && !hasModuleList) return null;

  const value = (v: string | undefined): string | null => (v ? decodeEntities(v) : null);
  return {
    artifactId: value(text['project/artifactId']),
    groupId: value(text['project/groupId'] ?? text['project/parent/groupId']),
    modules,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Heads that invoke Maven against the POM in the working directory. */
const MAVEN_HEAD = /^(?:\.[\\/])?mvnw(?:\.cmd)?$|^mvn(?:\.cmd)?$/;

/** Options that consume the next token as their value (CLIManager 3.9 and 4.0, union). */
const VALUE_OPTIONS = new Set([
  '-D',
  '--define',
  '-P',
  '--activate-profiles',
  '-s',
  '--settings',
  '-gs',
  '--global-settings',
  '-t',
  '--toolchains',
  '-gt',
  '--global-toolchains',
  '-ps',
  '--project-settings',
  '-is',
  '--install-settings',
  '-it',
  '--install-toolchains',
  '-fos',
  '--fail-on-severity',
  '-l',
  '--log-file',
  '-T',
  '--threads',
  '-b',
  '--builder',
  '-canf',
  '--cache-artifact-not-found',
  '-sadp',
  '--strict-artifact-descriptor-policy',
]);

/**
 * Options that change the reactor the selectors resolve against: `-f` re-roots
 * it, `-N` shrinks it to one POM, `-af` reads further arguments from a file.
 */
const RETARGET_OPTIONS = new Set(['-f', '--file', '-N', '--non-recursive', '-af', '--at-file']);

/** Names documentation uses as stand-ins for a real module. */
const PLACEHOLDER = /[<>{}$*]|\.\.\.|^(?:module|my-module|your-module|module-name|some-module)$/i;

/** One module selector found in a Maven command. */
export interface MavenSelector {
  /** The selector with any `!`/`-`/`+` prefix removed. */
  selector: string;
  /** `-pl` or `-rf`, for the message. */
  option: string;
}

/**
 * Pull checkable module selectors out of a Maven invocation. Null when the
 * command is not a Maven invocation or retargets the reactor.
 */
export function mavenSelectors(cmd: string): MavenSelector[] | null {
  const tokens = shellWords(cmd);
  if (!tokens || tokens.length === 0 || !MAVEN_HEAD.test(tokens[0])) return null;

  const out: MavenSelector[] = [];
  const addList = (option: string, value: string, isList: boolean): void => {
    for (const raw of isList ? value.split(',') : [value]) {
      let sel = raw.trim();
      if (isList) sel = sel.replace(/^[!+-]/, '');
      // `?sel` is optional in Maven 4: a miss is logged, not fatal.
      if (!sel || sel.startsWith('?') || PLACEHOLDER.test(sel)) continue;
      out.push({ selector: sel, option });
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) continue;
    const eq = tok.indexOf('=');
    const bare = eq > 0 && tok.startsWith('--') ? tok.slice(0, eq) : tok;
    if (RETARGET_OPTIONS.has(bare)) return null;
    // `-fpom.xml` attaches the value to a single-char option.
    if (/^-f[^\w-]?.+/.test(tok) && !/^-(?:fae|ff|fn|fos)$/.test(tok)) return null;

    if (bare === '-pl' || bare === '--projects' || bare === '-rf' || bare === '--resume-from') {
      const isList = bare === '-pl' || bare === '--projects';
      const option = isList ? '-pl' : '-rf';
      if (eq > 0 && tok.startsWith('--')) {
        addList(option, tok.slice(eq + 1), isList);
      } else if (tokens[i + 1] !== undefined) {
        addList(option, tokens[++i], isList);
      }
      continue;
    }
    if (VALUE_OPTIONS.has(tok)) i++;
  }
  return out;
}

/** Does `selector` match any project of `reactor`, resolving paths against `baseDir`? */
export function selectorMatches(
  selector: string,
  reactor: ReactorProject[],
  baseDir: string,
): boolean {
  if (selector.includes(':')) {
    if (selector.startsWith(':')) {
      const artifactId = selector.slice(1);
      return reactor.some((p) => templateMatches(p.artifactId, artifactId));
    }
    const [groupId, artifactId, ...rest] = selector.split(':');
    // `g:a:v` never matches in Maven, but it is a different mistake from a
    // missing module; stay silent rather than word it wrongly.
    if (rest.length > 0) return true;
    return reactor.some(
      (p) => templateMatches(p.artifactId, artifactId) && templateMatches(p.groupId, groupId),
    );
  }
  const target = path.resolve(baseDir, selector);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (stat.isFile()) return reactor.some((p) => samePath(p.pomFile, target));
  return reactor.some((p) => samePath(p.basedir, target));
}

/**
 * Could an id written as `template` in a POM equal `value`? Literal text must
 * match exactly; each `${property}` may stand for any string, because its
 * value depends on profiles and the command line
 * (`flink-dist-scala_${scala.binary.version}`). An absent id (null) might be
 * anything, so it matches.
 */
export function templateMatches(template: string | null, value: string): boolean {
  if (template === null) return true;
  if (!template.includes('${')) return template === value;
  const pattern = template
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(value);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Directories a Maven command in `contextFile` may have been written to run
 * from: the project root, plus every ancestor of the context file (up to the
 * root) that holds a POM. A selector is reported only when it matches in NONE
 * of them, because the doc does not say where it is run.
 */
export function mavenBaseDirs(contextFile: string, projectRoot: string): string[] {
  const root = path.resolve(projectRoot);
  const dirs = [root];
  let dir = path.dirname(path.resolve(contextFile));
  for (;;) {
    const rel = path.relative(root, dir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) break;
    if (fs.existsSync(path.join(dir, 'pom.xml'))) dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}
