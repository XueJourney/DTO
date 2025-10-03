const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { TextDecoder } = require('util');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return;
      }

      const delimiterIndex = trimmed.indexOf('=');
      if (delimiterIndex === -1) {
        return;
      }

      const key = trimmed.slice(0, delimiterIndex).trim();
      const value = trimmed.slice(delimiterIndex + 1).trim();

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    console.error('读取 .env 文件失败:', error);
  }
}

loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

function numberFromEnv(envKey, fallback) {
  const value = process.env[envKey];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function logSecurityWarning(message) {
  console.warn(`\u26a0\ufe0f  ${message}`);
}

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hashB = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  logSecurityWarning('SESSION_SECRET 未配置，将使用临时密钥。请在生产环境中设置 SESSION_SECRET 环境变量，以避免会话在重启后失效。');
  return crypto.randomBytes(64).toString('hex');
}

function verifyPassword(inputPassword) {
  if (!inputPassword) {
    return false;
  }

  if (AUTH_CONFIG.passwordHash && AUTH_CONFIG.passwordSalt) {
    try {
      const derived = crypto.scryptSync(inputPassword, AUTH_CONFIG.passwordSalt, 64);
      const expected = Buffer.from(AUTH_CONFIG.passwordHash, 'hex');

      if (expected.length !== derived.length) {
        return false;
      }

      return crypto.timingSafeEqual(derived, expected);
    } catch (error) {
      console.error('验证密码哈希失败:', error);
      return false;
    }
  }

  return safeCompare(inputPassword, AUTH_CONFIG.password);
}

function verifyCredentials(username, password) {
  if (!username || !password) {
    return false;
  }

  return safeCompare(username, AUTH_CONFIG.username) && verifyPassword(password);
}

// 认证配置
const AUTH_CONFIG = {
  username: process.env.AUTH_USERNAME || 'admin',
  password: process.env.AUTH_PASSWORD || 'change-me',
  passwordHash: process.env.AUTH_PASSWORD_HASH || null,
  passwordSalt: process.env.AUTH_PASSWORD_SALT || null,
  secret: resolveSessionSecret()
};

if (!process.env.AUTH_PASSWORD_HASH) {
  logSecurityWarning('未检测到 AUTH_PASSWORD_HASH，当前将使用明文密码进行比对。请使用 scripts/hash-password.js 生成哈希并配置 AUTH_PASSWORD_HASH/ AUTH_PASSWORD_SALT。');
}

if (AUTH_CONFIG.username === 'admin' && AUTH_CONFIG.password === 'change-me' && !AUTH_CONFIG.passwordHash) {
  logSecurityWarning('当前仍在使用默认的后台账号密码 admin/change-me，请尽快修改为强密码或配置 AUTH_PASSWORD_HASH。');
}

// 数据库配置
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: numberFromEnv('DB_PORT', 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dto_proxy',
  charset: process.env.DB_CHARSET || 'utf8mb4',
  timezone: process.env.DB_TIMEZONE || '+08:00'
};

// 创建数据库连接池
const pool = mysql.createPool({
  ...DB_CONFIG,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 60000, // 连接超时（毫秒）
  acquireTimeout: 60000, // 获取连接超时
  timeout: 60000, // 查询超时
  enableKeepAlive: true, // 保持连接活跃
  keepAliveInitialDelay: 30000 // 保持连接活跃的初始延迟
});

// 安全的数据库连接获取函数
async function getConnection() {
  try {
    return await pool.getConnection();
  } catch (err) {
    console.error('获取数据库连接失败:', err);
    
    // 如果是连接丢失错误，尝试重新建立连接
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || 
        err.code === 'ECONNREFUSED' || 
        err.code === 'ER_CON_COUNT_ERROR') {
      console.log('尝试重新连接数据库...');
      
      // 等待短暂时间后重试
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await pool.getConnection();
    }
    
    throw err;
  }
}

// 安全的数据库查询执行函数
async function executeQuery(sql, params = []) {
  let connection;
  try {
    connection = await getConnection();
    return await connection.execute(sql, params);
  } catch (err) {
    console.error('执行SQL查询失败:', err);
    throw err;
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('释放连接失败:', releaseErr);
      }
    }
  }
}

// 缓存 request_logs 表是否包含 client_ip 列的结果，避免每次请求都查询元数据
let clientIpColumnStatusPromise = null;

async function hasClientIpColumn() {
  if (!clientIpColumnStatusPromise) {
    clientIpColumnStatusPromise = executeQuery(
      `SHOW COLUMNS FROM request_logs LIKE 'client_ip'`
    )
      .then(([columnsResult]) => columnsResult.length > 0)
      .catch(error => {
        clientIpColumnStatusPromise = null;
        throw error;
      });
  }

  return clientIpColumnStatusPromise;
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(session({
  secret: AUTH_CONFIG.secret,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: NODE_ENV === 'production', // 在生产环境中使用HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24小时
  }
}));

// 身份验证中间件
function authMiddleware(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  // API请求返回401错误
  if (req.path.startsWith('/api/') && req.path !== '/api/auth/login') {
    return res.status(401).json({ error: 'Unauthorized', message: '请先登录' });
  }
  
  // 页面请求重定向到登录页
  if (req.path !== '/login' && !req.path.startsWith('/css/') && !req.path.startsWith('/js/')) {
    return res.redirect('/login');
  }
  
  next();
}

// 配置信息
const CONFIG = {
  API_URL: process.env.UPSTREAM_API_URL || 'https://www.gpt4novel.com/api/xiaoshuoai/ext/v1/chat/completions',
  DEFAULT_MODEL: process.env.UPSTREAM_DEFAULT_MODEL || 'nalang-xl-10',
  DEFAULT_TEMPERATURE: numberFromEnv('DEFAULT_TEMPERATURE', 0.7),
  DEFAULT_MAX_TOKENS: numberFromEnv('DEFAULT_MAX_TOKENS', 800),
  DEFAULT_TOP_P: numberFromEnv('DEFAULT_TOP_P', 0.35),
  DEFAULT_REPETITION_PENALTY: numberFromEnv('DEFAULT_REPETITION_PENALTY', 1.05)
};

let dynamicModelMapping = {};
if (process.env.MODEL_MAPPING_JSON) {
  try {
    dynamicModelMapping = JSON.parse(process.env.MODEL_MAPPING_JSON);
  } catch (error) {
    console.error('解析 MODEL_MAPPING_JSON 失败，将使用内置映射。', error);
  }
}

// 模型映射
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nalang-turbo-v19',
  'gpt-3.5-turbo-16k': 'nalang-xl-16k',
  'gpt-4': 'nalang-xl-10',
  'gpt-4-32k': 'nalang-xl-16k',
  'gpt-4-turbo': 'nalang-v17-2',
  'gpt-4-turbo-preview': 'nalang-v17-2',
  'nalang-turbo-v19': 'nalang-turbo-v19',
  'nalang-xl-16k': 'nalang-xl-16k',
  'nalang-xl-10': 'nalang-xl-10',
  'nalang-v17-2': 'nalang-v17-2',
  ...dynamicModelMapping
};

// 初始化数据库
async function initializeDatabase() {
  try {
    // 创建请求日志表
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        request_id VARCHAR(36) UNIQUE NOT NULL,
        client_ip VARCHAR(45) NOT NULL,
        user_agent TEXT,
        request_method VARCHAR(10) NOT NULL,
        request_path TEXT NOT NULL,
        request_headers JSON,
        request_body LONGTEXT,
        response_status INT,
        response_headers JSON,
        response_body LONGTEXT,
        response_time INT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_client_ip (client_ip),
        INDEX idx_request_path (request_path(100)),
        INDEX idx_response_status (response_status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 创建统计表
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS api_statistics (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date_key DATE NOT NULL,
        total_requests INT DEFAULT 0,
        successful_requests INT DEFAULT 0,
        failed_requests INT DEFAULT 0,
        avg_response_time DECIMAL(10,2) DEFAULT 0,
        total_tokens INT DEFAULT 0,
        unique_ips INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_date (date_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// 数据库迁移 - 添加缺失列
async function migrateDatabase() {
  try {
    // 检查request_logs表是否存在client_ip列
    const hasClientIp = await hasClientIpColumn();

    // 如果不存在client_ip列，添加它
    if (!hasClientIp) {
      await executeQuery(`
        ALTER TABLE request_logs
        ADD COLUMN client_ip VARCHAR(45) NOT NULL DEFAULT '127.0.0.1' AFTER request_id,
        ADD INDEX idx_client_ip (client_ip)
      `);
      console.log('✅ Added client_ip column to request_logs table');

      // 列添加成功后，更新缓存状态
      clientIpColumnStatusPromise = Promise.resolve(true);
    }

    console.log('✅ Database migration completed successfully');
  } catch (error) {
    console.error('❌ Database migration failed:', error);
    throw error;
  }
}

// 生成唯一请求ID
function generateRequestId() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
}

// 获取客户端IP
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '127.0.0.1';
}

// 记录请求日志
async function logRequest(logData) {
  try {
    // 根据列是否存在构建不同的SQL语句
    const hasClientIp = await hasClientIpColumn();
    let sql, params;

    if (hasClientIp) {
      // 如果存在client_ip列
      sql = `
        INSERT INTO request_logs (
          request_id, client_ip, user_agent, request_method, request_path,
          request_headers, request_body, response_status, response_headers,
          response_body, response_time, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      params = [
        logData.request_id,
        logData.clientIp || '127.0.0.1', // 使用请求上下文中的clientIp或默认值
        logData.user_agent,
        logData.request_method,
        logData.request_path,
        JSON.stringify(logData.request_headers),
        logData.request_body,
        logData.response_status,
        JSON.stringify(logData.response_headers),
        logData.response_body,
        logData.response_time,
        logData.error_message
      ];
    } else {
      // 如果不存在client_ip列
      sql = `
        INSERT INTO request_logs (
          request_id, user_agent, request_method, request_path,
          request_headers, request_body, response_status, response_headers,
        response_body, response_time, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      params = [
        logData.request_id,
        logData.user_agent,
        logData.request_method,
        logData.request_path,
        JSON.stringify(logData.request_headers),
        logData.request_body,
        logData.response_status,
        JSON.stringify(logData.response_headers),
        logData.response_body,
        logData.response_time,
        logData.error_message
      ];
    }
    
    await executeQuery(sql, params);
  } catch (error) {
    console.error('Failed to log request:', error);
  }
}

// 更新统计数据
async function updateStatistics(isSuccess, responseTime, tokenCount = 0) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 首先检查client_ip列是否存在
    const hasClientIp = await hasClientIpColumn();

    // 根据client_ip列是否存在构建唯一IP查询
    let uniqueIpsQuery = '1'; // 默认值，以防列不存在
    if (hasClientIp) {
      uniqueIpsQuery = `(
        SELECT COUNT(DISTINCT client_ip)
        FROM request_logs
        WHERE DATE(created_at) = ?
      )`;
    }
    
    const sql = `
      INSERT INTO api_statistics (
        date_key, total_requests, successful_requests, failed_requests,
        avg_response_time, total_tokens, unique_ips
      ) VALUES (?, 1, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        total_requests = total_requests + 1,
        successful_requests = successful_requests + ?,
        failed_requests = failed_requests + ?,
        avg_response_time = (avg_response_time * (total_requests - 1) + ?) / total_requests,
        total_tokens = total_tokens + ?,
        unique_ips = ${uniqueIpsQuery}
    `;
    
    const params = [
      today,
      isSuccess ? 1 : 0,
      isSuccess ? 0 : 1,
      responseTime,
      tokenCount,
      isSuccess ? 1 : 0,
      isSuccess ? 0 : 1,
      responseTime,
      tokenCount,
      ...(hasClientIp ? [today] : [])
    ];

    await executeQuery(sql, params);
  } catch (error) {
    console.error('Failed to update statistics:', error);
  }
}

// 日志记录中间件
function loggingMiddleware(req, res, next) {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const clientIp = getClientIp(req);
  
  // 存储请求信息 - 不包括client_ip，将在logRequest中动态添加
  req.logData = {
    request_id: requestId,
    user_agent: req.headers['user-agent'] || '',
    request_method: req.method,
    request_path: req.originalUrl || req.url,
    request_headers: { ...req.headers },
    request_body: req.method === 'POST' ? JSON.stringify(req.body) : '',
    response_status: null,
    response_headers: {},
    response_body: '',
    response_time: null,
    error_message: null
  };
  
  // 存储客户端IP以供后续使用
  req.clientIp = clientIp;

  // 捕获响应
  const originalSend = res.send;
  const originalJson = res.json;
  const originalEnd = res.end;
  
  let responseBody = '';
  let isStreamResponse = false;

  res.send = function(body) {
    if (!isStreamResponse) {
      responseBody = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return originalSend.call(this, body);
  };

  res.json = function(obj) {
    if (!isStreamResponse) {
      responseBody = JSON.stringify(obj);
    }
    return originalJson.call(this, obj);
  };

  res.end = function(chunk, encoding) {
    if (chunk && !isStreamResponse) {
      responseBody += chunk;
    }
    return originalEnd.call(this, chunk, encoding);
  };

  // 检查是否是流式响应
  const originalSetHeader = res.setHeader;
  res.setHeader = function(name, value) {
    if (name.toLowerCase() === 'content-type' && value.includes('text/event-stream')) {
      isStreamResponse = true;
      responseBody = '[STREAMING_RESPONSE]';
    }
    return originalSetHeader.call(this, name, value);
  };

  // 响应完成时记录日志
  res.on('finish', async () => {
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    req.logData.response_status = res.statusCode;
    req.logData.response_headers = res.getHeaders();
    req.logData.response_body = responseBody.length > 50000 ? 
      responseBody.substring(0, 50000) + '...[TRUNCATED]' : responseBody;
    req.logData.response_time = responseTime;
    req.logData.clientIp = req.clientIp; // 添加客户端IP
    
    // 记录到数据库
    await logRequest(req.logData);
    
    // 更新统计
    const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
    const tokenCount = estimateTokenCount(responseBody);
    await updateStatistics(isSuccess, responseTime, tokenCount);
    
    // 控制台日志
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${res.statusCode} - ${responseTime}ms - ${req.clientIp}`);
  });

  // 错误处理
  res.on('error', async (error) => {
    req.logData.error_message = error.message;
    req.logData.response_status = res.statusCode || 500;
    req.logData.response_time = Date.now() - startTime;
    req.logData.clientIp = req.clientIp; // 添加客户端IP
    
    await logRequest(req.logData);
    console.error(`[${new Date().toISOString()}] ERROR ${req.method} ${req.originalUrl} - ${error.message} - ${req.clientIp}`);
  });

  next();
}

// 估算Token数量
function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') return 0;
  // 简单估算：1个token约等于4个字符
  return Math.ceil(text.length / 4);
}

// 应用日志中间件
app.use(loggingMiddleware);

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

    const {
      model = CONFIG.DEFAULT_MODEL,
      messages = [],
      stream = false,
      temperature = CONFIG.DEFAULT_TEMPERATURE,
      max_tokens = CONFIG.DEFAULT_MAX_TOKENS,
      top_p = CONFIG.DEFAULT_TOP_P,
      repetition_penalty = CONFIG.DEFAULT_REPETITION_PENALTY,
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

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages parameter is required and must be a non-empty array.',
          type: 'invalid_request_error'
        }
      });
    }

    const mappedModel = MODEL_MAPPING[model] || model;

    const shouldStream = typeof stream === 'string'
      ? stream === 'true'
      : Boolean(stream);

    const requestBody = {
      model: mappedModel,
      messages: messages,
      stream: shouldStream,
      temperature: temperature,
      max_tokens: max_tokens,
      top_p: top_p,
      repetition_penalty: repetition_penalty
    };

    const optionalParams = {
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
    };

    for (const [key, value] of Object.entries(optionalParams)) {
      if (value !== undefined) {
        requestBody[key] = value;
      }
    }

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
      return res.status(response.status).json({
        error: {
          message: `API request failed: ${response.status} ${response.statusText}`,
          type: 'api_error',
          details: errorText
        }
      });
    }

    const responseContentType = response.headers.get('content-type') || '';

    if (shouldStream || responseContentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

      const decoder = new TextDecoder();
      let buffer = '';
      let isFirstChunk = true;
      let hasEnded = false;

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

      req.on('close', () => {
        if (!hasEnded) {
          hasEnded = true;
          response.body.destroy();
        }
      });

    } else {
      try {
        const rawResponse = await response.text();
        let parsedResponse = null;

        try {
          parsedResponse = JSON.parse(rawResponse);
        } catch (parseError) {
          // 如果不是合法的JSON，则退回到构造OpenAI兼容格式
        }

        if (parsedResponse && typeof parsedResponse === 'object') {
          res.json(parsedResponse);
          return;
        }

        const openaiResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: rawResponse
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: estimateTokenCount(JSON.stringify(messages)),
            completion_tokens: estimateTokenCount(rawResponse),
            total_tokens: estimateTokenCount(JSON.stringify(messages)) + estimateTokenCount(rawResponse)
          }
        };

        res.json(openaiResponse);
      } catch (nonStreamError) {
        console.error('Error handling non-stream response:', nonStreamError);
        res.status(500).json({
          error: {
            message: 'Failed to process API response',
            type: 'api_error',
            details: nonStreamError.message
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

// API路由
app.post('/v1/chat/completions', handleChatCompletion);

// 登录和认证路由
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: '用户名和密码均为必填项'
    });
  }

  if (verifyCredentials(username, password)) {
    req.session.authenticated = true;
    req.session.username = username;
    res.json({ success: true });
  } else {
    res.status(401).json({
      success: false, 
      message: '用户名或密码错误' 
    });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('退出登录出错:', err);
      return res.status(500).json({ success: false, message: '退出失败' });
    }
    res.json({ success: true });
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authenticated: !!req.session.authenticated,
    username: req.session.username || null
  });
});

// 页面路由
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/logs');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/logs', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// 应用认证中间件到需要保护的路由
app.use('/api/logs', authMiddleware);
app.use('/api/stats', authMiddleware);

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

  req.body = {
    model: model,
    messages: [
      { role: 'user', content: message }
    ],
    stream: stream === 'true'
  };

  handleChatCompletion(req, res);
});

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

// 日志查看API
app.get('/api/logs', async (req, res) => {
  try {
    // 确保分页参数是有效的数字
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;
    
    const { status, ip, search } = req.query;
    
    let whereClause = 'WHERE 1=1';
    const params = [];
    
    if (status) {
      whereClause += ' AND response_status = ?';
      params.push(status);
    }
    
    if (ip) {
      whereClause += ' AND client_ip = ?';
      params.push(ip);
    }
    
    if (search) {
      whereClause += ' AND (request_path LIKE ? OR request_body LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    // 使用安全查询函数和字符串插值
    const limitValue = Number(limit);
    const offsetValue = Number(offset);
    
    // 查询日志数据
    const logsQuery = `
      SELECT * FROM request_logs 
      ${whereClause}
      ORDER BY created_at DESC 
      LIMIT ${limitValue} OFFSET ${offsetValue}
    `;
    
    // 查询总数
    const countQuery = `
      SELECT COUNT(*) as total FROM request_logs ${whereClause}
    `;
    
    // 并行执行查询
    const [rowsResult, countResult] = await Promise.all([
      executeQuery(logsQuery, params),
      executeQuery(countQuery, params)
    ]);
    
    const rows = rowsResult[0];
    const total = countResult[0][0].total;
    
    res.json({
      data: rows,
      pagination: {
        page: page,
        limit: limit,
        total: total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// 统计API
app.get('/api/stats', async (req, res) => {
  try {
    // 确保天数参数是有效的数字
    const days = Math.min(90, Math.max(1, Number(req.query.days || 7)));
    
    // 获取指定天数的统计数据
    const statsQuery = `
      SELECT * FROM api_statistics 
      WHERE date_key >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY date_key DESC
    `;
    
    // 并行执行基本查询
    const [statsResult, hasClientIp] = await Promise.all([
      executeQuery(statsQuery, [Number(days)]),
      hasClientIpColumn()
    ]);

    const stats = statsResult[0];

    // 获取今日实时统计
    let todayStatsQuery;
    if (hasClientIp) {
      todayStatsQuery = `
        SELECT
          COUNT(*) as total_requests,
          COUNT(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 END) as successful_requests,
          COUNT(CASE WHEN response_status >= 400 THEN 1 END) as failed_requests,
          AVG(response_time) as avg_response_time,
          COUNT(DISTINCT client_ip) as unique_ips
        FROM request_logs 
        WHERE DATE(created_at) = CURDATE()
      `;
    } else {
      todayStatsQuery = `
        SELECT 
          COUNT(*) as total_requests,
          COUNT(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 END) as successful_requests,
          COUNT(CASE WHEN response_status >= 400 THEN 1 END) as failed_requests,
          AVG(response_time) as avg_response_time,
          0 as unique_ips
        FROM request_logs
        WHERE DATE(created_at) = CURDATE()
      `;
    }

    // 获取错误统计
    const errorStatsQuery = `
      SELECT response_status, COUNT(*) as count
      FROM request_logs 
      WHERE response_status >= 400 AND DATE(created_at) = CURDATE()
      GROUP BY response_status 
      ORDER BY count DESC
    `;
    
    // 构建最活跃IP查询
    let topIpsQuery = null;
    if (hasClientIp) {
      topIpsQuery = `
        SELECT client_ip, COUNT(*) as request_count
        FROM request_logs
        WHERE DATE(created_at) = CURDATE()
        GROUP BY client_ip
        ORDER BY request_count DESC 
        LIMIT 10
      `;
    }
    
    // 并行执行其余查询
    const queries = [
      executeQuery(todayStatsQuery),
      executeQuery(errorStatsQuery)
    ];
    
    if (topIpsQuery) {
      queries.push(executeQuery(topIpsQuery));
    }
    
    const results = await Promise.all(queries);
    
    const todayStats = results[0][0];
    const errorStats = results[1][0];
    const topIps = topIpsQuery ? results[2][0] : [];
    
    res.json({
      historical: stats,
      today: todayStats[0],
      topIps: topIps,
      errors: errorStats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 根路径 - 根据登录状态重定向
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.redirect('/logs');
  } else {
    res.redirect('/login');
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.logData) {
    req.logData.error_message = err.message;
  }
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error'
    }
  });
});

// 启动服务器
async function startServer() {
  try {
    await initializeDatabase();
    await migrateDatabase();
    
    app.listen(PORT, () => {
      console.log(`🚀 OpenAI API Proxy Server running on port ${PORT}`);
      console.log(`📊 Logs Dashboard: http://localhost:${PORT}/logs`);
      console.log(`📈 Statistics API: http://localhost:${PORT}/api/stats`);
      console.log(`📝 Logs API: http://localhost:${PORT}/api/logs`);
      console.log(`🏥 Health Check: http://localhost:${PORT}/health`);
      console.log(`📚 Models List: http://localhost:${PORT}/v1/models`);
      console.log(`⚠️  Note: All requests are logged to MySQL database`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
