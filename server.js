const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 配置信息
const CONFIG = {
  API_URL: 'https://www.gpt4novel.com/api/xiaoshuoai/ext/v1/chat/completions',
  DEFAULT_MODEL: 'nalang-xl-10',
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 800,
  DEFAULT_TOP_P: 0.35,
  DEFAULT_REPETITION_PENALTY: 1.05
};

// 模型映射 - 将OpenAI模型名称映射到API支持的模型
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nalang-turbo-v19',
  'gpt-3.5-turbo-16k': 'nalang-xl-16k',
  'gpt-4': 'nalang-xl-10',
  'gpt-4-32k': 'nalang-xl-16k',
  'gpt-4-turbo': 'nalang-v17-2',
  'gpt-4-turbo-preview': 'nalang-v17-2',
  'nalang-turbo-v19':'nalang-turbo-v19',
  'nalang-xl-16k':'nalang-xl-16k',
  'nalang-xl-10':'nalang-xl-10',
  'nalang-v17-2':'nalang-v17-2'
};

// 从请求中提取API密钥
function extractApiKey(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// 解析流式响应数据
function parseStreamLine(line) {
  if (!line.startsWith('data: ')) {
    return null;
  }
  
  try {
    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]') {
      return { done: true };
    }
    
    const jsonData = JSON.parse(jsonStr);
    return jsonData;
  } catch (e) {
    return null;
  }
}

// 处理流式响应并收集完整内容
function collectStreamContent(response) {
  return new Promise((resolve, reject) => {
    let fullContent = '';
    const decoder = new TextDecoder();
    let buffer = '';

    response.body.on('data', (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        
        const parsed = parseStreamLine(line);
        if (parsed) {
          if (parsed.done) {
            resolve(fullContent);
            return;
          }
          
          // 处理内容 - 支持不同的数据格式
          if (parsed.choices?.[0]?.delta?.content) {
            fullContent += parsed.choices[0].delta.content;
          } else if (parsed.choices?.[0]?.message?.content) {
            fullContent += parsed.choices[0].message.content;
          }
        }
      }
    });

    response.body.on('end', () => {
      // 处理剩余的buffer
      if (buffer.trim()) {
        const parsed = parseStreamLine(buffer.trim());
        if (parsed && parsed.choices?.[0]?.delta?.content) {
          fullContent += parsed.choices[0].delta.content;
        }
      }
      resolve(fullContent);
    });

    response.body.on('error', (error) => {
      reject(error);
    });
  });
}

// 处理聊天完成请求的核心函数
async function handleChatCompletion(req, res) {
  try {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: 'Missing API key. Please provide Authorization header with Bearer token.',
          type: 'authentication_error'
        }
      });
    }

    // 提取请求参数，只处理原始API支持的参数，其他参数忽略
    const {
      model = CONFIG.DEFAULT_MODEL,
      messages = [],
      stream = false,
      temperature = CONFIG.DEFAULT_TEMPERATURE,
      max_tokens = CONFIG.DEFAULT_MAX_TOKENS,
      top_p = CONFIG.DEFAULT_TOP_P,
      repetition_penalty = CONFIG.DEFAULT_REPETITION_PENALTY,
      // 以下参数被接受但忽略（OpenAI标准参数）
      frequency_penalty,
      presence_penalty,
      stop,
      n,
      logit_bias,
      user,
      response_format,
      seed,
      tools,
      tool_choice,
      ...otherParams
    } = req.body;

    // 验证必需参数
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages parameter is required and must be a non-empty array.',
          type: 'invalid_request_error'
        }
      });
    }

    // 映射模型名称
    const mappedModel = MODEL_MAPPING[model] || model;

    // 构建请求体 - 强制使用流式传输，因为第三方API只支持流式
    const requestBody = {
      model: mappedModel,
      messages: messages,
      stream: true, // 强制流式传输
      temperature: temperature,
      max_tokens: max_tokens,
      top_p: top_p,
      repetition_penalty: repetition_penalty
    };

    console.log(`[${new Date().toISOString()}] API Request:`, {
      model: mappedModel,
      messagesCount: messages.length,
      requestedStream: stream,
      actualStream: true, // 实际总是使用流式
      temperature: temperature,
      max_tokens: max_tokens,
      ignoredParams: Object.keys({ frequency_penalty, presence_penalty, stop, n, logit_bias, user, response_format, seed, tools, tool_choice }).filter(key => req.body[key] !== undefined)
    });

    // 发送请求到目标API
    const response = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[${new Date().toISOString()}] API Error:`, response.status, errorText);
      
      return res.status(response.status).json({
        error: {
          message: `API request failed: ${response.status} ${response.statusText}`,
          type: 'api_error',
          details: errorText
        }
      });
    }

    // 处理流式响应
    if (stream) {
      // 设置SSE响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

      const decoder = new TextDecoder();
      let buffer = '';
      let isFirstChunk = true;
      let hasEnded = false;

      // 处理响应流
      response.body.on('data', (chunk) => {
        if (hasEnded) return;
        
        buffer += decoder.decode(chunk, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          const parsed = parseStreamLine(line);
          if (parsed) {
            if (parsed.done) {
              if (!hasEnded) {
                // 发送结束标记
                const finishFormat = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                  }]
                };
                res.write(`data: ${JSON.stringify(finishFormat)}\n\n`);
                res.write('data: [DONE]\n\n');
                hasEnded = true;
                res.end();
              }
              return;
            }
            
            // 处理内容块
            const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content;
            if (content && !hasEnded) {
              const openaiFormat = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: {
                    role: isFirstChunk ? 'assistant' : undefined,
                    content: content
                  },
                  finish_reason: null
                }]
              };
              
              res.write(`data: ${JSON.stringify(openaiFormat)}\n\n`);
              isFirstChunk = false;
            }
          }
        }
      });

      response.body.on('end', () => {
        if (hasEnded) return;
        
        // 处理剩余数据
        if (buffer.trim()) {
          const parsed = parseStreamLine(buffer.trim());
          if (parsed && parsed.choices?.[0]?.delta?.content) {
            const openaiFormat = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  content: parsed.choices[0].delta.content
                },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(openaiFormat)}\n\n`);
          }
        }
        
        if (!hasEnded) {
          // 发送最终结束标记
          const finalFormat = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finalFormat)}\n\n`);
          res.write('data: [DONE]\n\n');
          hasEnded = true;
          res.end();
        }
      });

      response.body.on('error', (error) => {
        if (!hasEnded) {
          console.error('Stream error:', error);
          res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'stream_error' } })}\n\n`);
          hasEnded = true;
          res.end();
        }
      });

      // 处理客户端断开连接
      req.on('close', () => {
        if (!hasEnded) {
          hasEnded = true;
          response.body.destroy();
        }
      });

    } else {
      // 处理非流式响应 - 收集完整的流式响应内容
      try {
        const fullContent = await collectStreamContent(response);
        
        // 返回OpenAI格式的响应
        const openaiResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: fullContent
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: fullContent.length,
            total_tokens: fullContent.length
          }
        };

        res.json(openaiResponse);
      } catch (streamError) {
        console.error('Error collecting stream content:', streamError);
        res.status(500).json({
          error: {
            message: 'Error processing stream response',
            type: 'server_error',
            details: streamError.message
          }
        });
      }
    }

  } catch (error) {
    console.error('Error in handleChatCompletion:', error);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        details: error.message
      }
    });
  }
}

// POST 路由 - 主要的聊天完成接口
app.post('/v1/chat/completions', handleChatCompletion);

// GET 路由 - 支持查询参数的简单聊天接口
app.get('/v1/chat/completions', (req, res) => {
  const { message, model = 'gpt-3.5-turbo', stream = 'false' } = req.query;
  
  if (!message) {
    return res.status(400).json({
      error: {
        message: 'Message parameter is required for GET requests.',
        type: 'invalid_request_error'
      }
    });
  }

  // 将GET请求转换为POST请求格式
  req.body = {
    model: model,
    messages: [
      { role: 'user', content: message }
    ],
    stream: stream === 'true'
  };

  handleChatCompletion(req, res);
});

// 模型列表接口
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(key => ({
    id: key,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'openai-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 根路径提供API文档
app.get('/', (req, res) => {
  res.json({
    name: 'OpenAI API Proxy',
    version: '1.0.0',
    description: 'A proxy service that converts third-party AI API to OpenAI-compatible format',
    note: 'This proxy converts streaming-only API to support both streaming and non-streaming requests',
    endpoints: {
      'POST /v1/chat/completions': 'Chat completions (OpenAI format)',
      'GET /v1/chat/completions': 'Simple chat with query parameters (?message=...)',
      'GET /v1/models': 'List available models',
      'GET /health': 'Health check'
    },
    usage: {
      authentication: 'Bearer token in Authorization header',
      example_curl: `curl -X POST ${req.protocol}://${req.get('host')}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'`
    }
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error'
    }
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 OpenAI API Proxy Server running on port ${PORT}`);
  console.log(`📖 API Documentation: http://localhost:${PORT}`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
  console.log(`📝 Models List: http://localhost:${PORT}/v1/models`);
  console.log(`⚠️  Note: Third-party API only supports streaming, proxy converts to both formats`);
});

module.exports = app;