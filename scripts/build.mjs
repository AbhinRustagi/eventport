import { readdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
for (const [script, args] of [
  ["node_modules/typescript/bin/tsc", ["-p", "tsconfig.json"]],
  ["node_modules/rollup/dist/bin/rollup", ["-c", "rollup.config.mjs"]],
])
  execFileSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    stdio: "inherit",
  });

// Publishing must never require a provider SDK or Node types in the consumer.
async function verify(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await verify(path);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
    );
    if (source.typeReferenceDirectives.length)
      throw new Error(`External type reference in ${path}`);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        !specifier.text.startsWith(".")
      ) {
        throw new Error(`Unbundled import ${specifier.text} in ${path}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await verify(resolve(root, "dist"));

// Compile the published surface with no ambient Node/SDK types available.
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const declarations = Object.values(manifest.exports).map((entry) =>
  resolve(root, entry.types),
);
const program = ts.createProgram(declarations, {
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  types: [],
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}
