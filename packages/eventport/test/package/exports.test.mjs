import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pnpm = process.env.npm_execpath;
const run = (file, args, cwd) =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60000,
  });
test(
  "packed package exposes every adapter and compiles without SDK or Node dependencies",
  { timeout: 120000 },
  async () => {
    assert.ok(pnpm, "Run with pnpm test so its package manager is available");
    const directory = await mkdtemp(resolve(tmpdir(), "eventport-package-"));
    try {
      run(
        process.execPath,
        [pnpm, "pack", "--pack-destination", directory],
        root,
      );
      const archive = (await readdir(directory)).find((name) =>
        name.endsWith(".tgz"),
      );
      assert.ok(archive);
      await writeFile(
        resolve(directory, "package.json"),
        JSON.stringify({
          name: "eventport-consumer",
          private: true,
          type: "module",
          dependencies: { eventport: `file:./${archive}` },
        }),
      );
      run(
        process.execPath,
        [pnpm, "install", "--offline", "--ignore-scripts"],
        directory,
      );
      const manifest = JSON.parse(
        await readFile(
          resolve(directory, "node_modules/eventport/package.json"),
          "utf8",
        ),
      );
      assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
      assert.equal(Object.keys(manifest.peerDependencies ?? {}).length, 0);
      assert.deepEqual(Object.keys(manifest.exports).sort(), [
        ".",
        "./agui",
        "./anthropic",
        "./langgraph",
        "./openai",
        "./vercel",
      ]);
      await copyFile(
        resolve(root, "test/consumer.mts"),
        resolve(directory, "consumer.mts"),
      );
      await copyFile(
        resolve(root, "test/tsconfig.json"),
        resolve(directory, "tsconfig.json"),
      );
      run(
        process.execPath,
        [
          resolve(root, "node_modules/typescript/bin/tsc"),
          "-p",
          "tsconfig.json",
        ],
        directory,
      );
      const notices = await readFile(
        resolve(directory, "node_modules/eventport/dist/THIRD_PARTY_NOTICES"),
        "utf8",
      );
      assert.match(notices, /openai@/);
      assert.match(notices, /@anthropic-ai\/sdk@/);
      await writeFile(
        resolve(directory, "runtime.mjs"),
        `
      import assert from 'node:assert/strict';
      import {eventport} from 'eventport';
      import {chatCompletions,responses} from 'eventport/openai';
      import {anthropic} from 'eventport/anthropic';
      import {agUI} from 'eventport/agui';
      import {aiSDK} from 'eventport/vercel';
      import {langGraph} from 'eventport/langgraph';
      for(const factory of [chatCompletions,responses,anthropic,langGraph]) assert.equal(typeof factory,'function');
      const output=await eventport.convert([{type:'start'},{type:'finish',finishReason:'stop'}]).from(aiSDK()).to(agUI({threadId:'t',runId:'r'})).collect();
      assert.equal(output.at(-1).type,'RUN_FINISHED');
    `,
      );
      run(process.execPath, ["runtime.mjs"], directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
