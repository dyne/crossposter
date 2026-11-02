// Compile the Node bridge independently of Next, preserving only its import closure.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "dist/mcp");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error("MCP compiler configuration is invalid.");
const options = ts.convertCompilerOptionsFromJson({ ...config.config.compilerOptions, noEmit: false, incremental: false,
  isolatedModules: true, rootDir: root, outDir: output, declaration: false, plugins: [] }, root);
const program = ts.createProgram([path.join(root, "mcp/main.ts")], options.options);
const diagnostics = [...options.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name, getNewLine: () => "\n" })); process.exitCode = 1;
} else {
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  const rewrite = (context) => (file) => {
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier === "server-only" || specifier.startsWith("next/") || /lib\/(providers|storage)\//.test(specifier)) throw new Error("Forbidden MCP runtime dependency.");
        if (specifier.startsWith("@/") || specifier.startsWith(".")) {
          const target = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(file.fileName), specifier);
          let relative = path.relative(path.dirname(file.fileName), target).split(path.sep).join("/");
          if (!relative.startsWith(".")) relative = `./${relative}`;
          const literal = ts.factory.createStringLiteral(`${relative}.js`);
          return ts.isImportDeclaration(node)
            ? ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, literal, node.attributes)
            : ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, literal, node.attributes);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit);
  };
  const result = program.emit(undefined, undefined, undefined, undefined, { before: [rewrite] });
  if (result.emitSkipped) throw new Error("MCP compilation failed.");
  writeFileSync(path.join(output, "package.json"), '{"type":"module"}\n');
}
