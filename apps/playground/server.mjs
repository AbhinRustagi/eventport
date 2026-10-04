import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eventport } from 'eventport';
import { chatCompletions, responses } from 'eventport/openai';
import { anthropic } from 'eventport/anthropic';
import { agUI } from 'eventport/agui';
import { aiSDK } from 'eventport/vercel';
import { langGraph } from 'eventport/langgraph';

const root = fileURLToPath(new URL('./', import.meta.url));
const library = fileURLToPath(new URL('./', import.meta.resolve('eventport')));
const factories = new Map(Object.entries({
  'chat-completions': chatCompletions, responses, anthropic,
  agui: () => agUI({ threadId: 'demo-thread', runId: 'demo-run' }),
  'ai-sdk': aiSDK, langgraph: langGraph,
}));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json' };
const port = Number(process.env.PORT ?? 4321);
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/convert') {
      let body = '', size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413).end('Demo payload limit: 1 MB'); return; }
        body += chunk;
      }
      const { source, target, events } = JSON.parse(body);
      if (!factories.has(source) || !factories.has(target) || target === 'langgraph' || !Array.isArray(events)) {
        res.writeHead(400).end('Choose a supported source/target and an event array.'); return;
      }
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const result = eventport.convert(events, { signal: controller.signal }).from(factories.get(source)()).to(factories.get(target)());
      const response = result.toResponse();
      res.writeHead(200, Object.fromEntries(response.headers));
      await pipeline(Readable.fromWeb(response.body), res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file;
    if (path.startsWith('/dist/')) {
      file = resolve(library, path.slice('/dist/'.length));
      if (!file.startsWith(library)) { res.writeHead(404).end(); return; }
    } else {
      const asset = path === '/' ? 'index.html' : path.replace(/^\/playground\//, '');
      if (!['index.html', 'style.css', 'app.mjs', 'samples.mjs'].includes(asset)) { res.writeHead(404).end(); return; }
      file = resolve(root, asset);
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (res.headersSent) res.destroy(error);
    else res.writeHead(error instanceof SyntaxError ? 400 : 500, { 'Content-Type': 'text/plain' }).end(error.message);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Eventport playground: http://127.0.0.1:${port}`));
