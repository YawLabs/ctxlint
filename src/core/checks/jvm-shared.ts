import * as fs from 'node:fs';
import { stripBom } from '../../utils/fs.js';

/**
 * Pieces shared by the two JVM build checks (gradle-projects.ts,
 * maven-modules.ts).
 */

/**
 * Read a build file as UTF-8 text, throwing when it is not. A UTF-16 file
 * (BOM or NUL bytes) is valid input to Gradle and Maven, but read as UTF-8 it
 * lexes to no `include` / `<module>` at all -- an empty project set that would
 * report every project missing. Callers treat the throw as "unknowable".
 */
export function readUtf8BuildFile(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw new Error(`${file} is not UTF-8`);
  return stripBom(buf.toString('utf-8'));
}

/**
 * Names documentation uses as stand-ins for a real project or module. They
 * carry no marker (`<module>` and `{module}` are rejected separately), so they
 * look like real names: ktor writes `:module-name:jvmTest` fifteen times,
 * duckduckgo `:my-feature-impl:testDebugUnitTest`, Maven docs
 * `-pl com.example:my-module`. Tested against one name (a Gradle path segment,
 * a Maven artifactId or path), never a whole command.
 */
export const PLACEHOLDER_NAME =
  /^(?:module|project|subproject|submodule|component|feature)(?:[-_]?(?:name|path|id))?$|^(?:my|your|some|example|sample)[-_]|^(?:foo|bar|baz|xxx|name)$/i;
