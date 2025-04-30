export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Only POST method is supported', { status: 405 });
    }

    const originalUrl = new URL(request.url);

    if (!originalUrl.pathname.startsWith('/v1/chat/completions')) {
      return new Response('Unsupported path', { status: 404 });
    }

    try {
      const headers = new Headers(request.headers);
      headers.set('Host', 'dashscope.aliyuncs.com');

      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return new Response('Unsupported content type', { status: 400 });
      }

      const bodyJson = await request.json();
      const userStream = bodyJson.stream === true;

      // 改写请求体
      bodyJson.stream = true;
      bodyJson.stream_options = { include_usage: true };

      const modifiedRequest = new Request('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyJson),
        redirect: 'follow',
      });

      const response = await fetch(modifiedRequest);

      if (userStream || response.status !== 200) {
        // 用户本身要求stream或者响应状态不是200，直接转发
        const headersOut = new Headers(response.headers);
        headersOut.set('Access-Control-Allow-Origin', '*');
        headersOut.delete('content-encoding');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: headersOut,
        });
      } else {
        // 用户要求stream=false，但原站是stream=true，需要自己拼回完整结果
        const reader = response.body.getReader();
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();

        let buffer = '';
        let fullContent = '';
        let fullReasoning = '';
        let createdTime = Math.floor(Date.now() / 1000);
        let completionId = '';
        let usage = null;

        (async () => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // 按 '\n\n' 解析完整的 event
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const eventStr = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 2); // 剩余未处理的内容

              if (!eventStr.startsWith('data:')) {
                continue; // 不是 data: 开头的，跳过
              }

              const dataStr = eventStr.slice(5).trim();
              if (dataStr === '[DONE]') {
                continue;
              }

              let data;
              try {
                data = JSON.parse(dataStr);
              } catch (e) {
                console.warn('Invalid JSON chunk, skipped.');
                continue;
              }

              // 提取 completion id
              if (!completionId && (data.data?.id || data.id)) {
                completionId = data.data?.id || data.id;
              }

              const choices = data.data?.choices || data.choices || [];

              if (choices.length) {
                for (const choice of choices) {
                  const delta = choice.delta || {};
                  if (delta.content) {
                    fullContent += delta.content;
                  }
                  if (delta.reasoning_content) {
                    fullReasoning += delta.reasoning_content;
                  }
                }
              }

              if (!choices.length && data.usage) {
                usage = data.usage;
              }
            }
          }

          // 如果fullContent为空，返回500错误
          // if (!fullContent) {
          //   await writer.write(encoder.encode(JSON.stringify({
          //     error: {
          //       message: "Empty response from model",
          //       type: "server_error",
          //       code: 500
          //     }
          //   })));
          //   await writer.close();
          //   return;
          // }

          // 组装最终的完整回复
          const result = {
            id: completionId || `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion',
            created: createdTime,
            model: bodyJson.model || 'unknown',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: fullContent || '',
                  reasoning: fullReasoning || '',
                },
                finish_reason: 'stop',
              },
            ],
            usage: usage || {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            }
          };

          await writer.write(encoder.encode(JSON.stringify(result)));
          await writer.close();
        })();

        const responseHeaders = new Headers({
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });

        return new Response(readable, {
          status: !fullContent ? 500 : 200,
          headers: responseHeaders,
        });
      }

    } catch (err) {
      return new Response('Error: ' + (err.message || err.toString()), { status: 500 });
    }
  }
}
