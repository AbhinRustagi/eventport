import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, parse } from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { dts } from "rollup-plugin-dts";

const output = process.env.EVENTPORT_BUILD_DIR || "dist";

// Bundle all reachable SDK declarations; consumers install only Eventport.
export default {
  external: (id) =>
    isBuiltin(id) ||
    /(?:^|\/)(?:node-fetch|undici|undici-types)(?:[./]|$)/.test(id),
  input: {
    index: `${output}/index.d.ts`,
    ...Object.fromEntries(
      [
        "openai",
        "chat-completions",
        "responses",
        "anthropic",
        "agui",
        "vercel",
        "ai-sdk",
        "langgraph",
      ].map((name) => [`adapters/${name}`, `${output}/adapters/${name}.d.ts`]),
    ),
  },
  output: {
    dir: output,
    format: "es",
    chunkFileNames: "types/[name]-[hash].d.ts",
  },
  plugins: [
    {
      name: "omit-sdk-runtime-globals",
      transform(code, id) {
        if (!id.includes("/node_modules/ai/") || !/\.d\.[cm]?ts$/.test(id))
          return;
        const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest);
        // Importing event types must not install AI SDK provider/telemetry globals.
        // Dropping these declarations also lets Rollup discard their SDK graphs.
        const globals = source.statements.filter(
          (node) =>
            ts.isModuleDeclaration(node) &&
            node.flags & ts.NodeFlags.GlobalAugmentation,
        );
        for (const node of [...globals].reverse())
          code = code.slice(0, node.pos) + code.slice(node.end);
        return { code, map: null };
      },
    },
    dts({
      respectExternal: true,
      compilerOptions: {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
      },
    }),
    {
      name: "bundled-type-notices",
      async generateBundle(_options, bundle) {
        const packages = new Map();
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          for (const [id, module] of Object.entries(chunk.modules)) {
            if (!module.renderedLength || !id.includes("node_modules"))
              continue;
            let directory = dirname(id);
            while (directory !== parse(directory).root) {
              let manifest;
              try {
                manifest = JSON.parse(
                  await readFile(resolve(directory, "package.json"), "utf8"),
                );
              } catch {}
              if (manifest?.name) {
                packages.set(directory, manifest);
                break;
              }
              directory = dirname(directory);
            }
          }
        }
        const notices = [];
        for (const [directory, manifest] of [...packages].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const files = (await readdir(directory)).filter((name) =>
            /^(license|licence|notice)(\.|$)/i.test(name),
          );
          if (!files.length)
            throw new Error(
              `Missing redistribution license for ${manifest.name}`,
            );
          notices.push(
            `${manifest.name}@${manifest.version} (${manifest.license})`,
          );
          for (const file of files)
            notices.push(await readFile(resolve(directory, file), "utf8"));
        }
        this.emitFile({
          type: "asset",
          fileName: "THIRD_PARTY_NOTICES",
          source: notices.join("\n\n---\n\n"),
        });
      },
    },
  ],
  onwarn(warning, warn) {
    if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
    warn(warning);
  },
};
