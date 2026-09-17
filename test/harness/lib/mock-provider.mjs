/**
 * An OpenAI-compatible upstream that records what it was sent.
 *
 * Its job is not to be a good model — it is to make the tool-preservation
 * guarantee observable. The toolkit promises that Cursor's own tools reach the
 * provider unchanged, and the only way to check that is to look at the request
 * the provider actually received: names, order, descriptions and schemas.
 */

import { createServer } from 'node:http';

/**
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {{name: string, argumentsJson: string}} [options.toolCall]
 *   Overrides the tool call the mock answers with, so a test can drive a
 *   specific mapping path.
 * @param {string} [options.followUpText]
 *   Reply to send once a tool result is in the conversation, instead of
 *   calling the tool again. Without it a server-tool loop would never end,
 *   which is also how a real model behaves: it answers once it has the result.
 */
export async function startMockProvider({
  host = '127.0.0.1',
  port = 0,
  toolCall,
  followUpText,
} = {}) {
  /** Every chat request seen, most recent last. */
  const requests = [];
  const call = toolCall ?? { name: 'read_file', argumentsJson: '{"path":"a.txt"}' };

  const server = createServer((request, response) => {
    if (request.url === '/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }

    if (!request.url?.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        body = {};
      }
      requests.push({
        model: body.model,
        tools: body.tools ?? [],
        messages: body.messages ?? [],
        authorization: request.headers.authorization ?? null,
      });

      // Stream a short reply plus one tool call, so both the text path and the
      // tool-call path are exercised.
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

      // A conversation that already carries a tool result gets an answer
      // rather than another tool call, which is what ends a tool loop.
      if (followUpText && body.messages?.at(-1)?.role === 'tool') {
        send({ choices: [{ delta: { content: followUpText }, finish_reason: null }] });
        send({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 13, completion_tokens: 5 },
        });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }

      send({ choices: [{ delta: { content: 'hello ' }, finish_reason: null }] });
      send({ choices: [{ delta: { content: 'from mock' }, finish_reason: null }] });

      // The arguments are split across two chunks, which is how every real
      // provider streams them and the case an accumulator gets wrong.
      const split = Math.ceil(call.argumentsJson.length / 2);
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: call.name, arguments: call.argumentsJson.slice(0, split) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: call.argumentsJson.slice(split) } }],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    host,
    port: server.address().port,
    baseUrl: `http://${host}:${server.address().port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
