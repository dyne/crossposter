import { readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

const serverPath = /^(lib\/(providers\/|storage\/|local-config\.|media-store\.|env\.|scheduler\.|publish-runner\.|publishing\/service\.|scheduling\/(service|lifecycle)\.)|app\/api\/)/;
const browserLibrary = /^lib\/(compose|settings|scheduled)\//;
const sharedContract = /^(lib\/(types|platform-catalog|platform-limits|config-spec)\.ts|lib\/publishing\/contracts\.ts)$/;
const codec = /^lib\/storage\/(codec-helpers|config-codec|content-codec|schedule-codec)\.ts$/;
const useCase = /^lib\/(publishing\/service|scheduling\/(service|policy|queries))\.ts$/;

// Parse syntax rather than matching import text: comments and erased type-only
// imports do not create browser dependencies. Include re-exports/dynamic imports.
function runtimeImports(filename, source) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly) && !clause.name);
      if (!onlyTypes) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)
        || node.exportClause.elements.some((item) => !item.isTypeOnly)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      imports.push(argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed import>");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

function resolveLocal(from, specifier, files) {
  const base = specifier.startsWith("@/") ? specifier.slice(2)
    : specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : undefined;
  if (base === undefined) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .find((candidate) => files.has(candidate)) ?? null;
}

export function checkBoundaries(files) {
  const imports = new Map([...files].map(([name, source]) => [name, runtimeImports(name, source)]));
  const violations = new Set();
  for (const [root, source] of files) {
    const syntax = ts.createSourceFile(root, source, ts.ScriptTarget.Latest, true);
    const browser = syntax.statements.some((statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client")
      || browserLibrary.test(root) || sharedContract.test(root);
    const pureCodec = codec.test(root);
    const service = useCase.test(root);
    if (!browser && !pureCodec && !service) continue;
    const visited = new Set();
    function walk(filename, trace) {
      if (visited.has(filename)) return;
      visited.add(filename);
      for (const specifier of imports.get(filename) ?? []) {
        const target = resolveLocal(filename, specifier, files);
        const chain = [...trace, specifier].join(" -> ");
        if (target === null || specifier === "<computed import>") {
          violations.add(`${root}: unresolved runtime dependency: ${chain}`);
        } else if (isBuiltin(specifier) || (browser && (specifier === "server-only" || (target && serverPath.test(target))))
          || (pureCodec && specifier === "server-only")
          || (target && (pureCodec || service) && (serverPath.test(target) && !codec.test(target) && !useCase.test(target)))) {
          violations.add(`${root}: forbidden runtime dependency: ${chain}`);
        } else if (target) walk(target, [...trace, specifier]);
      }
    }
    walk(root, [root]);
  }
  return [...violations].sort();
}

export function readProductionSources(root) {
  const files = new Map();
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const filename = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(filename);
      else if (/\.tsx?$/.test(filename)) files.set(filename, readFileSync(path.join(root, filename), "utf8"));
    }
  }
  for (const directory of ["app", "components", "lib"]) visit(directory);
  return files;
}
