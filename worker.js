const isDeno = typeof Deno !== 'undefined';
const isCf =
  !isDeno &&
  typeof Request !== 'undefined' &&
  typeof Request.prototype !== 'undefined';

// 获取环境变量
const SERVER_TYPE = isDeno ? 'DENO' : isCf ? 'CF' : 'VPS';
function getEnv(key, env = {}) {
  if (isDeno) {
    return Deno.env.get(key) || '';
  } else if (typeof process !== 'undefined' && process.env) {
    // Node.js 环境
    return process.env[key] || '';
  } else {
    // Cloudflare Workers环境，从传入的 env 对象获取
    return env[key] || '';
  }
}

// ⚠️注意: 仅当您有密码共享需求时才需要配置 SECRET_PASSWORD 和 API_KEYS 这两个环境变量! 否则您无需配置, 默认会使用WebUI填写的API Key进行请求
// 这里是您和您的朋友共享的密码, 优先使用环境变量, 双竖线后可以直接硬编码(例如 'yijiaren.308' 免得去管理面板配置环境变量了, 但极不推荐这么做!)
const SECRET_PASSWORD_DEFAULT = `yijiaren.${~~(Math.random() * 1000)}`;
// 这里是您的API密钥清单, 多个时使用逗号分隔, 会轮询(随机)使用, 同样也是优先使用环境变量, 其次使用代码中硬写的值, 注意不要在公开代码仓库中提交密钥的明文信息, 谨防泄露!!
const API_KEYS_DEFAULT = 'sk-xxxxx,sk-yyyyy';
const MODEL_IDS_DEFAULT = 'gpt-5-pro,gpt-5,gpt-5-mini';
const API_BASE_DEFAULT = 'https://api.openai.com';
const DEMO_PASSWORD_DEFAULT = '';
const DEMO_MAX_TIMES_PER_HOUR_DEFAULT = 15;
const TITLE_DEFAULT = 'OpenAI Chat';

// KV 存储适配器 - 兼容 Cloudflare Workers 和 Deno Deploy
let kvStore = null;

/**
 * 初始化 KV 存储
 * @param {Object} env - 环境变量对象（Cloudflare Workers 会传入）
 */
async function initKV(env = {}) {
  if (isDeno) {
    // Deno Deploy: 使用 Deno KV
    try {
      kvStore = await Deno.openKv();
    } catch (error) {
      console.error('Failed to open Deno KV:', error);
      kvStore = null;
    }
  } else if (env.KV) {
    // Cloudflare Workers: 使用绑定的 KV namespace
    kvStore = env.KV;
  } else {
    // 没有 KV 存储，使用内存模拟（不推荐用于生产环境）
    console.warn('KV storage not available, using in-memory fallback');
    kvStore = null;
  }
  return kvStore;
}

/**
 * 从 KV 存储获取值
 * @param {string} key - 键名
 * @returns {Promise<any>} - 返回解析后的 JSON 对象，如果不存在返回 null
 */
async function getKV(key) {
  if (!kvStore) {
    return null;
  }

  try {
    if (isDeno) {
      // Deno KV
      const result = await kvStore.get([key]);
      return result.value;
    } else {
      // Cloudflare Workers KV
      const value = await kvStore.get(key, { type: 'json' });
      return value;
    }
  } catch (error) {
    console.error('KV get error:', error);
    return null;
  }
}

/**
 * 向 KV 存储设置值
 * @param {string} key - 键名
 * @param {any} value - 要存储的值（会被序列化为 JSON）
 * @param {number} ttl - 过期时间（秒），可选
 * @returns {Promise<boolean>} - 成功返回 true
 */
async function setKV(key, value, ttl = null) {
  if (!kvStore) {
    return false;
  }

  try {
    if (isDeno) {
      // Deno KV
      const options = ttl ? { expireIn: ttl * 1000 } : {};
      await kvStore.set([key], value, options);
      return true;
    } else {
      // Cloudflare Workers KV
      const options = ttl ? { expirationTtl: ttl } : {};
      await kvStore.put(key, JSON.stringify(value), options);
      return true;
    }
  } catch (error) {
    console.error('KV set error:', error);
    return false;
  }
}

// 临时演示密码记忆（仅作为 KV 不可用时的后备方案）
const demoMemory = {
  hour: 0,
  times: 0,
  maxTimes: DEMO_MAX_TIMES_PER_HOUR_DEFAULT
};

// API Key 轮询索引
let apiKeyIndex = 0;

// 通用的请求处理函数
async function handleRequest(request, env = {}) {
  // 初始化 KV 存储
  await initKV(env);

  // 从环境变量获取配置
  const SECRET_PASSWORD =
    getEnv('SECRET_PASSWORD', env) || SECRET_PASSWORD_DEFAULT;
  const API_KEYS = getEnv('API_KEYS', env) || API_KEYS_DEFAULT;
  const API_KEY_LIST = (API_KEYS || '')
    .split(',')
    .map(i => i.trim())
    .filter(i => i);
  const MODEL_IDS = getEnv('MODEL_IDS', env) || MODEL_IDS_DEFAULT;
  const API_BASE = (getEnv('API_BASE', env) || API_BASE_DEFAULT).replace(
    /\/$/,
    ''
  );
  const DEMO_PASSWORD = getEnv('DEMO_PASSWORD', env) || DEMO_PASSWORD_DEFAULT;
  const DEMO_MAX_TIMES =
    parseInt(getEnv('DEMO_MAX_TIMES_PER_HOUR', env)) ||
    DEMO_MAX_TIMES_PER_HOUR_DEFAULT;
  const TAVILY_KEYS = getEnv('TAVILY_KEYS', env) || '';
  const TAVILY_KEY_LIST = (TAVILY_KEYS || '')
    .split(',')
    .map(i => i.trim())
    .filter(i => i);
  const TITLE = getEnv('TITLE', env) || TITLE_DEFAULT;

  let CHAT_TYPE = 'bot';
  if (/openai/i.test(TITLE)) {
    CHAT_TYPE = 'openai';
  } else if (/gemini/i.test(TITLE)) {
    CHAT_TYPE = 'gemini';
  } else if (/claude/i.test(TITLE)) {
    CHAT_TYPE = 'claude';
  } else if (/qwen/i.test(TITLE)) {
    CHAT_TYPE = 'qwen';
  } else if (/deepseek/i.test(TITLE)) {
    CHAT_TYPE = 'deepseek';
  } else if (/router/i.test(TITLE)) {
    CHAT_TYPE = 'router';
  }

  /**
   * 检查并更新 demo 密码的调用次数
   * @param {number} increment - 要增加的次数，默认为 1
   * @returns {Promise<{allowed: boolean, message: string, data: object}>}
   */
  async function checkAndUpdateDemoCounter(increment = 1) {
    const hour = Math.floor(Date.now() / 3600000);
    const kvKey = 'demo_counter';

    // 尝试从 KV 获取计数器数据
    let demoData = await getKV(kvKey);

    if (!demoData || demoData.hour !== hour) {
      // KV 中没有数据或者已经过了一个小时，重置计数器
      demoData = {
        hour: hour,
        times: 0,
        maxTimes: DEMO_MAX_TIMES
      };
    }

    // 检查是否超过最大调用次数
    if (demoData.times >= demoData.maxTimes) {
      return {
        allowed: false,
        message: `Exceeded maximum API calls (${demoData.maxTimes}) for this hour. Please try again next hour.`,
        data: demoData
      };
    }

    // 增加计数
    demoData.times += increment;

    // 保存到 KV（不设置过期时间，下次检查时会自动重置）
    await setKV(kvKey, demoData);

    // 如果 KV 存储失败，回退到内存记忆（仅当前实例有效）
    if (!kvStore) {
      if (demoMemory.hour === hour) {
        if (demoMemory.times >= DEMO_MAX_TIMES) {
          return {
            allowed: false,
            message: `Exceeded maximum API calls (${DEMO_MAX_TIMES}) for this hour`,
            data: { hour, times: demoMemory.times, maxTimes: DEMO_MAX_TIMES }
          };
        }
      } else {
        demoMemory.hour = hour;
        demoMemory.times = 0;
      }
      demoMemory.times += increment;
    }

    return {
      allowed: true,
      message: 'OK',
      data: demoData
    };
  }

  /**
   * 验证并处理 API Key
   * @param {string} apiKey - 原始 API Key
   * @param {number} demoIncrement - Demo 密码的计数增量，默认为 1
   * @returns {Promise<{valid: boolean, apiKey: string, error?: Response}>}
   */
  async function validateAndProcessApiKey(apiKey, demoIncrement = 1) {
    if (!apiKey) {
      return {
        valid: false,
        apiKey: '',
        error: createErrorResponse(
          'Missing API key. Provide via ?key= parameter or Authorization header',
          401
        )
      };
    }

    // 检查是否是共享密码
    if (apiKey === SECRET_PASSWORD) {
      return {
        valid: true,
        apiKey: getNextApiKey(API_KEY_LIST)
      };
    }

    // 检查是否是临时演示密码
    if (apiKey === DEMO_PASSWORD && DEMO_PASSWORD) {
      const result = await checkAndUpdateDemoCounter(demoIncrement);
      if (!result.allowed) {
        return {
          valid: false,
          apiKey: '',
          error: createErrorResponse(result.message, 429)
        };
      }
      return {
        valid: true,
        apiKey: getNextApiKey(API_KEY_LIST)
      };
    }

    // 不是两类密码的情况下,如果传入的apiKey长度少于10位,认为是无效的密码(因为一般情况下各类系统的API Key不会短于这个长度)
    if (apiKey.length <= 10) {
      return {
        valid: false,
        apiKey: '',
        error: createErrorResponse('Wrong password.', 401)
      };
    }

    // 其他情况，使用原始 API Key
    return {
      valid: true,
      apiKey: apiKey
    };
  }

  const url = new URL(request.url);
  const apiPath = url.pathname;
  const apiMethod = request.method.toUpperCase();

  // 处理HTML页面请求
  if (apiPath === '/' || apiPath === '/index.html') {
    const htmlContent = getHtmlContent(MODEL_IDS, TAVILY_KEYS, TITLE);
    return new Response(htmlContent, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=14400' // 缓存4小时
      }
    });
  }

  if (apiPath === '/favicon.svg') {
    const svgContent = getSvgContent(CHAT_TYPE);
    return new Response(svgContent, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=43200' // 缓存12小时
      }
    });
  }

  if (apiPath === '/manifest.json' || apiPath === '/site.webmanifest') {
    const manifestContent = getManifestContent(TITLE);
    return new Response(manifestContent, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'public, max-age=43200' // 缓存12小时
      }
    });
  }

  // 直接返回客户端的原本的请求信息(用于调试)
  if (apiPath === '/whoami') {
    return new Response(
      JSON.stringify({
        serverType: SERVER_TYPE,
        serverInfo: isDeno
          ? {
              target: Deno.build.target,
              os: Deno.build.os,
              arch: Deno.build.arch,
              vendor: Deno.build.vendor
            }
          : request.cf || 'unknown',
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        method: request.method,
        bodyUsed: request.bodyUsed
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // 调用tavily搜索API
  if (apiPath === '/search' && apiMethod === 'POST') {
    let apiKey =
      url.searchParams.get('key') || request.headers.get('Authorization') || '';
    apiKey = apiKey.replace('Bearer ', '').trim();
    // 从body中获取query参数
    const query = (await request.json()).query || '';
    if (!query) {
      return createErrorResponse('Missing query parameter', 400);
    }

    const keyValidation = await validateAndProcessApiKey(apiKey, 0.1);
    if (!keyValidation.valid) {
      return keyValidation.error;
    }

    const modelPrompt = getTavilyPrompt(query);
    const model = getLiteModelId(MODEL_IDS);
    let modelUrl = `${API_BASE}/v1/chat/completions`;
    modelUrl = replaceApiUrl(modelUrl);
    const modelPayload = {
      model,
      messages: [
        {
          role: 'user',
          content: modelPrompt.trim()
        }
      ]
    };
    let modelResponse;
    try {
      modelResponse = await doWithTimeout(
        fetch(modelUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + getNextApiKey(API_KEY_LIST)
          },
          body: JSON.stringify(modelPayload)
        }),
        30000 // 30秒超时
      );
    } catch (error) {
      console.error('Search tavily failed:', error);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    // 接下来从modelResponse中提取content
    const modelJsonData = await modelResponse.json();
    const content = modelJsonData.choices?.[0]?.message?.content || '';
    // 从中找到反引号`的位置, 提取反引号里包裹的内容
    // 从结果中找到花括号内容, 提取为JSON
    const jsonMatch = content.replace(/\n/g, '').match(/({.*})/);
    let searchJson = jsonMatch ? jsonMatch[1].trim() : content;
    try {
      searchJson = JSON.parse(searchJson);
    } catch (e) {
      searchJson = null;
    }
    if (!searchJson || searchJson.num_results === 0) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    // 并发请求所有搜索关键词
    const searchPromises = searchJson.search_queries.map(
      async searchKeyword => {
        const tavilyUrl = 'https://api.tavily.com/search';
        const tavilyKey = getRandomApiKey(TAVILY_KEY_LIST);
        const payload = {
          query: searchKeyword,
          max_results: searchJson.num_results,
          include_answer: 'basic',
          auto_parameters: true,
          exclude_domains: [
            // 此处排除:带有明显zz色彩/偏见的网站,确保搜索结果不混入其内容
            // 不可解释
            'ntdtv.com',
            'ntd.tv',
            'aboluowang.com',
            'epochtimes.com',
            'epochtimes.jp',
            'dafahao.com',
            'minghui.org',

            // 其他强烈偏见性媒体
            'secretchina.com',
            'kanzhongguo.com',
            'soundofhope.org',
            'rfa.org',
            'bannedbook.org',
            'boxun.com',
            'peacehall.com',
            'creaders.net',
            'backchina.com',

            // 其他方向的偏见性媒体
            'guancha.cn', // 观察者网（强烈民族主义倾向）
            'wenxuecity.com', // 文学城（部分内容质量参差）

            // 阴谋论和伪科学网站
            'awaker.cn',
            'tuidang.org',

            // === 英文媒体 ===
            // 极右翼/阴谋论
            'breitbart.com', // Breitbart News（已被维基百科弃用）
            'infowars.com', // InfoWars（阴谋论）
            'naturalnews.com', // Natural News（伪科学）
            'globalresearch.ca', // Global Research（阴谋论，维基百科黑名单）
            'zerohedge.com', // Zero Hedge（极端金融偏见）
            'thegatewaypu<wbr>ndit.com', // Gateway Pundit（虚假新闻）
            'newsmax.com', // Newsmax（强烈保守派偏见）
            'oann.com', // One America News（虚假信息）
            'dailywire.com', // Daily Wire（强烈保守派）
            'theblaze.com', // The Blaze（维基百科认定不可靠）
            'redstate.com', // RedState（党派性强）
            'thenationalpulse.com', // National Pulse（极右翼）
            'thefederalist.com', // The Federalist（强烈保守派）

            // 极左翼
            'dailykos.com', // Daily Kos（维基百科建议避免）
            'alternet.org', // AlterNet（维基百科认定不可靠）
            'commondreams.org', // Common Dreams（强烈左翼）
            'thecanary.co', // The Canary（维基百科认定不可靠）
            'occupy<wbr>democrats.com', // Occupy Democrats（党派性强）
            'truthout.org', // Truthout（强烈左翼）

            // 小报和低质量新闻
            'dailymail.co.uk', // Daily Mail（维基百科弃用）
            'thesun.co.uk', // The Sun（小报）
            'nypost.com', // New York Post（质量参差）
            'express.co.uk', // Daily Express（维基百科认定不可靠）
            'mirror.co.uk', // Daily Mirror（小报）
            'dailystar.co.uk', // Daily Star（小报）

            // 讽刺/虚假新闻网站
            'theonion.com', // The Onion（讽刺网站）
            'clickhole.com', // ClickHole（讽刺）
            'babylonbee.com', // Babylon Bee（讽刺）
            'newspunch.com', // News Punch/Your News Wire（虚假新闻）
            'beforeitsnews.com', // Before It's News（阴谋论）

            // 俄罗斯国家媒体
            'rt.com', // RT（Russia Today）
            'sputniknews.com', // Sputnik News
            'tass.com', // TASS（需谨慎）

            // 其他问题网站
            'wikileaks.org', // WikiLeaks（主要来源，需谨慎）
            'mediabiasfactcheck.com', // Media Bias Fact Check（维基百科不建议引用）
            'allsides.com' // AllSides（维基百科认为不可靠）
          ]
        };

        try {
          const response = await fetch(tavilyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + tavilyKey
            },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            console.error(
              `Tavily API request failed for "${searchKeyword}":`,
              response.status
            );
            return null;
          }

          return await response.json();
        } catch (error) {
          console.error(
            `Error fetching Tavily results for "${searchKeyword}":`,
            error
          );
          return null;
        }
      }
    );

    // 等待所有请求完成
    const searchResults = await Promise.all(searchPromises);

    // 过滤掉失败的请求，合并结果
    const validResults = searchResults.filter(result => result !== null);

    return new Response(JSON.stringify(validResults), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  // 总结会话
  if (apiPath === '/summarize' && apiMethod === 'POST') {
    let apiKey =
      url.searchParams.get('key') || request.headers.get('Authorization') || '';
    apiKey = apiKey.replace('Bearer ', '').trim();

    // 从body中获取question和answer参数
    const { question, answer } = await request.json();
    if (!question || !answer) {
      return createErrorResponse('Missing question or answer parameter', 400);
    }

    const keyValidation = await validateAndProcessApiKey(apiKey, 0.1);
    if (!keyValidation.valid) {
      return keyValidation.error;
    }

    // 检查是否是有效的密码（SECRET_PASSWORD 或 DEMO_PASSWORD）
    if (![DEMO_PASSWORD, SECRET_PASSWORD].includes(apiKey)) {
      return createErrorResponse('Invalid API key. Provide a valid key.', 403);
    }

    // 截取question和answer，避免过长
    const truncatedQuestion =
      question.length <= 300
        ? question
        : question.slice(0, 150) + '......' + question.slice(-150);
    const truncatedAnswer =
      answer.length <= 300
        ? answer
        : answer.slice(0, 150) + '......' + answer.slice(-150);

    // 构建总结提示词
    const summaryPrompt = `请为以下对话生成一个简短的标题（不超过20个字）：

问题：
\`\`\`
${truncatedQuestion}
\`\`\`

回答：
\`\`\`
${truncatedAnswer}
\`\`\`

要求：
1. 标题要简洁明了，能概括对话的核心内容
2. 不要使用引号或其他标点符号包裹
3. 直接输出标题文本即可`;

    const messages = [
      {
        role: 'user',
        content: summaryPrompt
      }
    ];

    // 选择合适的精简模型
    const summaryModel = getLiteModelId(MODEL_IDS);
    let modelUrl = `${API_BASE}/v1/chat/completions`;
    modelUrl = replaceApiUrl(modelUrl);

    const modelPayload = {
      model: summaryModel,
      messages: messages,
      max_tokens: 300
    };

    try {
      const modelResponse = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + getNextApiKey(API_KEY_LIST)
        },
        body: JSON.stringify(modelPayload)
      });

      if (!modelResponse.ok) {
        throw new Error('Model API request failed');
      }

      const modelJsonData = await modelResponse.json();
      const summary = modelJsonData.choices?.[0]?.message?.content || '';

      return new Response(
        JSON.stringify({
          success: true,
          summary: summary.trim()
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error) {
      console.error('Generate summary failed:', error);
      return createErrorResponse('Failed to generate summary', 500);
    }
  }

  // 处理 WebDAV 代理的 OPTIONS 预检请求（必须放在 WebDAV 代理逻辑之前）
  if (apiMethod === 'OPTIONS' && apiPath.startsWith('/webdav')) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
          'GET, PUT, POST, DELETE, PROPFIND, MKCOL, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, Depth, X-WebDAV-URL, X-WebDAV-Auth',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  // WebDAV 代理接口 - 解决跨域问题
  if (apiPath === '/webdav' || apiPath.startsWith('/webdav/')) {
    // 从请求头获取 WebDAV 配置
    const webdavUrl = request.headers.get('X-WebDAV-URL');
    const webdavAuth = request.headers.get('X-WebDAV-Auth');

    if (!webdavUrl) {
      return createErrorResponse('Missing X-WebDAV-URL header', 400);
    }

    // 构建目标 URL
    // 如果路径是 /webdav/xxx，则将 /xxx 附加到 webdavUrl
    let targetUrl = webdavUrl;
    if (apiPath.startsWith('/webdav/')) {
      const subPath = apiPath.substring(7); // 移除 '/webdav'
      targetUrl = webdavUrl.replace(/\/$/, '') + subPath;
    }

    // 构建转发请求的 headers
    const forwardHeaders = new Headers();

    // 添加标准 User-Agent，避免某些服务器拒绝空或异常的 UA
    forwardHeaders.set('User-Agent', 'WebDAV-Client/1.0');

    if (webdavAuth) {
      forwardHeaders.set('Authorization', webdavAuth);
    }

    // 复制某些必要的请求头
    const contentType = request.headers.get('Content-Type');
    if (contentType) {
      forwardHeaders.set('Content-Type', contentType);
    }

    // PROPFIND 需要 Depth 头
    const depth = request.headers.get('Depth');
    if (depth) {
      forwardHeaders.set('Depth', depth);
    }

    // 获取请求体
    let requestBody = null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(apiMethod)) {
      requestBody = await request.text();
      // 对于有内容的请求，设置 Content-Length
      if (requestBody) {
        forwardHeaders.set(
          'Content-Length',
          new TextEncoder().encode(requestBody).length.toString()
        );
      }
    }

    try {
      // 调试日志
      console.log('[WebDAV Proxy] Method:', apiMethod);
      console.log('[WebDAV Proxy] Target URL:', targetUrl);
      console.log(
        '[WebDAV Proxy] Headers:',
        Object.fromEntries(forwardHeaders.entries())
      );

      // 转发请求到 WebDAV 服务器
      // 使用 redirect: 'manual' 避免 HTTP 重定向时 PUT 变成 GET 的问题
      const webdavResponse = await fetch(targetUrl, {
        method: apiMethod,
        headers: forwardHeaders,
        body: requestBody,
        redirect: 'manual'
      });

      // 如果是重定向响应，记录日志
      if ([301, 302, 303, 307, 308].includes(webdavResponse.status)) {
        const location = webdavResponse.headers.get('Location');
        console.log('[WebDAV Proxy] Redirect detected! Location:', location);
        // 返回错误提示用户使用 HTTPS
        return createErrorResponse(
          'WebDAV 服务器返回重定向，请检查是否需要使用 HTTPS URL。重定向目标: ' +
            location,
          502
        );
      }

      // 调试日志
      console.log('[WebDAV Proxy] Response Status:', webdavResponse.status);

      // 构建响应头，添加 CORS 头
      const responseHeaders = new Headers(webdavResponse.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set(
        'Access-Control-Allow-Methods',
        'GET, PUT, POST, DELETE, PROPFIND, MKCOL, OPTIONS'
      );
      responseHeaders.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Depth, X-WebDAV-URL, X-WebDAV-Auth'
      );

      // 移除 WWW-Authenticate 头，避免浏览器弹出原生认证框
      responseHeaders.delete('WWW-Authenticate');

      return new Response(webdavResponse.body, {
        status: webdavResponse.status,
        statusText: webdavResponse.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      console.error('WebDAV proxy error:', error);
      return createErrorResponse('WebDAV proxy error: ' + error.message, 502);
    }
  }

  if (!apiPath.startsWith('/v1')) {
    return createErrorResponse(
      apiPath + ' Invalid API path. Must start with /v1',
      400
    );
  }

  // 2. 获取和验证API密钥
  let apiKey =
    url.searchParams.get('key') || request.headers.get('Authorization') || '';
  apiKey = apiKey.replace('Bearer ', '').trim();
  let urlSearch = url.searchParams.toString();

  const originalApiKey = apiKey;
  const keyValidation = await validateAndProcessApiKey(apiKey);
  if (!keyValidation.valid) {
    return keyValidation.error;
  }

  apiKey = keyValidation.apiKey;

  // 替换 URL 中的密码为实际 API Key
  if (originalApiKey === SECRET_PASSWORD) {
    urlSearch = urlSearch.replace(`key=${SECRET_PASSWORD}`, `key=${apiKey}`);
  } else if (originalApiKey === DEMO_PASSWORD) {
    urlSearch = urlSearch.replace(`key=${DEMO_PASSWORD}`, `key=${apiKey}`);
  }

  // 3. 构建请求
  let fullPath = `${API_BASE}${apiPath}`;
  fullPath = replaceApiUrl(fullPath);
  const targetUrl = `${fullPath}?${urlSearch}`;
  const proxyRequest = buildProxyRequest(request, apiKey);

  // 4. 发起请求并处理响应
  try {
    const response = await fetch(targetUrl, proxyRequest);

    // 直接透传响应 - 无缓冲流式处理
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    });
  } catch (error) {
    console.error('Proxy request failed:', error);
    return createErrorResponse('Proxy request failed', 502);
  }
}

// Cloudflare Workers 导出
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

// // Deno Deploy 支持
// if (isDeno) {
//   Deno.serve(handleRequest);
// }

/**
 * 构建代理请求配置
 */
function buildProxyRequest(originalRequest, apiKey) {
  const headers = new Headers();

  // 复制必要的请求头
  const headersToForward = [
    'content-type',
    'accept',
    'accept-encoding',
    'user-agent'
  ];

  headersToForward.forEach(headerName => {
    const value = originalRequest.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  });

  // 设置API密钥
  headers.set('Authorization', `Bearer ${apiKey}`);

  return {
    method: originalRequest.method,
    headers: headers,
    body: originalRequest.body,
    redirect: 'follow'
  };
}

/**
 * 创建错误响应
 */
function createErrorResponse(message, status) {
  return new Response(
    JSON.stringify({
      error: message,
      timestamp: new Date().toISOString()
    }),
    {
      status: status,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}

/**
 * 为 Promise 添加超时控制
 * @param {Promise} promise - 需要执行的 Promise
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise} 返回一个带超时控制的 Promise
 */
function doWithTimeout(promise, timeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`请求超时（${timeout}ms）`)), timeout)
    )
  ]);
}

/**
 * 轮询获取下一个 API Key
 * 使用递增索引方式，避免同一时间多个请求使用同一个 Key
 */
function getNextApiKey(apiKeyList) {
  if (!apiKeyList || apiKeyList.length === 0) {
    throw new Error('API Key list is empty');
  }
  const key = apiKeyList[apiKeyIndex % apiKeyList.length];
  apiKeyIndex = (apiKeyIndex + 1) % apiKeyList.length;
  return key;
}

function getRandomApiKey(apiKeyList) {
  if (!apiKeyList || apiKeyList.length === 0) {
    throw new Error('API Key list is empty');
  }
  const randomIndex = Math.floor(Math.random() * apiKeyList.length);
  return apiKeyList[randomIndex];
}

function getLiteModelId(modelIds) {
  if (!modelIds) return 'gemini-2.5-flash-lite';
  const models = modelIds
    .split(',')
    .filter(i => i)
    .map(i => i.split('=')[0].trim())
    .filter(i => i);
  const parts = [
    'deepseek-v',
    'qwen3-next',
    '-oss-',
    '-mini',
    'qwen3-max',
    '-k2',
    '-nano',
    '-flash',
    '-lite',
    '-instruct',
    '-fast',
    '-dash',
    '-alpha',
    '-haiku',
    '-4o',
    '-r1',
    '-air',
    'gpt'
  ];
  let model = models[0];
  for (const p of parts) {
    const match = models.find(m => m.toLowerCase().includes(p));
    if (match) {
      model = match;
      break;
    }
  }
  return model;
}

function replaceApiUrl(url) {
  const isGemini = [
    'generativelanguage.googleapis.com',
    'gateway.ai.cloudflare.com'
  ].some(p => url.includes(p));
  if (!isGemini) {
    return url;
  } else {
    url = url
      .replace('/v1/chat', '/v1beta/openai/chat')
      .replace('/v1/models', '/v1beta/openai/models');
    return url;
  }
}

function getTavilyPrompt(query) {
  const str = `
# Role: Advanced Search Strategist

## 核心定位
你是Max，一个专为Tavily Search API设计的搜索策略生成器。你的唯一目标是**最大化信息获取的广度与深度**，同时通过精准的关键词设计避免信息冗余或无关联性。

## 关键任务
从用户的自然语言中提取意图，构造 **0 到 5 个** 搜索关键词，并设定合适的结果数量。

## 决策流程

### 第一步：是否搜索 (Search-Or-Not Determination)
判断用户输入是否需要外部增强信息。
*   **🚫 直接阻断（返回空数组）**：
    *   闲聊/问候 ("你好")
    *   纯逻辑/数学问题 ("1+1=?", "Python列表推导式怎么写?") —— *除非涉及最新版本特性*
    *   翻译/改写/创作请求 ("帮我润色这段话")
    *   上下文严重缺失 ("他在哪里？")
*   **✅ 启动搜索**：
    *   任何需要实时数据、事实核查、行业分析、观点对比的任务。

### 第二步：多维发散 (Orthogonal Expansion)
如果启动搜索，针对问题核心进行**正交拆解**（即：关键词之间尽量不重叠，覆盖不同维度）。
*   **维度参考列表**：
    1.  [Definition] 核心概念定义/基础事实
    2.  [News] 最新动态/时事新闻
    3.  [Data] 统计数据/财报/市场份额
    4.  [Opinion] 专家评论/争议/论坛讨论 (Reddit/Twitter)
    5.  [Comparison] 竞品对比/历史对比
    6.  [Technical] 技术文档/白皮书/Github Issues

### 第三步：语言策略 (Language Weighting)
根据**信息源熵值**决定关键词语言：
*   **English Heavy (4:1 或 5:0)**：计算机科学、Web3/Crypto、国际金融(美股/外汇)、前沿医学、国际政治。
*   **Chinese Heavy (1:4 或 0:5)**：中国本土政策、A股、中文流行文化、本地生活服务、中文语境特有的社会现象。

---

## 输出配置

请严格按照 JSON 格式输出，包含以下字段：

### 1. \`search_queries\` (Array[String])
*   **策略**：
    *   **简单事实**：1-2个关键词（精准打击）。
    *   **深度探索**：3-5个关键词（最大化覆盖）。针对复杂问题，必须填满5个槽位，分别对应不同维度（如：现状、原因、影响、数据、反面观点）。
*   **原则**：
    *   关键词必须精炼（去停用词）。
    *   如果混合语言，请将高质量源语言放在数组前面。

### 2. \`num_results\` (Integer)
控制每个关键词返回的条目数，平衡总信息量：
*   **1-2 个关键词**：设为 \`10\`（需要更多单一维度的细节）。
*   **3-5 个关键词**：设为 \`5\` 到 \`8\`（总条目数 即 search_queries.length * num_results，应控制在40以内，防止注意力分散，强迫提取精华）。

---

## JSON 输出示例

### Case A: 复杂深度检索 (English Heavy)
**Input**: "Sam Altman被OpenAI解雇又回归的完整时间线和深层原因分析"
**Reasoning**: 这是一个复杂的国际科技事件，需要事实、评论和幕后分析。
\`\`\`json
{
  "search_queries": [
    "Sam Altman OpenAI firing rejoining timeline November 2023",
    "reason behind Sam Altman firing OpenAI board conflict",
    "Ilya Sutskever Helen Toner OpenAI board statement",
    "Microsoft role in Sam Altman return to OpenAI",
    "OpenAI 董事会改组 2023 分析" 
  ],
  "num_results": 7
}
\`\`\`

### Case B: 广泛行业调研 (Chinese Mixed)
**Input**: "2024年中国新能源汽车出海面临的关税壁垒和对策"
**Reasoning**: 涉及中国企业（中）和国际政策（英）。
\`\`\`json
{
  "search_queries": [
    "EU tariffs on Chinese EV 2024 details",
    "US inflation reduction act Chinese EV exclusion",
    "2024中国新能源汽车出口数据 BYD 蔚来",
    "Chinese EV companies strategy against tariffs Europe",
    "土耳其 巴西 对华电动车 关税政策"
  ],
  "num_results": 6
}
\`\`\`

### Case C: 简单事实
**Input**: "特斯拉昨晚股价跌了多少？"
\`\`\`json
{
  "search_queries": [
    "Tesla stock price change last session reasoning"
  ],
  "num_results": 10
}
\`\`\`

### Case D: 无需搜索
**Input**: "把下面的Python代码改成Java"
\`\`\`json
{
  "search_queries": [],
  "num_results": 0
}
\`\`\`

---

## 当前环境
Current Date: ${new Date().toISOString()}

## 待处理的用户输入
<User_Question>
${query}
</User_Question>
  `;
  return str.trim();
}

function getSvgContent(chatType) {
  const svgOpenai = `
<svg
  t="1761563068979"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="2192"
  width="24"
  height="24"
>
  <rect width="1024" height="1024" fill="white" />
  <path
    d="M0 512a512 512 0 1 0 1024 0 512 512 0 0 0-1024 0z"
    fill="#F86AA4"
    p-id="2193"
  ></path>
  <path
    d="M845.585067 442.299733a189.303467 189.303467 0 0 0-16.725334-157.149866c-42.496-72.977067-127.829333-110.421333-211.217066-92.808534a198.417067 198.417067 0 0 0-186.948267-60.142933A195.857067 195.857067 0 0 0 284.330667 261.768533a194.013867 194.013867 0 0 0-129.706667 92.808534 191.453867 191.453867 0 0 0 24.064 227.089066 189.064533 189.064533 0 0 0 16.554667 157.149867c42.530133 72.977067 127.965867 110.455467 211.387733 92.808533a195.345067 195.345067 0 0 0 146.261333 64.375467c85.435733 0.1024 161.109333-54.340267 187.255467-134.621867a194.1504 194.1504 0 0 0 129.672533-92.7744 191.761067 191.761067 0 0 0-24.234666-226.304z m-292.693334 403.456a146.432 146.432 0 0 1-93.320533-33.28l4.608-2.56 154.999467-88.302933a25.3952 25.3952 0 0 0 12.731733-21.742933v-215.586134l65.536 37.376a2.218667 2.218667 0 0 1 1.262933 1.6384v178.653867c-0.2048 79.36-65.365333 143.633067-145.8176 143.803733zM239.479467 713.728a141.380267 141.380267 0 0 1-17.3056-96.426667l4.608 2.696534 155.136 88.302933a25.4976 25.4976 0 0 0 25.2928 0l189.576533-107.793067v74.615467a2.525867 2.525867 0 0 1-1.058133 1.9456l-157.013334 89.326933c-69.768533 39.594667-158.890667 16.042667-199.236266-52.667733zM198.656 380.689067a145.066667 145.066667 0 0 1 76.8-63.146667v181.6576a24.439467 24.439467 0 0 0 12.526933 21.640533l188.689067 107.349334-65.536 37.376a2.4576 2.4576 0 0 1-2.321067 0l-156.672-89.1904a143.0528 143.0528 0 0 1-53.486933-196.471467v0.785067z m538.453333 123.323733l-189.2352-108.373333 65.365334-37.205334a2.4576 2.4576 0 0 1 2.321066 0l156.672 89.258667a143.291733 143.291733 0 0 1 72.465067 136.533333 144.0768 144.0768 0 0 1-94.4128 122.88V525.312a25.258667 25.258667 0 0 0-13.2096-21.333333z m65.194667-96.699733l-4.573867-2.730667-154.862933-89.088a25.4976 25.4976 0 0 0-25.4976 0l-189.371733 107.861333v-74.683733a2.1504 2.1504 0 0 1 0.887466-1.911467l156.706134-89.1904a147.6608 147.6608 0 0 1 156.330666 6.724267 143.1552 143.1552 0 0 1 60.381867 142.404267v0.6144zM392.192 539.613867l-65.536-37.239467a2.525867 2.525867 0 0 1-1.262933-1.8432V322.389333a143.872 143.872 0 0 1 84.104533-130.116266 147.626667 147.626667 0 0 1 155.170133 19.626666l-4.608 2.56-154.999466 88.2688a25.3952 25.3952 0 0 0-12.765867 21.742934l-0.136533 215.1424h0.034133z m35.566933-75.707734l84.411734-47.991466 84.5824 47.991466v96.017067l-84.2752 47.991467-84.548267-47.991467-0.170667-96.017067z"
    fill="#FFFFFF"
    p-id="2194"
  ></path>
</svg>
`;
  const svgGemini = `
<svg
  width="24"
  height="24"
  viewBox="0 0 32 32"
  xmlns="http://www.w3.org/2000/svg"
>
  <title>Gemini</title>
  
  <!-- White circular background with safe area -->
  <circle cx="16" cy="16" r="24" fill="#ffffff"/>
  
  <!-- Icon centered: scale first, then translate to center -->
  <g transform="translate(16, 16) scale(1) translate(-12, -12)">
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="#3186FF"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-0)"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-1)"
    ></path>
    <path
      d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
      fill="url(#lobe-icons-gemini-fill-2)"
    ></path>
  </g>
  <defs>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-0"
      x1="7"
      x2="11"
      y1="15.5"
      y2="12"
    >
      <stop stop-color="#08B962"></stop>
      <stop offset="1" stop-color="#08B962" stop-opacity="0"></stop>
    </linearGradient>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-1"
      x1="8"
      x2="11.5"
      y1="5.5"
      y2="11"
    >
      <stop stop-color="#F94543"></stop>
      <stop offset="1" stop-color="#F94543" stop-opacity="0"></stop>
    </linearGradient>
    <linearGradient
      gradientUnits="userSpaceOnUse"
      id="lobe-icons-gemini-fill-2"
      x1="3.5"
      x2="17.5"
      y1="13.5"
      y2="12"
    >
      <stop stop-color="#FABC12"></stop>
      <stop offset=".46" stop-color="#FABC12" stop-opacity="0"></stop>
    </linearGradient>
  </defs>
</svg>
  `;
  const svgClaude = `
<svg
  t="1761630730959"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="6390"
  width="24"
  height="24"
>
  <rect width="1024" height="1024" fill="white" />
  <path
    d="M198.4 678.4l198.4-115.2 6.4-12.8H243.2l-96-6.4-102.4-6.4-19.2-6.4-25.6-25.6v-12.8l19.2-12.8h32l64 6.4 96 6.4 70.4 6.4L384 512h19.2V492.8l-6.4-6.4-102.4-64-108.8-76.8-51.2-38.4-32-19.2-19.2-25.6-6.4-38.4 32-32h44.8l38.4 32 83.2 64L384 364.8l12.8 12.8 6.4-6.4-6.4-12.8L339.2 256l-64-108.8-25.6-38.4-6.4-25.6c0-12.8-6.4-19.2-6.4-32l32-44.8 19.2-6.4 44.8 6.4 19.2 12.8 25.6 57.6 44.8 96 64 128 19.2 38.4 6.4 38.4 6.4 12.8h6.4V384l6.4-70.4 12.8-89.6 12.8-115.2 6.4-32 19.2-38.4 32-19.2 25.6 12.8 19.2 32v19.2l-32 70.4-19.2 121.6-19.2 83.2h6.4l12.8-12.8 44.8-57.6 70.4-89.6 32-32 38.4-38.4 25.6-19.2h44.8l32 51.2-12.8 51.2-51.2 57.6-38.4 51.2-51.2 70.4-38.4 57.6v6.4h6.4l121.6-25.6 64-12.8 76.8-12.8 38.4 19.2 6.4 19.2-12.8 32-83.2 19.2-96 19.2-147.2 32 64 6.4h96l128 6.4 32 19.2 25.6 38.4-6.4 19.2-51.2 25.6-70.4-12.8-160-38.4-57.6-12.8h-6.4v6.4l44.8 44.8 83.2 76.8 108.8 102.4 6.4 25.6-12.8 19.2h-12.8l-96-70.4-38.4-32-83.2-70.4h-6.4v6.4l19.2 25.6 102.4 147.2 6.4 44.8-6.4 12.8-25.6 6.4-25.6-6.4-57.6-83.2-64-83.2-51.2-83.2-6.4 6.4-25.6 307.2-12.8 12.8-32 12.8-25.6-19.2-12.8-32 12.8-64 19.2-83.2 12.8-64 12.8-83.2 6.4-25.6h-6.4l-64 83.2-96 128-70.4 76.8-19.2 6.4-32-12.8v-25.6l19.2-25.6 102.4-128 64-83.2 38.4-51.2v-6.4l-268.8 172.8-51.2 12.8-19.2-19.2v-32l12.8-12.8 76.8-57.6z m0 0"
    fill="#D97757"
    p-id="6391"
  ></path>
</svg>
  `;
  const svgQwen = `
<svg
  t="1761614247284"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="5205"
  width="24"
  height="24"
>
  <rect width="1024" height="1024" fill="white" />
  <path
    d="M255.872 279.808h-109.76a21.12 21.12 0 0 0-18.288 10.528L66.816 396a21.168 21.168 0 0 0 0 21.12L317.12 850.144h121.68l180.768-151.84-363.68-418.496z"
    fill="#615CED"
    p-id="5206"
  ></path>
  <path
    d="M182.72 617.76l-54.896 95.04a21.12 21.12 0 0 0 0 21.168l60.992 105.6c3.696 6.56 10.72 10.624 18.256 10.576h231.712L182.672 617.76h0.048z m658.608-211.28l54.848-95.024a21.12 21.12 0 0 0 0-21.152l-60.992-105.6a21.152 21.152 0 0 0-18.24-10.576l-500.208 0.224-60.864 105.36 41.12 232.544 544.336-105.824v0.048z"
    fill="#615CED"
    p-id="5207"
  ></path>
  <path
    d="M585.12 174.16l-54.848-95.04A21.12 21.12 0 0 0 512 68.48h-122a20.976 20.976 0 0 0-18.256 10.624l-55.456 96.032-60.4 104.576 329.264-105.552z m-146.288 676.032l54.8 95.056a21.12 21.12 0 0 0 18.352 10.496h122a21.168 21.168 0 0 0 18.24-10.544l249.92-433.312-60.816-105.376-221.952-80.592-180.544 524.224v0.048z"
    fill="#615CED"
    p-id="5208"
  ></path>
  <path
    d="M768.08 744.512h109.76a21.136 21.136 0 0 0 18.288-10.576l61.008-105.6a20.992 20.992 0 0 0 0-21.168l-55.456-96.032-60.4-104.624-73.2 338z"
    fill="#615CED"
    p-id="5209"
  ></path>
  <path
    d="M452.416 828.656l-243.36 0.928 60.32-105.504 121.856-0.464L145.84 302.64l121.872-0.288L512.848 722.88l-60.448 105.728v0.048z"
    fill="#FFFFFF"
    p-id="5210"
  ></path>
  <path
    d="M267.664 302.32l120.832-211.2 61.232 104.96-60.432 105.728 487.248-2-60.768 105.696-486.704 1.984-61.408-105.168z"
    fill="#FFFFFF"
    p-id="5211"
  ></path>
  <path
    d="M815.824 405.44l122.464 210.272-121.504 0.512-61.312-105.216L513.6 933.984l-61.184-105.424 241.6-422.56 121.856-0.544h-0.048z"
    fill="#FFFFFF"
    p-id="5212"
  ></path>
  <path
    d="M512.848 722.784l181.152-316.768-364.928 1.472 183.776 315.296z"
    fill="#605BEC"
    p-id="5213"
  ></path>
  <path
    d="M512.848 722.784L267.712 302.272l12.112-21.12 245.12 420.528-12.08 21.152v-0.048z"
    fill="#605BEC"
    p-id="5214"
  ></path>
  <path
    d="M329.072 407.584l486.752-2.032 12.24 21.024-486.752 2.032-12.24-21.024z"
    fill="#605BEC"
    p-id="5215"
  ></path>
  <path
    d="M694.048 406.016l-241.6 422.512-24.304 0.08 241.6-422.512 24.32-0.08z"
    fill="#605BEC"
    p-id="5216"
  ></path>
</svg>
  `;
  const svgDeepseek = `
<svg
  t="1762144870999"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="6244"
  width="24"
  height="24"
>
  <rect width="1024" height="1024" fill="white" />
  <path
    d="M550.4 486.4c0-8.533333 4.266667-12.8 12.8-12.8h4.266667c4.266667 0 4.266667 4.266667 4.266666 4.266667s4.266667 4.266667 4.266667 8.533333v4.266667s0 4.266667-4.266667 4.266666c0 0-4.266667 0-4.266666 4.266667h-4.266667-4.266667s-4.266667 0-4.266666-4.266667c0 0 0-4.266667-4.266667-4.266666v-4.266667z"
    fill="#4D6BFE"
    p-id="6245"
  ></path>
  <path
    d="M994.133333 196.266667c-8.533333-4.266667-12.8 4.266667-21.333333 8.533333l-4.266667 4.266667c-12.8 17.066667-34.133333 25.6-55.466666 25.6-34.133333 0-59.733333 8.533333-85.333334 34.133333-4.266667-29.866667-21.333333-51.2-51.2-64-12.8-4.266667-29.866667-12.8-38.4-25.6-8.533333-8.533333-8.533333-21.333333-12.8-29.866667 0-4.266667 0-12.8-8.533333-12.8s-12.8 4.266667-12.8 12.8c-12.8 21.333333-21.333333 46.933333-17.066667 72.533334 0 59.733333 25.6 106.666667 72.533334 136.533333 4.266667 4.266667 8.533333 8.533333 4.266666 12.8-4.266667 12.8-8.533333 21.333333-8.533333 34.133333-4.266667 8.533333-4.266667 8.533333-12.8 4.266667-25.6-12.8-51.2-29.866667-68.266667-46.933333-34.133333-34.133333-64-72.533333-102.4-102.4-8.533333-8.533333-17.066667-12.8-25.6-21.333334-46.933333-34.133333 0-64 8.533334-68.266666 12.8-4.266667 4.266667-17.066667-29.866667-17.066667-34.133333 0-68.266667 12.8-106.666667 29.866667-8.533333 0-12.8 0-21.333333 4.266666-38.4-8.533333-76.8-8.533333-115.2-4.266666-76.8 8.533333-136.533333 42.666667-179.2 106.666666-51.2 76.8-64 157.866667-51.2 247.466667 17.066667 93.866667 64 170.666667 132.266667 230.4 72.533333 64 157.866667 93.866667 256 85.333333 59.733333-4.266667 123.733333-12.8 200.533333-76.8 17.066667 8.533333 38.4 12.8 72.533333 17.066667 25.6 4.266667 51.2 0 68.266667-4.266667 29.866667-4.266667 25.6-34.133333 17.066667-38.4-85.333333-42.666667-68.266667-25.6-85.333334-38.4 42.666667-51.2 110.933333-106.666667 136.533334-285.866666v-34.133334c0-8.533333 4.266667-8.533333 12.8-8.533333 21.333333-4.266667 42.666667-8.533333 59.733333-21.333333 55.466667-29.866667 76.8-81.066667 85.333333-145.066667 0-8.533333 0-17.066667-12.8-21.333333zM507.733333 746.666667c-85.333333-68.266667-123.733333-89.6-140.8-89.6-17.066667 0-12.8 21.333333-8.533333 29.866666 4.266667 12.8 8.533333 21.333333 12.8 29.866667 4.266667 8.533333 8.533333 17.066667-4.266667 25.6-25.6 17.066667-72.533333-4.266667-76.8-8.533333-55.466667-34.133333-98.133333-76.8-132.266666-136.533334-29.866667-51.2-46.933333-110.933333-46.933334-174.933333 0-17.066667 4.266667-21.333333 17.066667-25.6 21.333333-4.266667 42.666667-4.266667 59.733333 0 85.333333 12.8 157.866667 51.2 217.6 115.2 34.133333 34.133333 59.733333 76.8 89.6 119.466667 29.866667 42.666667 59.733333 85.333333 98.133334 119.466666 12.8 12.8 25.6 21.333333 34.133333 25.6-29.866667 0-81.066667 0-119.466667-29.866666z m166.4-196.266667c-8.533333 4.266667-17.066667 4.266667-25.6 4.266667-12.8 0-25.6-4.266667-29.866666-8.533334-12.8-8.533333-17.066667-12.8-21.333334-29.866666v-25.6c4.266667-12.8 0-21.333333-8.533333-29.866667-8.533333-4.266667-17.066667-8.533333-25.6-8.533333-4.266667 0-8.533333 0-8.533333-4.266667 0 0-4.266667 0-4.266667-4.266667v-4.266666-4.266667-4.266667c0-4.266667 8.533333-8.533333 8.533333-8.533333 12.8-8.533333 29.866667-4.266667 46.933334 0 12.8 4.266667 25.6 17.066667 38.4 29.866667 17.066667 17.066667 17.066667 25.6 25.6 38.4 8.533333 12.8 12.8 21.333333 17.066666 34.133333 0 12.8-4.266667 21.333333-12.8 25.6z"
    fill="#4D6BFE"
    p-id="6246"
  ></path>
</svg>
  `;
  const svgRouter = `
<svg
  t="1762765462742"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="5158"
  width="32"
  height="32"
>
  <rect width="1024" height="1024" fill="white" />
  <path d="M0 0h1024v1024H0V0z" fill="#94a3b8" p-id="5159"></path>
  <path
    d="M660.48 230.4c19.28192 7.71072 35.14368 15.2576 52.81792 25.66144l15.71328 9.21088 16.27136 9.61024 15.8464 9.30816c10.55744 6.1952 21.10464 12.40576 31.65184 18.61632A21568.34816 21568.34816 0 0 0 870.4 348.16c-16 17.6896-32.63488 28.28288-53.51936 39.68l-9.60512 5.2736c-10.0864 5.5296-20.20352 11.008-30.31552 16.4864l-20.14208 11.03872C725.00224 438.05184 693.0944 455.14752 660.48 471.04V409.6c-99.584 3.34848-159.7184 29.6448-240.7424 86.784A637.93152 637.93152 0 0 1 378.88 522.24c92.70272 69.43232 163.54304 110.19264 281.6 112.64v-61.44l38.912 21.22752c11.96032 6.52288 23.92576 13.03552 35.8912 19.54304 16.32256 8.87296 32.62464 17.78176 48.9216 26.70592 6.77376 3.70176 13.55776 7.39328 20.34688 11.07968 9.92256 5.38624 19.82976 10.81344 29.72672 16.24576l17.68448 9.64096C865.28 686.08 865.28 686.08 870.4 696.32l-11.71456 6.48192c-14.65856 8.1152-29.31712 16.23552-43.97056 24.36096l-18.85696 10.4448a24808.20736 24808.20736 0 0 0-36.61312 20.28544 1638.53824 1638.53824 0 0 0-44.81536 25.76384l-16.5888 9.92256-14.7456 8.97024C670.72 808.96 670.72 808.96 655.36 808.96v-51.2l-21.9392 0.90112c-101.34528 2.91328-170.89536-22.51776-254.32064-79.68256C310.26176 631.92064 255.29856 605.82912 174.08 583.68V460.8l35.84-7.68c65.13152-15.57504 119.78752-46.42304 173.33248-85.88288C471.35744 302.45376 551.936 282.75712 660.48 286.72V230.4z"
    fill="#F8F8FE"
    p-id="5160"
  ></path>
</svg>
  `;
  const svgDefault = `
<svg
  t="1763444006745"
  class="icon"
  viewBox="0 0 1024 1024"
  version="1.1"
  xmlns="http://www.w3.org/2000/svg"
  p-id="28244"
  width="32"
  height="32"
>
  <rect width="1024" height="1024" fill="white" />
  <path
    d="M346.154667 72.96l4.010666 3.541333 128 128c2.730667 2.688 4.992 5.674667 6.826667 8.832h54.058667a42.453333 42.453333 0 0 1 3.242666-4.821333l3.541334-4.010667 128-128a42.666667 42.666667 0 0 1 63.872 56.32l-3.541334 4.010667L657.664 213.333333H725.333333a213.333333 213.333333 0 0 1 213.333334 213.333334v298.666666a213.333333 213.333333 0 0 1-213.333334 213.333334H298.666667a213.333333 213.333333 0 0 1-213.333334-213.333334v-298.666666a213.333333 213.333333 0 0 1 213.333334-213.333334h67.626666L289.834667 136.832a42.666667 42.666667 0 0 1 56.32-63.872zM725.333333 298.666667H298.666667a128 128 0 0 0-127.786667 120.490666L170.666667 426.666667v298.666666a128 128 0 0 0 120.490666 127.786667L298.666667 853.333333h426.666666a128 128 0 0 0 127.786667-120.490666L853.333333 725.333333v-298.666666a128 128 0 0 0-120.490666-127.786667L725.333333 298.666667zM384 405.333333a42.666667 42.666667 0 0 1 42.368 37.674667L426.666667 448v170.666667a42.666667 42.666667 0 0 1-85.034667 4.992L341.333333 618.666667v-170.666667a42.666667 42.666667 0 0 1 42.666667-42.666667z m307.498667 12.501334a42.666667 42.666667 0 0 1 3.541333 56.32l-3.541333 4.010666-55.125334 55.168 55.125334 55.168a42.666667 42.666667 0 0 1 3.541333 56.32l-3.541333 4.010667a42.666667 42.666667 0 0 1-56.32 3.541333l-4.010667-3.541333-85.333333-85.333333a42.666667 42.666667 0 0 1-3.541334-56.32l3.541334-4.010667 85.333333-85.333333a42.666667 42.666667 0 0 1 60.330667 0z"
    fill="#1296db"
    p-id="28245"
  ></path>
</svg>
  `;
  switch (chatType) {
    case 'openai':
      return svgOpenai;
    case 'gemini':
      return svgGemini;
    case 'claude':
      return svgClaude;
    case 'qwen':
      return svgQwen;
    case 'deepseek':
      return svgDeepseek;
    case 'router':
      return svgRouter;
    default:
      return svgDefault;
  }
}

function getManifestContent(title) {
  const str = `
{
  "name": "${title}",
  "short_name": "${title}",
  "description": "${title} - 智能对话助手",
  "start_url": "./index.html",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#605bec",
  "icons": [
    {
      "src": "favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    }
  ],
  "categories": ["productivity", "utilities"],
  "lang": "zh-CN",
  "dir": "ltr"
}
  `;
  return str.trim();
}

function getHtmlContent(modelIds, tavilyKeys, title) {
  let htmlContent = `<!doctype html>
<html lang="zh-Hans">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#605bec" />
    <meta name="description" content="OpenAI Chat - 智能对话助手" />
    <meta http-equiv="Content-Language" content="zh-CN" />
    <title>OpenAI Chat</title>

    <!-- Favicon -->
    <link rel="icon" type="image/svg+xml" href="favicon.svg" />

    <!-- Web App Manifest -->
    <link rel="manifest" href="site.webmanifest" />

    <!-- iOS Safari -->
    <link rel="apple-touch-icon" href="favicon.svg" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="OpenAI Chat" />

    <script src="https://unpkg.com/tom-select@2.4.3/dist/js/tom-select.complete.min.js"></script>

    <script src="https://unpkg.com/vue@3.5.22/dist/vue.global.prod.js"></script>
    <script src="https://unpkg.com/sweetalert2@11.26.3/dist/sweetalert2.all.js"></script>
    <script src="https://unpkg.com/marked@12.0.0/marked.min.js"></script>
    <script src="https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
    <link
      href="https://unpkg.com/tom-select@2.4.3/dist/css/tom-select.default.css"
      rel="stylesheet"
    />
    <link
      rel="stylesheet"
      href="https://unpkg.com/github-markdown-css@5.8.1/github-markdown-light.css"
    />
    <!-- CSS: style.css -->
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      body {
        position: relative;
        font-family:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        min-height: 100vh;
        min-height: 100dvh;
        color: #333;
      }
      
      [v-cloak] {
        display: none;
      }
      
      .hidden {
        display: none !important;
      }
      
      /* 滚动条颜色浅一些 */
      body.pc *::-webkit-scrollbar {
        width: 10px;
        background-color: #f5f6f7;
      }
      
      body.pc *::-webkit-scrollbar-thumb:hover {
        background-color: #d1d5db;
      }
      
      body.pc *::-webkit-scrollbar-thumb {
        background-color: #e5e7eb;
        border-radius: 5px;
      }
      
      body.pc *::-webkit-scrollbar-track {
        background-color: #f5f6f7;
      }
      
      button,
      label {
        user-select: none;
      }
      
      label * {
        vertical-align: middle;
      }
      
      input::placeholder,
      textarea::placeholder {
        color: #a0aec0;
        user-select: none;
      }
      
      .container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
        height: 100vh;
        display: flex;
        gap: 20px;
        transition: max-width 0.2s;
      }
      
      .container.wide {
        max-width: 1600px;
      }
      
      .sidebar {
        width: 300px;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        padding: 20px;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
      }
      
      .sidebar.mobile {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100dvh;
        z-index: 1000;
        padding: 15px 20px;
        transform: translateX(-100%);
        transition: transform 0.3s ease;
        backdrop-filter: blur(15px);
        background: rgba(255, 255, 255, 0.98);
        border-radius: 0;
      }
      
      .sidebar.mobile.show {
        transform: translateX(0);
      }
      
      .sidebar-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100dvh;
        background: rgba(0, 0, 0, 0.5);
        z-index: 999;
        opacity: 0;
        visibility: hidden;
        transition: all 0.3s ease;
      }
      
      .sidebar-overlay.show {
        opacity: 1;
        visibility: visible;
      }
      
      .mobile-menu-btn {
        position: fixed;
        top: 20px;
        left: 20px;
        width: 44px;
        height: 44px;
        background: rgba(255, 255, 255, 0.35);
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        cursor: pointer;
        z-index: 1001;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: #4a5568;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        transition: all 0.2s ease;
      }
      
      .mobile-menu-btn:hover {
        /* background: #f7fafc; */
        transform: scale(1.05);
      }
      
      .main-chat {
        flex: 1 1 0;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        backdrop-filter: blur(10px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        display: flex;
        flex-direction: column;
        min-width: 0;
        /* 防止flex子项撑大父容器 */
        overflow: hidden;
        /* 确保内容不会溢出 */
      }
      
      .header {
        position: relative;
        padding: 18px 32px 18px 18px;
        border-bottom: 1px solid #e1e5e9;
        display: flex;
        justify-content: between;
        align-items: center;
        gap: 15px;
        flex-wrap: wrap;
      }
      
      .header h2 {
        display: flex;
        align-items: center;
        margin: 0;
        color: #495057;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        -webkit-touch-callout: none;
      }
      
      .header h2 .brand {
        display: flex;
        align-items: center;
        margin: 0;
        color: #495057;
        gap: 6px;
        user-select: none;
      }
      
      .header .tool-btns {
        position: absolute;
        display: flex;
        top: 0;
        bottom: 0;
        right: 14px;
        width: 10em;
        height: 32px;
        margin: auto 0;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
      }
      
      .header .tool-btn {
        height: 32px;
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: saturate(180%) blur(16px);
        border: 1px solid #e1e5e9;
        color: #666;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
      }
      
      .header .tool-btn:hover {
        background: rgba(255, 255, 255, 0.7);
        border-color: #a8edea;
        color: #2d3748;
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
      }
      
      .header .wide-btn {
        opacity: 0.3;
      }
      
      .header .wide-btn:hover {
        opacity: 1;
      }
      
      .settings-section {
        text-align: right;
        margin-top: 3px;
        margin-bottom: 15px;
      }
      
      .settings-btn {
        width: 100%;
        padding: 12px 16px;
        background: #f3f3f3;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all 0.3s ease;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      }
      
      .settings-btn.mobile {
        width: calc(100% - 54px);
      }
      
      .settings-btn:hover {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
      }
      
      .api-key-input {
        width: 100%;
        padding: 12px;
        border: 2px solid #e1e5e9;
        border-radius: 8px;
        font-size: 14px;
        transition: border-color 0.3s;
      }
      
      .api-key-input:focus {
        outline: none;
        border-color: #a8edea;
      }
      
      .model-select {
        border-radius: 6px;
        background: white;
        font-size: 14px;
        cursor: pointer;
        user-select: none;
      }
      .model-select.simple {
        padding: 8px 12px;
        border: 2px solid #e1e5e9;
      }
      
      /* Tom Select Customization */
      .ts-wrapper {
        min-width: 200px;
        max-width: 400px;
        display: inline-block;
      }
      .ts-wrapper .ts-control {
        border: 2px solid #e1e5e9 !important;
        border-radius: 6px !important;
        padding: 8px 24px 8px 12px !important;
        box-shadow: none !important;
        background-image: none !important;
      }
      .ts-wrapper .ts-control:after {
        right: 8px !important;
      }
      .ts-control.focus {
        border-color: #a8edea !important;
      }
      .ts-dropdown {
        border: 2px solid #e1e5e9 !important;
        border-radius: 6px !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important;
        z-index: 1000 !important;
      }
      .ts-dropdown .option {
        padding: 8px 12px !important;
      }
      .ts-dropdown .active {
        background-color: #f8f9fa !important;
        color: inherit !important;
      }
      .ts-dropdown .ts-dropdown-content {
        max-height: 21em;
      }
      
      .model-wrap {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: nowrap;
      }
      
      .model-search-label {
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
        cursor: pointer;
        font-size: 14px;
        color: #4a5568;
      }
      
      .model-search-label:hover {
        color: #2d3748;
      }
      
      .model-search {
        cursor: pointer;
        width: 16px;
        height: 16px;
        margin: 0;
      }
      
      .sessions {
        flex: 1;
        overflow-x: hidden;
        overflow-y: auto;
      }
      
      .loading-remote-sessions {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        color: #888;
        font-size: 14px;
        gap: 12px;
      }
      
      .loading-spinner {
        width: 24px;
        height: 24px;
        border: 3px solid #e0e0e0;
        border-top-color: #5fbdbd;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      
      .session-item {
        padding: 8px 12px;
        margin-bottom: 8px;
        background: #f8f9fa;
        border: 1px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .session-item:hover {
        background: #e9ecef;
        /* transform: translateX(3px); */
      }
      
      .session-item.active {
        background: #ffffff;
        color: #2d3748;
        border: 1px solid #a8edea;
        box-shadow: 2px 2px 10px rgba(168, 237, 234, 0.35);
      }
      
      .session-title {
        font-size: 14px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        margin-right: 8px;
      }
      
      .delete-btn {
        background: none;
        border: none;
        color: #999;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 16px;
        opacity: 0.7;
      }
      
      .delete-btn:hover {
        opacity: 1;
        color: #dc3545;
        background: rgba(220, 53, 69, 0.1);
      }
      
      .new-session-btn {
        width: 100%;
        padding: 12px;
        border: none;
        border-radius: 8px;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        color: #444;
        font-size: 14px;
        font-weight: 500;
        /* 白色外发光字 */
        text-shadow: 0 0 5px rgba(255, 255, 255, 0.8);
        cursor: pointer;
        margin-bottom: 15px;
        transition: all 0.2s ease;
      }
      
      .new-session-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(76, 175, 80, 0.12);
        color: #2d3748;
      }
      
      .messages-container {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 15px;
        min-width: 0;
        /* 防止内容撑大容器 */
      }
      
      .message-content {
        flex: 1;
        line-height: 1.5;
        white-space: pre-wrap;
      }
      
      .input-area {
        padding: 20px;
        border-top: 1px solid #e1e5e9;
        display: flex;
        gap: 10px;
        align-items: flex-end;
        position: relative;
      }
      
      .input-wrapper {
        flex: 1;
        position: relative;
      }
      
      .message-input {
        display: block;
        width: 100%;
        min-height: 44px;
        max-height: 144px;
        padding: 9px 16px;
        padding-right: 34px;
        border: 2px solid #e1e5e9;
        border-radius: 22px;
        resize: none;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.4;
        transition: border-color 0.3s;
      }
      
      .message-input.can-upload {
        padding-left: 44px;
      }
      
      .message-input:focus {
        outline: none;
        border-color: #a8edea;
      }
      
      .clear-btn {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 20px;
        height: 20px;
        background: #cbd5e0;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        color: #fff;
        transition: all 0.2s ease;
        opacity: 0.7;
      }
      
      .clear-btn:hover {
        background: #a0aec0;
        opacity: 1;
        transform: translateY(-50%) scale(1.1);
      }
      
      .send-btn {
        padding: 12px 18px;
        background: #4299e1;
        color: white;
        border: none;
        border-radius: 22px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.2s ease;
        min-width: 60px;
        height: 44px;
        box-shadow: 0 2px 4px rgba(66, 153, 225, 0.3);
      }
      
      .send-btn.danger {
        background: #dc3545;
        color: white;
      }
      
      .send-btn.danger:hover {
        background: #c82333;
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(220, 53, 69, 0.4);
      }
      
      .send-btn:hover:not(:disabled):not(.danger) {
        background: #3182ce;
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(66, 153, 225, 0.4);
      }
      
      .send-btn:disabled {
        background: #cbd5e0;
        color: #a0aec0;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      
      /* 上传图片按钮 */
      .upload-btn {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 28px;
        height: 28px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.6;
        transition: all 0.2s ease;
        padding: 0;
      }
      
      .upload-btn:hover:not(:disabled) {
        opacity: 1;
        transform: translateY(-50%) scale(1.1);
      }
      
      .upload-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      
      /* 上传的图片标签容器 */
      .uploaded-images-tags {
        position: absolute;
        top: -44px;
        left: 0;
        display: flex;
        gap: 8px;
        padding-left: 20px;
        z-index: 10;
      }
      
      /* 单个图片标签 */
      .image-tag {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px 4px 4px;
        background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
        border-radius: 20px;
        font-size: 12px;
        color: #333;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
      }
      
      /* 文本文件标签样式 */
      .image-tag.plaintext-tag {
        cursor: pointer;
        padding: 4px 8px;
        background: linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%);
      }
      
      .image-tag.plaintext-tag:hover {
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.15);
      }
      
      .image-tag .plaintext-icon {
        font-size: 18px;
      }
      
      .image-tag img {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid white;
      }
      
      .image-tag-text {
        font-weight: 500;
        white-space: nowrap;
      }
      
      .image-tag-remove {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.15);
        border: none;
        color: white;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        padding: 0;
      }
      
      .image-tag-remove:hover {
        background: rgba(220, 53, 69, 0.8);
        transform: scale(1.1);
      }
      
      /* 问题区域的图片链接 */
      .question-images {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      
      .question-images a {
        display: inline-block;
        padding: 4px 10px;
        background: rgba(168, 237, 234, 0.3);
        border: 1px solid rgba(168, 237, 234, 0.5);
        border-radius: 12px;
        color: #2d3748;
        text-decoration: none;
        font-size: 12px;
        transition: all 0.2s ease;
      }
      
      .question-images a:hover {
        background: rgba(168, 237, 234, 0.5);
        border-color: #a8edea;
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        cursor: pointer;
      }
      
      /* SweetAlert2 图片预览样式 */
      .swal-image-preview {
        max-width: 90vw !important;
        max-height: 90vh !important;
        object-fit: contain !important;
        margin-top: 2.5em !important;
        margin-bottom: 0 !important;
      }
      
      .swal2-popup:has(.swal-image-preview) {
        padding-bottom: 0 !important;
        overflow: hidden !important;
      }
      
      .loading {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #a8edea;
        padding: 0px 16px 16px;
      }
      
      .spinner {
        width: 20px;
        height: 20px;
        border: 2px solid #e1e5e9;
        border-top: 2px solid #a8edea;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      
      @keyframes spin {
        0% {
          transform: rotate(0deg);
        }
      
        100% {
          transform: rotate(360deg);
        }
      }
      
      /* 移动端适配 */
      @media (max-width: 768px) {
        body {
          overflow: hidden;
        }
      
        .container {
          flex-direction: column;
          padding: 10px;
          height: 100vh;
          height: 100dvh;
          position: relative;
        }
      
        .swal2-container h2 {
          font-size: 1.5em;
        }
      
        div.swal2-html-container {
          padding-left: 1em;
          padding-right: 1em;
        }
      
        .main-chat {
          flex: 1;
          min-height: 0;
          width: 100%;
          margin-top: 0;
        }
      
        .header {
          padding: 15px;
          padding-left: 64px;
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
        }
      
        .header .tool-btns {
          top: 16px;
          bottom: auto;
          width: 64px;
          margin: 0;
        }
      
        .model-wrap {
          width: 100%;
        }
      
        .model-select {
          flex: 1;
          min-width: 0;
        }
      
        .model-search-label {
          flex-shrink: 0;
          font-size: 13px;
        }
      
        .input-area {
          padding: 12px;
          gap: 6px;
        }
      
        .input-wrapper {
          flex: 1;
        }
      
        .message-input {
          font-size: 16px;
          /* 防止iOS缩放 */
        }
      
        .sessions {
          max-height: none;
          flex: 1;
        }
      
        /* 移动端图片标签样式 */
        .uploaded-images-tags {
          top: -36px;
        }
      
        .image-tag {
          padding: 3px 6px 3px 3px;
          font-size: 11px;
        }
      
        .image-tag img {
          width: 24px;
          height: 24px;
        }
      
        .content-section > h4 small {
          position: relative;
          display: inline-block;
          vertical-align: middle;
          white-space: nowrap;
          max-width: 27em;
          padding-bottom: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      
        .content-section:hover > h4 small {
          max-width: 13em;
        }
      }
      
      .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        color: #6c757d;
        text-align: center;
        padding: 40px;
      }
      
      .empty-state h3 {
        margin-bottom: 10px;
        color: #495057;
      }
      
      .error-message {
        background: #f8d7da;
        color: #721c24;
        padding: 12px 16px;
        border-radius: 8px;
        margin: 0 8px;
        border: 1px solid #f5c6cb;
      }
      
      .role-setting {
        margin-bottom: 15px;
      }
      
      .role-textarea {
        position: relative;
        width: 100%;
        min-height: 90px;
        max-height: 30vh;
        padding: 12px;
        border: 2px solid #e1e5e9;
        border-radius: 8px;
        font-size: 14px;
        font-family: inherit;
        resize: vertical;
        transition: border-color 0.3s;
      }
      
      .role-textarea:focus {
        outline: none;
        border-color: #a8edea;
      }
      
      .role-textarea[disabled] {
        color: rgba(0, 0, 0, 0.3);
      }
      
      .copy-btn,
      .reset-btn {
        background: none;
        border: 1px solid #e1e5e9;
        color: #666;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
        margin-left: 8px;
        opacity: 0;
        transition: all 0.2s;
      }
      
      .reset-btn {
        padding: 3px 8px;
        opacity: 1 !important;
      }
      
      .copy-btn:hover {
        background: #f8f9fa;
        border-color: #a8edea;
      }
      
      .content-section:hover .copy-btn {
        opacity: 1;
      }
      
      .session-content {
        display: flex;
        flex-direction: column;
        gap: 15px;
        padding: 8px;
      }
      
      .session-content.capturing details summary::marker {
        list-style: disc !important;
        list-style-type: disc !important;
      }
      
      .content-section {
        flex: 0 0 auto;
        position: relative;
        padding: 15px;
        border-radius: 8px;
        border: 1px solid #e1e5e9;
      }
      
      .content-section > h4 {
        position: relative;
        margin: 0 0 10px 0;
        color: #495057;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        white-space: nowrap;
        overflow: hidden;
      }
      
      .content-section > h4 small {
        color: #6c757d;
        font-size: 12px;
        font-weight: normal;
      }
      
      .content-section > h4:has(input:checked) + .rendered-content {
        position: relative;
        max-height: 10em;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .role-section {
        position: relative;
        background: #f8f9fa;
      }
      
      .role-section:has(input:checked):after {
        content: '';
        display: block;
        position: absolute;
        z-index: 1;
        left: 0;
        right: 0;
        bottom: 0;
        height: 50%;
        background: linear-gradient(
          to bottom,
          rgba(255, 255, 255, 0) 0%,
          rgba(248, 249, 250, 1) 80%,
          rgba(248, 249, 250, 1) 100%
        );
        pointer-events: none;
      }
      
      .question-section {
        background: linear-gradient(
          135deg,
          rgba(168, 237, 234, 0.18),
          rgba(254, 214, 227, 0.18)
        );
      }
      
      .answer-section {
        background: #ffffff;
      }
      
      .markdown-body {
        background: none;
        white-space-collapse: collapse;
        overflow-x: auto;
        max-width: 100%;
        word-wrap: break-word;
      }
      
      /* 表格样式 - 防止溢出 */
      .markdown-body table {
        max-width: 100%;
        width: 100%;
        table-layout: auto;
        border-collapse: collapse;
        margin: 1em 0;
        font-size: 0.9em;
      }
      
      .markdown-body th,
      .markdown-body td {
        padding: 8px 12px;
        border: 1px solid #e1e5e9;
        text-align: left;
        vertical-align: top;
        word-break: break-word;
        min-width: 0;
      }
      
      .markdown-body th {
        background-color: #f8f9fa;
        font-weight: 600;
      }
      
      /* 表格容器 - 提供水平滚动 */
      .rendered-content {
        position: relative;
        line-height: 1.6;
        overflow-x: auto;
        overflow-y: visible;
        max-width: 100%;
      }
      
      .rendered-content p {
        margin: 0.5em 0;
      }
      
      .rendered-content code {
        background: #f1f3f5;
        padding: 2px 4px;
        border-radius: 3px;
        white-space: pre-wrap !important;
        word-break: break-all !important;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: 0.9em;
      }
      
      .rendered-content pre {
        background: #f8f9fa;
        border: 1px solid #e1e5e9;
        padding: 15px;
        border-radius: 8px;
        overflow-x: auto;
        white-space-collapse: collapse;
        margin: 1em 0;
      }
      
      .rendered-content pre code {
        background: none;
        padding: 0;
      }
      
      .rendered-content blockquote {
        border-left: 4px solid #a8edea;
        margin: 1em 0;
        padding-left: 1em;
        color: #666;
      }
      
      .rendered-content details {
        margin: 1em 0;
        padding: 0.8em 1em;
        background: #f8f9fa;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
      }
      
      .rendered-content details summary {
        cursor: pointer;
        font-weight: 500;
        color: #555;
        padding: 0.3em 0;
        user-select: none;
      }
      
      .rendered-content details summary:hover {
        color: #333;
      }
      
      .rendered-content details[open] summary {
        padding-bottom: 0.5em;
        margin-bottom: 0.75em;
        border-bottom: 1px solid #e5e7eb;
      }
      
      .streaming-answer {
        min-height: 1.5em;
      }
      
</style>
    <script>
      var isWechat = new RegExp('wechat', 'i').test(window.navigator.userAgent);
      if (isWechat && document.title) {
        document.title = '✨ ' + document.title;
      }
      // IndexedDB 封装（支持WebDAV远程存储）
      class OpenaiDB {
        constructor() {
          this.dbName = 'OpenaiChatDB';
          this.version = 1;
          this.storeName = 'chatData';
          this.db = null;
          // WebDAV 配置
          this.webdavEnabled = false;
          this.webdavConfig = {
            url: '',
            username: '',
            password: '',
            path: '/openai-chat/'
          };
        }

        // 加载WebDAV配置（从IndexedDB）
        async loadWebDAVConfig() {
          if (!this.db) await this.init();
          try {
            var configStr = await this.getItem('openai_webdav_config');
            if (configStr) {
              var parsed = JSON.parse(configStr);
              this.webdavEnabled = parsed.enabled || false;
              this.webdavConfig = parsed.config || this.webdavConfig;
            }
          } catch (e) {
            console.error('解析WebDAV配置失败:', e);
          }
        }

        // 保存WebDAV配置（到IndexedDB）
        async saveWebDAVConfig(enabled, config) {
          this.webdavEnabled = enabled;
          this.webdavConfig = config;
          // 直接写入IndexedDB，不走setItem（避免触发WebDAV同步）
          if (!this.db) await this.init();
          return new Promise((resolve, reject) => {
            var transaction = this.db.transaction(
              [this.storeName],
              'readwrite'
            );
            var store = transaction.objectStore(this.storeName);
            var request = store.put({
              key: 'openai_webdav_config',
              value: JSON.stringify({ enabled: enabled, config: config })
            });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
          });
        }

        // 构建WebDAV代理URL
        _buildProxyUrl(targetPath) {
          // 通过 /webdav 代理接口转发请求
          return '/webdav' + targetPath;
        }

        // 构建WebDAV代理请求头
        _buildProxyHeaders(config, extraHeaders = {}) {
          var baseUrl = config.url.replace(/\\/\$/, '');
          var headers = {
            'X-WebDAV-URL': baseUrl,
            'X-WebDAV-Auth':
              'Basic ' + btoa(config.username + ':' + config.password)
          };
          return Object.assign(headers, extraHeaders);
        }

        // 测试WebDAV连接（使用 PUT/GET/DELETE 方式，兼容性更好）
        async testWebDAVConnection(config) {
          var testFileName = '.webdav-test-' + Date.now() + '.txt';
          var testContent = 'test-' + Date.now();
          var regexp = new RegExp('\\/\$');
          var targetPath = config.path.replace(regexp, '') + '/' + testFileName;
          var proxyUrl = this._buildProxyUrl(targetPath);
          var headers = this._buildProxyHeaders(config, {
            'Content-Type': 'text/plain'
          });

          try {
            // 步骤1: 尝试写入测试文件
            var putResponse = await fetch(proxyUrl, {
              method: 'PUT',
              headers: headers,
              body: testContent
            });

            // 401 表示认证失败
            if (putResponse.status === 401) {
              return { success: false, error: '认证失败，请检查用户名和密码' };
            }

            // 403 表示没有写入权限
            if (putResponse.status === 403) {
              return { success: false, error: '没有写入权限' };
            }

            // PUT 成功的状态码: 200, 201, 204
            if (![200, 201, 204].includes(putResponse.status)) {
              return {
                success: false,
                error:
                  '写入测试失败，请检查目录是否已创建: HTTP ' +
                  putResponse.status
              };
            }

            // 步骤2: 尝试读取测试文件
            var getHeaders = this._buildProxyHeaders(config);
            var getResponse = await fetch(proxyUrl, {
              method: 'GET',
              headers: getHeaders
            });

            if (getResponse.status !== 200) {
              return {
                success: false,
                error: '读取测试失败: HTTP ' + getResponse.status
              };
            }

            var readContent = await getResponse.text();
            if (readContent !== testContent) {
              return { success: false, error: '数据验证失败' };
            }

            // 步骤3: 删除测试文件（清理）
            var deleteHeaders = this._buildProxyHeaders(config);
            await fetch(proxyUrl, {
              method: 'DELETE',
              headers: deleteHeaders
            });
            // 删除失败也不影响测试结果，忽略错误

            return { success: true };
          } catch (e) {
            return { success: false, error: e.message || '网络错误' };
          }
        }

        // WebDAV 读取文件
        async webdavGet(filename) {
          var targetPath = this.webdavConfig.path + filename;
          var proxyUrl = this._buildProxyUrl(targetPath);
          var headers = this._buildProxyHeaders(this.webdavConfig);
          try {
            var response = await fetch(proxyUrl, {
              method: 'GET',
              headers: headers
            });
            if (response.status === 200) {
              return await response.text();
            } else if (response.status === 404) {
              return null;
            } else {
              console.error('WebDAV GET 失败:', response.status);
              return null;
            }
          } catch (e) {
            console.error('WebDAV GET 错误:', e);
            return null;
          }
        }

        // WebDAV 写入文件
        async webdavPut(filename, content) {
          var targetPath = this.webdavConfig.path + filename;
          var proxyUrl = this._buildProxyUrl(targetPath);
          var headers = this._buildProxyHeaders(this.webdavConfig, {
            'Content-Type': 'application/json'
          });
          try {
            var response = await fetch(proxyUrl, {
              method: 'PUT',
              headers: headers,
              body: content
            });
            return (
              response.status === 200 ||
              response.status === 201 ||
              response.status === 204
            );
          } catch (e) {
            console.error('WebDAV PUT 错误:', e);
            return false;
          }
        }

        // WebDAV 防抖同步（减少频繁写入）
        _debouncedWebdavSync(value) {
          this._pendingWebdavData = value;
          if (this._webdavSyncTimer) {
            clearTimeout(this._webdavSyncTimer);
          }
          this._webdavSyncTimer = setTimeout(async () => {
            if (this._pendingWebdavData) {
              console.log('[WebDAV] 同步数据到远程...');
              var success = await this.webdavPut(
                'sessions.json',
                this._pendingWebdavData
              );
              if (!success) {
                console.error('[WebDAV] 同步失败');
              } else {
                console.log('[WebDAV] 同步成功');
              }
              this._pendingWebdavData = null;
            }
            this._webdavSyncTimer = null;
          }, 5000); // 5秒防抖
        }

        // 立即同步到 WebDAV（用于页面关闭前等场景）
        async flushWebdavSync() {
          if (this._webdavSyncTimer) {
            clearTimeout(this._webdavSyncTimer);
            this._webdavSyncTimer = null;
          }
          if (this._pendingWebdavData && this.webdavEnabled) {
            console.log('[WebDAV] 立即同步数据...');
            await this.webdavPut('sessions.json', this._pendingWebdavData);
            this._pendingWebdavData = null;
          }
        }

        async init() {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              this.db = request.result;
              resolve(this.db);
            };

            request.onupgradeneeded = event => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains(this.storeName)) {
                db.createObjectStore(this.storeName, { keyPath: 'key' });
              }
            };
          });
        }

        async setItem(key, value) {
          // 先写入本地 IndexedDB（保证数据安全）
          if (!this.db) await this.init();

          await new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readwrite'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.put({ key, value });

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
          });

          // 如果是sessions且启用了WebDAV，则使用防抖同步到远程
          if (key === 'openai_sessions' && this.webdavEnabled) {
            this._debouncedWebdavSync(value);
          }
        }

        async getItem(key) {
          // 如果是sessions且启用了WebDAV，则从远程读取
          if (key === 'openai_sessions' && this.webdavEnabled) {
            // 设置加载状态
            if (window.app) window.app.isLoadingRemoteSessions = true;
            try {
              // 120秒内的缓存有效
              const timestamp = Math.floor(Date.now() / 1000 / 120);
              var remoteData = await this.webdavGet(
                'sessions.json?v=' + timestamp
              );
              if (remoteData !== null) {
                if (window.app) {
                  window.app.showToast('远程数据已加载', 'success');
                }
                return remoteData;
              }
              // 如果远程没有数据，回退到本地
              console.log('WebDAV无数据，尝试从本地读取');
            } finally {
              if (window.app) window.app.isLoadingRemoteSessions = false;
            }
          }

          if (!this.db) await this.init();

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const result = request.result;
              resolve(result ? result.value : null);
            };
          });
        }

        // 计算IndexedDB存储空间大小（MB）
        async getTotalDataSize() {
          if (!this.db) await this.init();

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const allData = request.result;
              let totalSize = 0;

              // 计算所有数据的JSON字符串大小
              allData.forEach(item => {
                const jsonString = JSON.stringify(item);
                // 使用UTF-8编码计算字节数
                totalSize += new Blob([jsonString]).size;
              });

              // 转换为MB
              const sizeInMB = totalSize / (1024 * 1024);
              resolve(sizeInMB);
            };
          });
        }

        // 获取存储空间统计信息
        async getStorageStats() {
          if (!this.db) await this.init();

          const stats = {
            totalSizeMB: 0,
            itemCount: 0,
            largestItemKey: '',
            largestItemSizeMB: 0
          };

          return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(
              [this.storeName],
              'readonly'
            );
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const allData = request.result;
              let totalSize = 0;
              let maxSize = 0;
              let maxKey = '';

              allData.forEach(item => {
                const jsonString = JSON.stringify(item);
                const itemSize = new Blob([jsonString]).size;
                totalSize += itemSize;

                if (itemSize > maxSize) {
                  maxSize = itemSize;
                  maxKey = item.key || 'unknown';
                }
              });

              stats.totalSizeMB = totalSize / (1024 * 1024);
              stats.itemCount = allData.length;
              stats.largestItemKey = maxKey;
              stats.largestItemSizeMB = maxSize / (1024 * 1024);

              resolve(stats);
            };
          });
        }
      }

      // 全局实例
      window.openaiDB = new OpenaiDB();
    </script>
  </head>

  <body>
    <div id="app">
      <!-- 移动端菜单按钮 -->
      <button
        v-cloak
        v-show="isMobile"
        class="mobile-menu-btn"
        style="display: none"
        @click="toggleSidebar"
      >
        {{ !showSidebar ? '☰' : '＜' }}
      </button>
      <!-- 移动端遮罩层 -->
      <div
        class="sidebar-overlay"
        :class="{ show: showSidebar && isMobile }"
        v-cloak
        @click="hideSidebar"
      ></div>
      <div class="container" :class="{ wide: isWideMode }">
        <!-- 侧边栏 -->
        <div
          v-show="true"
          class="sidebar"
          :class="{ show: showSidebar || !isMobile, mobile: isMobile }"
          v-cloak
          style="display: none"
        >
          <!-- 设置按钮 -->
          <div class="settings-section">
            <button
              class="settings-btn"
              :class="{ mobile: isMobile }"
              @click="openSettingsModal()"
            >
              ⚙️ 设置
              <span v-if="!apiKey" style="color: #e74c3c; margin-left: 4px"
                >(未配置)</span
              >
              <span
                v-else-if="storageMode === 'webdav'"
                style="color: #5fbdbd; margin-left: 4px"
                >(远程存储)</span
              >
            </button>
          </div>
          <!-- 角色设定 -->
          <div v-show="!isLoadingRemoteSessions" class="role-setting">
            <label
              for="rolePrompt"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
                font-weight: 500;
              "
            >
              <span>
                <span>角色设定&nbsp;</span>
                <span v-if="!globalRolePromptEnabled">(已禁用):</span>
                <span v-else-if="!globalRolePrompt">(可选):</span>
                <span v-else="">(已启用):</span>
              </span>
              <span>
                <button
                  class="reset-btn"
                  style="
                    width: 0;
                    padding-left: 0;
                    padding-right: 0;
                    margin-left: 0;
                    visibility: hidden;
                    pointer-events: none;
                  "
                >
                  　
                </button>
                <button
                  v-if="globalRolePrompt && globalRolePromptEnabled"
                  class="reset-btn"
                  @click="clearRolePrompt"
                  title="清空角色设定"
                >
                  清空
                </button>
                <button
                  v-if="globalRolePrompt"
                  class="reset-btn"
                  :title="globalRolePromptEnabled ? '禁用角色设定' : '启用角色设定'"
                  @click="toggleRolePrompt()"
                >
                  {{ globalRolePromptEnabled ? '禁用' : '启用' }}
                </button>
              </span>
            </label>
            <textarea
              id="rolePrompt"
              v-model="globalRolePrompt"
              class="role-textarea"
              :disabled="!globalRolePromptEnabled && globalRolePrompt.length > 0"
              placeholder="输入系统提示词或角色设定..."
              @input="updateGlobalRolePrompt"
            >
            </textarea>
          </div>
          <!-- 新建会话按钮 -->
          <button
            v-show="!isLoadingRemoteSessions"
            @click="createNewSession"
            class="new-session-btn"
          >
            ➕ 新建会话
          </button>
          <!-- 会话列表 -->
          <div class="sessions">
            <!-- 远程加载中的提示 -->
            <div
              v-if="isLoadingRemoteSessions"
              class="loading-remote-sessions"
              style="margin-top: calc(50vh - 70px - 104px)"
            >
              <span class="loading-spinner"></span>
              <span>正在加载远程数据...</span>
            </div>
            <div
              v-for="session in sessions"
              v-show="!isLoadingRemoteSessions"
              :key="session.id"
              @click="switchSession(session.id)"
              :class="['session-item', { active: currentSessionId === session.id }]"
              :title="session.summary || session.title || '新会话'"
            >
              <div class="session-title">
                <span>{{ session.summary || session.title || '新会话' }}</span>
                <span v-if="session.role">&nbsp;💭</span>
              </div>
              <button
                @click.stop="deleteSession(session.id)"
                class="delete-btn"
                title="删除会话"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        <!-- 主聊天区域 -->
        <div class="main-chat" v-show="true" v-cloak style="display: none">
          <!-- 头部 -->
          <div class="header">
            <h2 style="cursor: pointer">
              <div class="brand" @click="showAbout">
                <img
                  src="./favicon.svg"
                  alt=""
                  width="24"
                  height="24"
                  style="flex: 0 0 auto; line-height: 1"
                />
                <span>OpenAI Chat</span>
              </div>
            </h2>
            <div class="model-wrap">
              <select
                v-model="selectedModel"
                class="model-select"
                :class="{simple: availableModels.length <= 10}"
                id="selectedModel"
                :disabled="isLoading || isStreaming"
                @change="saveData()"
              >
                <option v-if="false">　</option>
                <option
                  v-for="i in availableModels"
                  :key="i.value"
                  :value="i.value"
                >
                  {{ i.label }}
                </option>
              </select>
              <label for="needSearch" class="model-search-label">
                <input
                  type="checkbox"
                  v-model="needSearch"
                  class="model-search"
                  id="needSearch"
                  @change="saveData()"
                />
                <span>联网搜索</span>
              </label>
            </div>
            <div class="tool-btns">
              <button
                v-if="isPC"
                class="tool-btn wide-btn"
                @click="toggleWideMode"
              >
                {{ isWideMode ? '&nbsp;› 收窄 ‹&nbsp;' : '&nbsp;‹ 加宽 ›&nbsp;'
                }}
              </button>
              <button
                v-if="currentSession && currentSession.messages && currentSession.messages.length > 1 && !isLoading && !isStreaming"
                class="tool-btn share-btn"
                @click="shareSession"
              >
                📸 分享
              </button>
            </div>
          </div>
          <!-- 消息区域 -->
          <div class="messages-container" ref="messagesContainer">
            <div
              v-if="!currentSession || !currentSession.messages || currentSession.messages.length === 0"
              class="empty-state"
            >
              <div
                v-if="isLoadingRemoteSessions"
                class="loading-remote-sessions"
              >
                <span class="loading-spinner"></span>
                <span>正在加载远程数据...</span>
              </div>
              <template v-if="!isLoadingRemoteSessions">
                <h3>开始与 AI 对话</h3>
                <p>选择一个模型并输入您的问题</p>
              </template>
            </div>
            <div
              v-if="currentSession && currentSession.messages && currentSession.messages.length > 0"
              class="session-content"
              :class="{capturing: isCapturing}"
            >
              <!-- 角色设定显示 -->
              <div
                v-if="currentSession.role && currentSession.role.trim()"
                class="content-section role-section"
              >
                <h4>
                  <span>
                    <label for="fold">
                      <span>角色设定　</span>
                      <input
                        v-show="!isCapturing"
                        v-model="isFoldRole"
                        type="checkbox"
                        id="fold"
                      />
                      <small v-show="!isCapturing">&nbsp;折叠</small>
                    </label>
                  </span>
                  <button
                    @click="copyToClipboard(currentSession.role)"
                    class="copy-btn"
                    title="复制角色设定"
                  >
                    复制
                  </button>
                </h4>
                <div
                  class="rendered-content markdown-body"
                  v-html="renderMarkdown(currentSession.role)"
                ></div>
              </div>
              <!-- 使用v-for渲染消息列表 -->
              <template
                v-for="(msg, msgIndex) in currentSession.messages"
                :key="msgIndex"
              >
                <!-- 用户消息 -->
                <div
                  v-if="msg.type === 'user'"
                  class="content-section question-section"
                >
                  <h4>
                    <span>
                      <span>{{ getMsgLabel(msg, msgIndex) }}</span>
                      <small v-if="msg.time"
                        >&emsp;{{ formatTimeStr(msg.time) }}</small
                      >
                    </span>
                    <div>
                      <button
                        v-if="canEditMessage(msgIndex)"
                        class="copy-btn"
                        title="编辑问题"
                        @click="editQuestion(msgIndex)"
                      >
                        编辑
                      </button>
                      <button
                        @click="copyToClipboard(msg.content)"
                        class="copy-btn"
                        title="复制问题"
                      >
                        复制
                      </button>
                    </div>
                  </h4>
                  <div
                    class="rendered-content markdown-body"
                    v-html="renderMarkdown(msg.content)"
                  ></div>
                  <!-- 图片链接 -->
                  <div
                    v-if="msg.images && msg.images.length > 0"
                    class="question-images"
                  >
                    <a
                      v-for="(img, imgIdx) in msg.images"
                      :key="imgIdx"
                      href="javascript:void(0)"
                      :title="img === 'INVALID' ? '图片未上传,无法预览' : '点击预览'"
                      :style="img === 'INVALID' ? 'cursor: not-allowed; opacity: 0.5;' : ''"
                      @click="previewImage(img)"
                    >
                      📎 {{ img === 'INVALID' ? '本地' : '' }}图片{{ imgIdx + 1
                      }}
                    </a>
                  </div>
                  <!-- 文本附件链接 -->
                  <div
                    v-if="msg.plaintexts && msg.plaintexts.length > 0"
                    class="question-images"
                  >
                    <a
                      v-for="(txt, txtIdx) in msg.plaintexts"
                      :key="'txt-' + txtIdx"
                      href="javascript:void(0)"
                      title="点击预览内容"
                      @click="previewPlaintext(txt)"
                    >
                      📄 {{ txt.name }}
                    </a>
                  </div>
                </div>
                <!-- AI回答 -->
                <div
                  v-if="msg.type === 'bot'"
                  class="content-section answer-section"
                >
                  <h4>
                    <span>
                      <span>回答</span>
                      <small v-if="msg.model"
                        >&emsp;{{ getModelName(msg.model) }}</small
                      >
                    </span>
                    <div v-if="!isStreaming || !isLastBotMsg(msgIndex)">
                      <button
                        v-if="canRegenerateMessage(msgIndex)"
                        class="copy-btn"
                        title="删除并重新回答"
                        @click="regenerateAnswer(msgIndex)"
                      >
                        重新回答
                      </button>
                      <button
                        v-if="canForkMessage(msgIndex)"
                        class="copy-btn"
                        title="从此处分叉创建新会话"
                        @click="forkFromMessage(msgIndex)"
                      >
                        分叉
                      </button>
                      <button
                        class="copy-btn"
                        title="复制回答"
                        @click="copyToClipboard(msg.content)"
                      >
                        复制
                      </button>
                    </div>
                  </h4>
                  <div
                    class="rendered-content markdown-body streaming-answer"
                    v-html="renderMarkdown(getBotMessageContent(msg, msgIndex))"
                    @click="answerClickHandler"
                  ></div>
                </div>
              </template>
              <!-- 流式回答占位（当最后一条是用户消息且正在生成回复时） -->
              <div
                v-if="isStreamingNewAnswer"
                class="content-section answer-section"
              >
                <h4>
                  <span>
                    <span>回答</span>
                    <small>&emsp;{{ getModelName(selectedModel) }}</small>
                  </span>
                </h4>
                <div
                  class="rendered-content markdown-body streaming-answer"
                  v-html="renderMarkdown(streamingContent)"
                  @click="answerClickHandler"
                ></div>
              </div>
            </div>
            <div v-if="shouldShowLoading" class="loading">
              <div class="spinner"></div>
              <span>AI 正在思考中...</span>
            </div>

            <div v-if="errorMessage" class="error-message">
              {{ errorMessage }}
            </div>

            <!-- 重新回答按钮 -->
            <div
              v-if="shouldShowRetryButton"
              style="text-align: center; margin: 0 0 20px"
            >
              <button
                @click="retryCurrentQuestion"
                class="send-btn"
                style="margin: 0 auto"
              >
                ↺ 重新回答
              </button>
            </div>
          </div>
          <!-- 输入区域 -->
          <div class="input-area">
            <!-- 上传的附件标签（图片和文本文件） -->
            <div
              v-if="uploadedImages.length > 0 || uploadedPlaintexts.length > 0"
              class="uploaded-images-tags"
            >
              <!-- 图片标签 -->
              <div
                v-for="(img, index) in uploadedImages"
                :key="'img-' + index"
                class="image-tag"
              >
                <img
                  :src="getImageDisplayUrl(img)"
                  :alt="'图片' + (index + 1)"
                />
                <span class="image-tag-text">图片{{ index + 1 }}</span>
                <button
                  class="image-tag-remove"
                  @click="removeImage(index)"
                  title="移除图片"
                >
                  ×
                </button>
              </div>
              <!-- 文本文件标签 -->
              <div
                v-for="(txt, index) in uploadedPlaintexts"
                :key="'txt-' + index"
                class="image-tag plaintext-tag"
                @click="previewPlaintext(txt)"
                title="点击预览内容"
              >
                <span class="plaintext-icon">📄</span>
                <span class="image-tag-text">{{ txt.name }}</span>
                <button
                  class="image-tag-remove"
                  @click.stop="removePlaintext(index)"
                  title="移除文件"
                >
                  ×
                </button>
              </div>
            </div>

            <div class="input-wrapper">
              <!-- 上传按钮（图片或文本文件） -->
              <button
                class="upload-btn"
                @click="triggerUpload"
                :disabled="!canInput || isUploadingImage"
                title="上传图片或文本文件"
              >
                📎
              </button>
              <input
                type="file"
                ref="imageInput"
                accept="image/*"
                style="display: none"
                @change="handleImageSelect"
              />
              <input
                type="file"
                ref="plaintextInput"
                :accept="getSupportedTextExtensions().join(',')"
                style="display: none"
                @change="handlePlaintextSelect"
              />

              <textarea
                v-model="messageInput"
                @input="onInputChange"
                @keydown="handleKeyDown"
                @paste="handlePaste"
                class="message-input can-upload"
                :placeholder="inputPlaceholder"
                :disabled="!canInput"
                rows="1"
                ref="messageInputRef"
              ></textarea>
              <button
                v-show="messageInput.trim()"
                @click="clearInput"
                class="clear-btn"
                title="清空输入"
              >
                ×
              </button>
            </div>
            <button
              v-if="isCurrentEnd"
              class="send-btn"
              @click="createNewSession"
            >
              新会话
            </button>
            <button
              v-else-if="(isLoading || isStreaming) && isSentForAWhile"
              class="send-btn danger"
              @click="cancelStreaming"
            >
              中止
            </button>
            <button
              v-else
              @click="sendMessage"
              :disabled="!canSend"
              class="send-btn"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      <!-- 隐藏的搜索结果模板 -->
      <div v-if="searchRes" ref="searchResTemplate" style="display: none">
        <div
          style="
            text-align: left;
            max-height: 70vh;
            overflow-y: auto;
            padding: 10px;
          "
        >
          <!-- 搜索查询 -->
          <div style="margin-bottom: 20px">
            <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
              🔍 搜索查询
            </h3>
            <div
              style="
                padding: 12px;
                background: #f8f9fa;
                border-radius: 8px;
                border-left: 4px solid #a8edea;
              "
            >
              <strong style="color: #2d3748; font-size: 15px"
                >{{ searchRes.query }}</strong
              >
            </div>
          </div>

          <!-- AI 总结答案 -->
          <div v-if="searchRes.answer" style="margin-bottom: 20px">
            <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
              💡 AI 总结
            </h3>
            <div
              style="
                padding: 12px;
                background: #fff3cd;
                border-radius: 8px;
                border-left: 4px solid #ffc107;
                line-height: 1.6;
                color: #666;
                font-size: 14px;
              "
            >
              {{ searchRes.answer }}
            </div>
          </div>

          <!-- 搜索结果列表 -->
          <div v-if="searchRes.results && searchRes.results.length > 0">
            <div style="margin-bottom: 10px">
              <h3 style="margin: 0 0 10px; color: #333; font-size: 16px">
                📚 搜索结果 ({{ searchRes.results.length }} 条)
              </h3>
            </div>

            <div
              v-for="(result, index) in searchRes.results"
              :key="index"
              style="
                margin-bottom: 15px;
                padding: 15px;
                background: #ffffff;
                border: 1px solid #e1e5e9;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
              "
            >
              <div style="margin-bottom: 8px">
                <span
                  style="
                    display: inline-block;
                    padding: 2px 8px;
                    background: #a8edea;
                    color: #2d3748;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 500;
                    margin-right: 8px;
                  "
                >
                  {{ index + 1 }}
                </span>
                <strong style="color: #2d3748; font-size: 14px">
                  {{ result.title || '无标题' }}
                </strong>
              </div>

              <div
                v-if="result.content"
                style="
                  margin: 8px 0;
                  color: #666;
                  font-size: 13px;
                  line-height: 1.5;
                  overflow: hidden;
                  text-overflow: ellipsis;
                  display: -webkit-box;
                  line-clamp: 5;
                  -webkit-line-clamp: 5;
                  -webkit-box-orient: vertical;
                "
              >
                {{ result.content.length > 300 ? result.content.slice(0, 300) +
                '...' : result.content }}
              </div>

              <div v-if="result.url" style="margin-top: 8px; line-height: 1.5">
                <a
                  :href="result.url"
                  target="_blank"
                  style="
                    color: #0066cc;
                    text-decoration: none;
                    font-size: 12px;
                    word-break: break-all;
                    display: -webkit-box;
                    line-clamp: 2;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    text-overflow: ellipsis;
                  "
                >
                  🔗 {{ result.url }}
                </a>
              </div>
            </div>
          </div>

          <!-- 无结果提示 -->
          <div
            v-else
            style="
              padding: 20px;
              text-align: center;
              color: #999;
              font-size: 14px;
            "
          >
            暂无搜索结果
          </div>
        </div>
      </div>

      <!-- 隐藏的关于页面模板 -->
      <div ref="aboutTemplate" style="display: none">
        <div style="max-height: 70vh; overflow-y: auto; text-align: left">
          <div style="text-align: left; padding: 10px">
            <h3 style="margin: 0 0 10px; color: #333">✨ 应用简介</h3>
            <p style="line-height: 1.6; color: #666">
              这是一个简单易用的 OpenAI API 代理服务，基于 Deno Deploy /
              Cloudflare Workers 部署。 只需要一个域名和 OpenAI API
              Key，即可免费为家人朋友提供 AI 问答服务。
            </p>

            <h3 style="margin: 20px 0 10px; color: #333">🎯 核心功能</h3>
            <ul style="line-height: 1.8; color: #666; padding-left: 20px">
              <li>提供标准的 OpenAI API 代理端点</li>
              <li>支持密码保护，避免暴露 API Key</li>
              <li>内置精美的 Web 聊天界面</li>
              <li>PWA 适配，支持移动设备添加到桌面</li>
              <li>流式响应，实时显示 AI 回答</li>
              <li>基于 IndexedDB 本地历史记录存储</li>
              <li>支持模型切换和自定义系统提示词</li>
              <li>集成 Tavily 搜索，为 AI 提供实时网络信息</li>
              <li>一键生成问答截图，方便分享</li>
              <li>智能会话命名，便于查找管理</li>
            </ul>

            <h3 style="margin: 20px 0 10px; color: #333">🔗 GitHub 仓库</h3>
            <p style="line-height: 1.6; color: #666">
              <a
                href="https://github.com/icheer/openai-webui-lite"
                target="_blank"
                style="color: #0066cc; text-decoration: none"
              >
                https://github.com/icheer/openai-webui-lite
              </a>
            </p>

            <p style="margin: 20px 0 10px; color: #999; font-size: 0.9em">
              请合理使用 AI 资源，避免滥用！
            </p>
          </div>
        </div>
      </div>

      <!-- 设置弹窗模板 -->
      <div
        v-if="!isShowSettingsModal"
        ref="settingsTemplate"
        style="display: none"
      >
        <div style="text-align: left; padding: 0 10px">
          <!-- API Key 设置 -->
          <div style="margin-bottom: 20px">
            <label
              class="label-api-key"
              style="
                display: block;
                margin-bottom: 8px;
                font-weight: 600;
                color: #333;
              "
            >
              🔑 API Key
            </label>
            <input
              type="password"
              id="settingsApiKey"
              class="swal-input-custom"
              placeholder="请输入您的 OpenAI API Key"
              autocomplete="new-password"
              style="
                width: 100%;
                padding: 10px 12px;
                border: 1px solid #ddd;
                border-radius: 8px;
                font-size: 14px;
                box-sizing: border-box;
              "
            />
          </div>

          <!-- 存储模式切换 -->
          <div style="margin-bottom: 20px">
            <label
              style="
                display: block;
                margin-bottom: 8px;
                font-weight: 600;
                color: #333;
              "
            >
              💾 会话存储模式
            </label>
            <div style="display: flex; gap: 12px">
              <label
                style="
                  display: flex;
                  align-items: center;
                  cursor: pointer;
                  padding: 10px 10px;
                  border: 2px solid #ddd;
                  border-radius: 8px;
                  flex: 1;
                  transition: all 0.2s;
                "
                class="storage-mode-option"
                data-mode="local"
              >
                <input
                  type="radio"
                  name="storageMode"
                  value="local"
                  style="margin-right: 8px"
                />
                <span style="font-size: 0.85em">
                  <span v-if="isMobile">📱</span>
                  <span v-else>🖥️</span>
                  <span> 本地存储</span>
                </span>
              </label>
              <label
                style="
                  display: flex;
                  align-items: center;
                  cursor: pointer;
                  padding: 10px 10px;
                  border: 2px solid #ddd;
                  border-radius: 8px;
                  flex: 1;
                  transition: all 0.2s;
                "
                class="storage-mode-option"
                data-mode="webdav"
              >
                <input
                  type="radio"
                  name="storageMode"
                  value="webdav"
                  style="margin-right: 8px"
                />
                <span style="font-size: 0.85em">☁️ 远程存储</span>
              </label>
            </div>
            <p style="margin: 8px 0 0; font-size: 12px; color: #888">
              <span>本地存储：数据保存在浏览器中</span>
              <br v-if="isMobile" />
              <span v-else>；</span>
              <span>远程存储：通过 WebDAV 同步到云端</span>
            </p>
          </div>

          <!-- WebDAV 配置 -->
          <div
            id="webdavConfigSection"
            style="
              display: none;
              padding: 16px;
              background: #f8f9fa;
              border-radius: 8px;
              margin-bottom: 10px;
            "
          >
            <label
              style="
                display: block;
                margin-bottom: 12px;
                font-weight: 600;
                color: #333;
              "
            >
              WebDAV 配置
            </label>
            <div style="margin-bottom: 12px">
              <label
                style="
                  display: block;
                  margin-bottom: 4px;
                  font-size: 13px;
                  color: #555;
                "
                >服务器地址</label
              >
              <input
                type="text"
                id="webdavUrl"
                placeholder="http://dav.test.cn:3000"
                style="
                  width: 100%;
                  padding: 8px 12px;
                  border: 1px solid #ddd;
                  border-radius: 6px;
                  font-size: 14px;
                  box-sizing: border-box;
                "
              />
            </div>
            <div style="margin-bottom: 12px">
              <label
                style="
                  display: block;
                  margin-bottom: 4px;
                  font-size: 13px;
                  color: #555;
                "
                >用户名</label
              >
              <input
                type="text"
                id="webdavUsername"
                placeholder="用户名"
                style="
                  width: 100%;
                  padding: 8px 12px;
                  border: 1px solid #ddd;
                  border-radius: 6px;
                  font-size: 14px;
                  box-sizing: border-box;
                "
              />
            </div>
            <div style="margin-bottom: 12px">
              <label
                style="
                  display: block;
                  margin-bottom: 4px;
                  font-size: 13px;
                  color: #555;
                "
                >密码</label
              >
              <input
                type="password"
                id="webdavPassword"
                placeholder="密码"
                autocomplete="new-password"
                style="
                  width: 100%;
                  padding: 8px 12px;
                  border: 1px solid #ddd;
                  border-radius: 6px;
                  font-size: 14px;
                  box-sizing: border-box;
                "
              />
            </div>
            <div style="margin-bottom: 12px">
              <label
                style="
                  display: block;
                  margin-bottom: 4px;
                  font-size: 13px;
                  color: #555;
                "
                >存储路径</label
              >
              <input
                type="text"
                id="webdavPath"
                placeholder="/openai-chat/"
                style="
                  width: 100%;
                  padding: 8px 12px;
                  border: 1px solid #ddd;
                  border-radius: 6px;
                  font-size: 14px;
                  box-sizing: border-box;
                "
              />
              <p style="margin: 4px 0 0; font-size: 11px; color: #888">
                应以'/'结束，留空则使用默认路径 /openai-chat/
              </p>
            </div>
            <button
              type="button"
              id="testWebdavBtn"
              style="
                width: 100%;
                padding: 10px;
                background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
                border: none;
                border-radius: 6px;
                font-size: 14px;
                cursor: pointer;
                font-weight: 500;
              "
            >
              🔗 测试连接
            </button>
          </div>
        </div>
      </div>
    </div>

    <script>
      const \$ = selector => document.querySelector(selector);
      const \$\$ = selector => Array.from(document.querySelectorAll(selector));
      const { createApp } = Vue;

      window.app = createApp({
        data() {
          return {
            apiKey: '',
            messageInput: '',
            isLoading: false,
            isShowSettingsModal: false,
            isSentForAWhile: false,
            errorMessage: '',
            selectedModel: '',
            availableModels: ['\$MODELS_PLACEHOLDER\$'],
            sessions: [],
            currentSessionId: null,
            isFoldRole: false,
            isCapturing: false,
            globalRolePrompt: '',
            globalRolePromptEnabled: true,
            isMobile: window.innerWidth <= 768, // 是否移动设备
            isWideMode: !!localStorage.getItem('wideMode'),
            showSidebar: false,
            isStreaming: false,
            streamingContent: '',
            abortController: null,
            uploadedImages: [], // 待发送的图片列表 [{ url: string, file: File }]
            uploadedPlaintexts: [], // 待发送的文本文件列表 [{ name: string, content: string }]
            isUploadingImage: false,
            needSearch: false,
            searchRes: null,
            tomSelect: null,
            sidebarHashAdded: false, // 标记是否为侧边栏添加了hash
            swalHashAdded: false, // 标记是否为弹窗添加了hash
            isLoadingRemoteSessions: false, // 是否正在加载远程会话数据
            // 存储模式相关
            storageMode: 'local', // 'local' 或 'webdav'
            webdavConfig: {
              url: '',
              username: '',
              password: '',
              path: '/openai-chat/'
            }
          };
        },
        computed: {
          isPC() {
            return !this.isMobile;
          },
          hostname() {
            return window.location.hostname;
          },
          isMySite() {
            return this.hostname.endsWith('.keyi.ma');
          },
          currentSession() {
            return this.sessions.find(s => s.id === this.currentSessionId);
          },
          isCurrentEnd() {
            var session = this.currentSession;
            if (!session) return false;
            if (this.isLoading || this.isStreaming) return false;
            // 获取用户消息数量
            var userMsgCount = this.getUserMessageCount(session);
            // 如果用户已发送8条消息，则会话结束
            if (userMsgCount >= 8) return true;
            // 或者最后一条消息是bot的回复，用户可以继续追问
            return false;
          },
          // 检查是否已达到最大消息数限制
          isMaxMessagesReached() {
            var session = this.currentSession;
            if (!session) return false;
            return this.getUserMessageCount(session) >= 8;
          },
          // 判断是否正在为新消息生成回复（最后一条是user消息且正在streaming）
          isStreamingNewAnswer() {
            if (!this.isLoading && !this.isStreaming) return false;
            var session = this.currentSession;
            if (!session || !session.messages || session.messages.length === 0)
              return false;
            var lastMsg = session.messages[session.messages.length - 1];
            return lastMsg.type === 'user';
          },
          isTotallyBlank() {
            const list = this.sessions || [];
            return !list.some(s => {
              return s.messages && s.messages.length > 0;
            });
          },
          inputPlaceholder() {
            var session = this.currentSession || {};
            var suffix = this.getRolePrompt() ? ' (role ✓)' : '';
            if (!this.apiKey) {
              return '请先在左上角设置 API Key';
            } else if (this.isLoadingRemoteSessions) {
              return '正在加载远程数据...';
            } else if (this.isLoading) {
              return 'AI 正在思考中...';
            } else if (this.isStreaming) {
              return 'AI 正在生成回答...';
            } else if (this.isUploadingImage) {
              return '图片上传中...';
            } else if (this.isMaxMessagesReached) {
              return '当前会话已达到最大消息数限制(8条)';
            } else if (!this.selectedModel) {
              return '请选择一个模型';
            } else if (session.messages && session.messages.length > 0) {
              return '输入您的追问...' + suffix;
            } else {
              return '输入您的问题...' + suffix;
            }
          },
          canInput() {
            var session = this.currentSession;
            return (
              this.apiKey &&
              !this.isLoadingRemoteSessions &&
              !this.isLoading &&
              !this.isStreaming &&
              !this.isMaxMessagesReached
            );
          },
          canSend() {
            return (
              (this.messageInput.trim() ||
                this.uploadedImages.length > 0 ||
                this.uploadedPlaintexts.length > 0) &&
              this.selectedModel &&
              !this.isUploadingImage &&
              this.canInput
            );
          },
          canUploadImage() {
            const isModelSupport = /(gpt|qwen|kimi)/.test(this.selectedModel);
            return isModelSupport && this.isMySite;
          },
          // 判断是否需要显示loading
          shouldShowLoading() {
            if (this.isLoading) return true;
            if (this.isStreaming) {
              if (!this.streamingContent) return true;
              if (this.streamingContent.endsWith(' 条相关信息。\\n\\n'))
                return true;
            }
            return false;
          },
          // 判断是否需要显示"重新回答"按钮（有问题但没有回答，且没有正在加载）
          shouldShowRetryButton() {
            var session = this.currentSession;
            if (!session) return false;
            if (this.isLoading || this.isStreaming) return false;
            if (!session.messages || session.messages.length === 0)
              return false;
            // 最后一条消息是user类型且没有对应的bot回复
            var lastMsg = session.messages[session.messages.length - 1];
            return lastMsg.type === 'user';
          }
        },
        async mounted() {
          this.initModels();
          this.\$nextTick(() => {
            this.initTomSelect();
          });

          // 加载WebDAV配置
          await window.openaiDB.loadWebDAVConfig();
          this.storageMode = window.openaiDB.webdavEnabled ? 'webdav' : 'local';
          this.webdavConfig = Object.assign({}, window.openaiDB.webdavConfig);

          // 初始化 IndexedDB
          await window.openaiDB.init();

          const renderer = new marked.Renderer();
          const originalHtmlRenderer = renderer.html.bind(renderer);
          renderer.html = function (text) {
            // marked 会自动处理代码块内的内容，这里只处理普通文本
            // 有条件的转义：如果 < 后面不是 a, br, blockquote, details, summary 标签，才进行转义
            const escaped = text.replace(
              /<(?!\\/?(a|br|blockquote|details|summary)[\\s>])/gi,
              '&lt;'
            );
            return originalHtmlRenderer(escaped);
          };

          // 配置 marked
          marked.setOptions({
            renderer,
            breaks: true, // 支持 GFM 换行
            gfm: true, // 启用 GitHub Flavored Markdown
            tables: true, // 支持表格
            pedantic: false, // 不使用原始的 markdown.pl 规则
            sanitize: false, // 不清理 HTML（因为我们信任内容）
            smartLists: true, // 使用更智能的列表行为
            smartypants: false // 不使用智能标点符号
          });
          marked.use({
            extensions: [
              {
                name: 'strongWithCJK',
                level: 'inline',
                start(src) {
                  return src.match(/\\*\\*/)?.index;
                },
                tokenizer(src) {
                  const rule = /^\\*\\*([^\\*]+?)\\*\\*/;
                  const match = rule.exec(src);
                  if (match) {
                    return {
                      type: 'strongWithCJK',
                      raw: match[0],
                      text: match[1]
                    };
                  }
                },
                renderer(token) {
                  return '<strong>' + token.text + '</strong>';
                }
              }
            ]
          });

          // 检测是否为移动端
          this.checkMobile();
          window.addEventListener('resize', this.checkMobile);

          // 监听浏览器后退事件（移动端体验优化）
          window.addEventListener('popstate', this.handlePopState);

          await this.loadData();
          if (this.sessions.length === 0) {
            this.createNewSession();
          }
          // 计算OpenAI DB总数据量
          const totalDataSize = await window.openaiDB.getTotalDataSize();
          if (totalDataSize > 3) {
            this.showSwal({
              title: '数据量过大',
              text:
                '当前存储的数据量为' +
                totalDataSize.toFixed(2) +
                ' MB，超过了 3MB，可能会影响性能。建议清理一些旧会话。',
              icon: 'warning',
              confirmButtonText: '&nbsp;知道了&nbsp;'
            });
          }
        },

        beforeUnmount() {
          window.removeEventListener('resize', this.checkMobile);
          window.removeEventListener('popstate', this.handlePopState);
        },
        watch: {
          messageInput() {
            this.autoResizeTextarea();
          },
          streamingContent() {
            this.stickToBottom();
          },
          selectedModel(newVal, oldVal) {
            // 避免在初始化时触发保存（空值变为有效值时不保存）
            if (!oldVal && newVal) {
              // 首次从空值变为有效值，不触发保存（由 loadData 负责）
              if (this.tomSelect && this.tomSelect.getValue() !== newVal) {
                this.tomSelect.setValue(newVal, true);
              }
              return;
            }
            // 正常的模型切换，更新 TomSelect
            if (this.tomSelect && this.tomSelect.getValue() !== newVal) {
              this.tomSelect.setValue(newVal, true);
            }
          }
        },
        methods: {
          // 移动端后退体验优化：添加hash锚点
          addHash(type) {
            if (!this.isMobile) return;
            const hash = '#' + type;
            if (window.location.hash !== hash) {
              window.history.pushState(null, '', hash);
            }
          },

          // 移动端后退体验优化：移除hash锚点
          removeHash() {
            if (!this.isMobile) return;
            if (window.location.hash) {
              window.history.back();
            }
          },

          // 移动端后退体验优化：处理浏览器后退事件
          handlePopState(event) {
            if (!this.isMobile) return;

            // 如果侧边栏是打开的，关闭它
            if (this.showSidebar && this.sidebarHashAdded) {
              this.showSidebar = false;
              this.sidebarHashAdded = false;
              return;
            }

            // 如果有Swal弹窗打开，关闭它
            if (Swal.isVisible() && this.swalHashAdded) {
              Swal.close();
              this.swalHashAdded = false;
              return;
            }
          },

          // 包装Swal.fire以支持移动端hash管理
          showSwal(options, addHash = true) {
            const isMobile = this.isMobile;
            const originalDidOpen = options.didOpen;
            const originalWillClose = options.willClose;

            // 扩展didOpen回调
            options.didOpen = (...args) => {
              if (isMobile && addHash) {
                this.addHash('modal');
                this.swalHashAdded = true;
              }
              if (originalDidOpen) {
                originalDidOpen.apply(this, args);
              }
            };

            // 扩展willClose回调
            options.willClose = (...args) => {
              if (isMobile && addHash && this.swalHashAdded) {
                this.removeHash();
                this.swalHashAdded = false;
              }
              if (originalWillClose) {
                originalWillClose.apply(this, args);
              }
            };

            return Swal.fire(options);
          },

          // 切换PC宽屏模式
          toggleWideMode(flag = undefined) {
            this.isWideMode = !this.isWideMode;
            if (flag === true) {
              this.isWideMode = true;
            } else if (flag === false) {
              this.isWideMode = false;
            }
            if (this.isWideMode) {
              localStorage.setItem('wideMode', '1');
            } else {
              localStorage.removeItem('wideMode');
            }
          },

          // 打开设置弹窗
          openSettingsModal() {
            var template = this.\$refs.settingsTemplate;
            if (!template) return;
            var htmlContent = template.innerHTML;

            Swal.fire({
              title: '⚙️ 设置',
              html: htmlContent,
              width: this.isMobile ? '95%' : '500px',
              showCancelButton: true,
              confirmButtonText: '保存',
              cancelButtonText: '取消',
              confirmButtonColor: '#5fbdbd',
              allowOutsideClick: false,
              showCloseButton: false,
              reverseButtons: true,
              didOpen: async () => {
                this.isShowSettingsModal = true;
                await this.\$nextTick();
                // 填充当前值
                var apiKeyInput = \$('#settingsApiKey');
                if (apiKeyInput) apiKeyInput.value = this.apiKey || '';

                var localRadio = \$('input[name="storageMode"][value="local"]');
                var webdavRadio = \$(
                  'input[name="storageMode"][value="webdav"]'
                );
                if (this.storageMode === 'webdav' && webdavRadio) {
                  webdavRadio.checked = true;
                } else if (localRadio) {
                  localRadio.checked = true;
                }

                // 填充WebDAV配置
                var urlInput = \$('#webdavUrl');
                var usernameInput = \$('#webdavUsername');
                var passwordInput = \$('#webdavPassword');
                var pathInput = \$('#webdavPath');
                if (urlInput) urlInput.value = this.webdavConfig.url || '';
                if (usernameInput)
                  usernameInput.value = this.webdavConfig.username || '';
                if (passwordInput)
                  passwordInput.value = this.webdavConfig.password || '';
                if (pathInput)
                  pathInput.value = this.webdavConfig.path || '/openai-chat/';

                // 显示/隐藏WebDAV配置区域
                var webdavSection = \$('#webdavConfigSection');
                if (webdavSection) {
                  webdavSection.style.display =
                    this.storageMode === 'webdav' ? 'block' : 'none';
                }

                // 更新选中状态样式
                this.updateStorageModeStyle();

                // 绑定存储模式切换事件
                var radios = \$\$('input[name="storageMode"]');
                radios.forEach(radio => {
                  radio.addEventListener('change', () => {
                    var webdavSection = \$('#webdavConfigSection');
                    if (webdavSection) {
                      webdavSection.style.display =
                        radio.value === 'webdav' ? 'block' : 'none';
                    }
                    this.updateStorageModeStyle();
                  });
                });

                // 绑定测试按钮事件
                var testBtn = \$('#testWebdavBtn');
                if (testBtn) {
                  testBtn.addEventListener('click', () => {
                    this.testWebDAVFromModal();
                  });
                }

                var title = \$('.swal2-modal .swal2-title');
                if (title) {
                  title.addEventListener('dblclick', () => {
                    this.reloadPage();
                  });
                }
              },
              preConfirm: async () => {
                const isValid = await this.validateAndSaveSettings();
                if (isValid) {
                  this.isShowSettingsModal = false;
                }
                return isValid;
              }
            }).then(() => {
              this.isShowSettingsModal = false;
            });
          },

          // 更新存储模式选项样式
          updateStorageModeStyle() {
            var options = \$\$('.storage-mode-option');
            options.forEach(option => {
              var radio = option.querySelector('input[type="radio"]');
              if (radio && radio.checked) {
                option.style.borderColor = '#5fbdbd';
                option.style.background = 'rgba(95, 189, 189, 0.1)';
              } else {
                option.style.borderColor = '#ddd';
                option.style.background = 'transparent';
              }
            });
          },

          // 从弹窗中测试WebDAV连接
          async testWebDAVFromModal() {
            var urlInput = \$('#webdavUrl');
            var usernameInput = \$('#webdavUsername');
            var passwordInput = \$('#webdavPassword');
            var pathInput = \$('#webdavPath');
            var testBtn = \$('#testWebdavBtn');
            var config = {
              url: urlInput ? urlInput.value.trim() : '',
              username: usernameInput ? usernameInput.value.trim() : '',
              password: passwordInput ? passwordInput.value : '',
              path: (pathInput ? pathInput.value.trim() : '') || '/openai-chat/'
            };

            // 基本验证
            if (!config.url) {
              this.showToast('请输入服务器地址', 'error');
              return;
            }
            if (!config.username) {
              this.showToast('请输入用户名', 'error');
              return;
            }
            if (!config.password) {
              this.showToast('请输入密码', 'error');
              return;
            }

            // 显示测试中状态
            if (testBtn) {
              testBtn.disabled = true;
              testBtn.textContent = '⏳ 测试中...';
            }

            var result = await window.openaiDB.testWebDAVConnection(config);

            if (testBtn) {
              testBtn.disabled = false;
              testBtn.textContent = '🔗 测试连接';
            }

            if (result.success) {
              this.showToast('连接成功！', 'success');
            } else {
              this.showToast('连接失败: ' + result.error, 'error');
            }
          },

          // 显示Toast提示（不影响Swal弹窗）
          showToast(message, icon) {
            // 创建toast容器（如果不存在）
            var container = \$('#custom-toast-container');
            if (!container) {
              container = document.createElement('div');
              container.id = 'custom-toast-container';
              container.style.cssText =
                'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 99999; display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none;';
              document.body.appendChild(container);
            }

            // 创建toast元素
            var toast = document.createElement('div');
            toast.style.cssText =
              'padding: 12px 20px; border-radius: 8px; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 8px; font-size: 14px; opacity: 0; transform: translateY(-10px); transition: all 0.3s ease; pointer-events: auto;';

            // 根据icon类型设置颜色和图标
            var iconEmoji = '💬';
            var bgColor = '#fff';
            var borderColor = '#e0e0e0';
            if (icon === 'success') {
              iconEmoji = '✅';
              borderColor = '#5fbdbd';
            } else if (icon === 'error') {
              iconEmoji = '❌';
              borderColor = '#e74c3c';
            } else if (icon === 'warning') {
              iconEmoji = '⚠️';
              borderColor = '#f39c12';
            } else if (icon === 'info') {
              iconEmoji = 'ℹ️';
              borderColor = '#3498db';
            }
            toast.style.borderLeft = '4px solid ' + borderColor;

            toast.innerHTML =
              '<span style="font-size: 16px;">' +
              iconEmoji +
              '</span><span>' +
              message +
              '</span>';
            container.appendChild(toast);

            // 显示动画
            requestAnimationFrame(() => {
              toast.style.opacity = '1';
              toast.style.transform = 'translateY(0)';
            });

            // 3秒后隐藏并移除
            this.sleep(3000).then(() => {
              toast.style.opacity = '0';
              toast.style.transform = 'translateY(-10px)';
              this.sleep(300).then(() => {
                if (toast.parentNode) {
                  toast.parentNode.removeChild(toast);
                }
              });
            });
          },

          // 验证并保存设置
          async validateAndSaveSettings() {
            var apiKeyInput = \$('#settingsApiKey');
            var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';

            var storageModeRadio = \$('input[name="storageMode"]:checked');
            var storageMode = storageModeRadio
              ? storageModeRadio.value
              : 'local';

            // API Key 验证
            if (!apiKey) {
              this.showToast('请输入 API Key', 'error');
              return false;
            }

            // 在保存前记录旧的存储模式，用于后续判断是否切换了模式
            var oldMode = window.openaiDB.webdavEnabled ? 'webdav' : 'local';

            // 如果选择了WebDAV，验证配置
            if (storageMode === 'webdav') {
              var urlInput = \$('#webdavUrl');
              var usernameInput = \$('#webdavUsername');
              var passwordInput = \$('#webdavPassword');
              var pathInput = \$('#webdavPath');

              var webdavConfig = {
                url: urlInput ? urlInput.value.trim() : '',
                username: usernameInput ? usernameInput.value.trim() : '',
                password: passwordInput ? passwordInput.value : '',
                path:
                  (pathInput ? pathInput.value.trim() : '') || '/openai-chat/'
              };

              // WebDAV必填项验证
              if (!webdavConfig.url) {
                this.showToast('请输入 WebDAV 服务器地址', 'error');
                return false;
              }
              if (!webdavConfig.username) {
                this.showToast('请输入 WebDAV 用户名', 'error');
                return false;
              }
              if (!webdavConfig.password) {
                this.showToast('请输入 WebDAV 密码', 'error');
                return false;
              }

              // WebDAV连通性测试
              Swal.showLoading();
              var result =
                await window.openaiDB.testWebDAVConnection(webdavConfig);
              if (!result.success) {
                Swal.hideLoading();
                this.showToast('WebDAV 连接失败: ' + result.error, 'error');
                return false;
              }

              // 保存WebDAV配置
              this.webdavConfig = webdavConfig;
              await window.openaiDB.saveWebDAVConfig(true, webdavConfig);
              this.storageMode = 'webdav';
            } else {
              // 本地存储模式
              await window.openaiDB.saveWebDAVConfig(false, this.webdavConfig);
              this.storageMode = 'local';
            }

            // 保存API Key
            this.apiKey = apiKey;
            await this.saveApiKey();

            // 如果切换了存储模式，需要重新加载数据
            if (oldMode !== storageMode) {
              // 重新加载会话数据
              this.showToast('存储模式已切换，正在重新加载数据...', 'info');
              await this.loadSessions();
            }

            this.showToast('设置已保存', 'success');
            return true;
          },

          // 加载会话数据（独立方法）
          async loadSessions() {
            var savedSessions =
              await window.openaiDB.getItem('openai_sessions');
            if (savedSessions) {
              var parsed = JSON.parse(savedSessions);
              var migratedSessions = this.migrateSessionData(parsed);
              if (migratedSessions) {
                this.sessions = migratedSessions;
              } else {
                this.sessions = parsed;
              }
            } else {
              this.sessions = [];
            }

            // 加载当前会话ID
            var savedCurrentId = await window.openaiDB.getItem(
              'openai_current_session'
            );
            if (
              savedCurrentId &&
              this.sessions.find(s => s.id === savedCurrentId)
            ) {
              this.currentSessionId = savedCurrentId;
            } else if (this.sessions.length > 0) {
              this.currentSessionId = this.sessions[0].id;
            } else {
              this.createNewSession();
            }
          },

          initTomSelect() {
            if (this.tomSelect) return;
            if (this.availableModels.length <= 10) return;
            const el = \$('#selectedModel');
            if (!el) return;
            const config = {
              plugins: ['dropdown_input'],
              valueField: 'value',
              labelField: 'label',
              searchField: ['label', 'value'],
              options: this.availableModels,
              items: [this.selectedModel],
              create: false,
              maxOptions: 100,
              maxItems: 1,
              render: {
                option: (data, escape) => {
                  return (
                    '<div>' +
                    '<span class="title">' +
                    escape(data.label) +
                    '</span>' +
                    '</div>'
                  );
                },
                item: (data, escape) => {
                  return '<div>' + escape(data.label) + '</div>';
                },
                no_results: (data, escape) => {
                  return '<div class="no-results" style="padding: 0.75em; text-align: center; color: #999;">查无此项</div>';
                }
              },
              onChange: value => {
                this.selectedModel = value;
                this.saveData();
              },
              onDelete: () => false,
              onInitialize: () => {
                const input = \$('.dropdown-input-wrap input');
                if (!input) return;
                input.style.paddingLeft = '12px';
                input.style.paddingRight = '12px';
                input.setAttribute('placeholder', '模型关键词');
              }
            };
            const tomSelect = new TomSelect(el, config);
            this.tomSelect = tomSelect;
            document.body.ontouchmove = e => {
              const isInDropdown = e.target.closest('.ts-dropdown');
              const isDropdownOpen = tomSelect.isOpen;
              if (isDropdownOpen && !isInDropdown) {
                tomSelect.close();
              }
            };
          },
          initModels() {
            const firstItem = this.availableModels[0];
            if (typeof firstItem === 'string') {
              this.availableModels = firstItem
                .trim()
                .split(',')
                .map(id => id.trim())
                .filter(id => id)
                .map(id => {
                  if (id.includes('=')) {
                    const [value, label] = id.split('=').map(s => s.trim());
                    return { value, label };
                  }
                  const parts = id.split('-');
                  parts.forEach((part, index) => {
                    if (part.includes('/')) {
                      const idx = part.indexOf('/');
                      part =
                        part.slice(0, idx + 1) +
                        (part.charAt(idx + 1) || '').toUpperCase() +
                        part.slice(idx + 2);
                    }
                    parts[index] = part.charAt(0).toUpperCase() + part.slice(1);
                  });
                  let label = parts.join(' ');
                  label = label
                    .replace(' Vl ', ' VL ')
                    .replace('Deepseek', 'DeepSeek')
                    .replace('Maxthinking', 'MaxThinking')
                    .replace('Glm', 'GLM')
                    .replace('Gpt', 'GPT')
                    .replace(' Cc', ' CC')
                    .replace('Or/', 'OR/')
                    .replace('Cs/', 'CS/')
                    .replace('Iflow/', 'iFlow/')
                    .replace('Gcli', 'gCLI')
                    .replace('Cpa/', 'CPA/')
                    .replace('B4u/', 'B4U/')
                    .replace('Kfc/', 'KFC/')
                    .replace('/', ' / ');
                  return {
                    value: id,
                    label: label
                  };
                });
            }
          },
          reloadPage() {
            location.reload();
          },
          // 备用的花括号解析方法，用于处理特殊情况
          parseWithBraceMethod(inputBuffer) {
            let buffer = inputBuffer;
            let braceCount = 0;
            let startIndex = -1;
            let processed = false;

            for (let i = 0; i < buffer.length; i++) {
              if (buffer[i] === '{') {
                if (braceCount === 0) {
                  startIndex = i;
                }
                braceCount++;
              } else if (buffer[i] === '}') {
                braceCount--;
                if (braceCount === 0 && startIndex !== -1) {
                  // 找到完整的JSON对象
                  const jsonStr = buffer.substring(startIndex, i + 1);

                  try {
                    const data = JSON.parse(jsonStr);

                    if (
                      data.candidates &&
                      data.candidates[0] &&
                      data.candidates[0].content
                    ) {
                      const content = data.candidates[0].content;
                      const delta =
                        (content &&
                          content.parts[0] &&
                          content.parts[0].text) ||
                        '';
                      if (delta) {
                        const shouldScroll = !this.streamingContent;
                        this.streamingContent += delta;
                        if (shouldScroll) {
                          this.scrollToBottom();
                        }
                      }
                      processed = true;
                    }
                  } catch (parseError) {
                    console.warn(
                      '花括号解析方法也失败:',
                      parseError,
                      'JSON:',
                      jsonStr
                    );
                  }

                  // 移除已处理的部分
                  buffer = buffer.substring(i + 1);
                  i = -1; // 重置循环
                  startIndex = -1;
                  braceCount = 0;
                }
              }
            }

            return { buffer, processed };
          },

          sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
          },

          // 数据迁移：将旧格式(question/answer/question2/answer2)转换为新的messages数组格式
          migrateSessionData(sessions) {
            if (!sessions || !Array.isArray(sessions)) return sessions;
            let migrated = false;
            sessions.forEach(session => {
              // 如果已经有messages数组，跳过
              if (session.messages && Array.isArray(session.messages)) return;
              // 初始化messages数组
              session.messages = [];
              // 迁移第一轮问答
              if (session.question) {
                session.messages.push({
                  type: 'user',
                  content: session.question,
                  images: session.images || [],
                  time: session.createdAt || '',
                  model: session.model || ''
                });
                migrated = true;
              }
              if (session.answer) {
                session.messages.push({
                  type: 'bot',
                  content: session.answer,
                  time: session.createdAt || '',
                  model: session.model || ''
                });
                migrated = true;
              }
              // 迁移第二轮问答
              if (session.question2) {
                session.messages.push({
                  type: 'user',
                  content: session.question2,
                  images: session.images2 || [],
                  time: session.createdAt2 || '',
                  model: session.model2 || ''
                });
                migrated = true;
              }
              if (session.answer2) {
                session.messages.push({
                  type: 'bot',
                  content: session.answer2,
                  time: session.createdAt2 || '',
                  model: session.model2 || ''
                });
                migrated = true;
              }
              // 删除旧属性
              delete session.question;
              delete session.answer;
              delete session.question2;
              delete session.answer2;
              delete session.images;
              delete session.images2;
              delete session.createdAt;
              delete session.createdAt2;
              delete session.model;
              delete session.model2;
            });
            if (migrated) {
              console.log(
                '[Migration] Sessions migrated to new messages format'
              );
              return sessions;
            } else {
              return false;
            }
          },

          async loadData() {
            // 加载 API Key
            this.apiKey =
              (await window.openaiDB.getItem('openai_api_key')) || '';

            // 加载全局角色设定
            this.globalRolePrompt =
              (await window.openaiDB.getItem('openai_global_role_prompt')) ||
              '';
            this.globalRolePromptEnabled =
              (await window.openaiDB.getItem(
                'openai_global_role_prompt_enabled'
              )) !== false;

            // 加载当前会话ID
            const savedCurrentId = await window.openaiDB.getItem(
              'openai_current_session'
            );

            // 加载选中的模型
            const savedModel = await window.openaiDB.getItem(
              'openai_selected_model'
            );
            // 验证 savedModel 是否在可用模型列表中
            let modelToUse = '';
            // 优先级1: 使用保存的模型（如果在列表中）
            if (
              savedModel &&
              this.availableModels.length > 0 &&
              this.availableModels.some(m => m.value === savedModel)
            ) {
              modelToUse = savedModel;
            }
            // 优先级2: 如果没有保存的模型或不在列表中，使用列表第一个
            else if (
              this.availableModels.length > 0 &&
              this.availableModels[0] &&
              this.availableModels[0].value
            ) {
              modelToUse = this.availableModels[0].value;
            }
            // 优先级3: 完全没办法，使用硬编码兜底（但记录警告）
            else {
              console.warn('[Model] 模型列表未正确初始化，使用兜底值');
              modelToUse = 'gpt-4o-mini';
            }
            this.selectedModel = modelToUse;

            // 加载联网搜索开关状态
            this.needSearch = !!(await window.openaiDB.getItem(
              'openai_enable_search'
            ));

            // 加载会话数据
            const savedSessions =
              await window.openaiDB.getItem('openai_sessions');
            if (savedSessions) {
              let parsed = JSON.parse(savedSessions);
              // 执行数据迁移
              const migratedSessions = this.migrateSessionData(parsed);
              if (migratedSessions) {
                this.sessions = migratedSessions;
                // 迁移后保存
                this.sleep(300).then(() => {
                  this.saveData();
                });
              } else {
                this.sessions = parsed;
              }
            }

            // 设置当前会话ID
            if (
              savedCurrentId &&
              this.sessions.find(s => s.id === savedCurrentId)
            ) {
              this.currentSessionId = savedCurrentId;
            } else if (this.sessions.length > 0) {
              this.currentSessionId = this.sessions[0].id;
            }
            this.autoFoldRolePrompt();
            this.loadDraftFromCurrentSession(); // 加载当前会话的草稿

            // 首次向用户询问 API Key
            if (!this.apiKey && this.isTotallyBlank) {
              this.askApiKeyIfNeeded();
            }
          },

          async saveData() {
            await window.openaiDB.setItem(
              'openai_sessions',
              JSON.stringify(this.sessions)
            );
            await window.openaiDB.setItem(
              'openai_current_session',
              this.currentSessionId
            );
            await window.openaiDB.setItem(
              'openai_selected_model',
              this.selectedModel
            );
            await window.openaiDB.setItem(
              'openai_enable_search',
              this.needSearch
            );
          },

          async saveApiKey() {
            await window.openaiDB.setItem('openai_api_key', this.apiKey);
          },

          askApiKeyIfNeeded() {
            if (this.apiKey) return;
            this.showSwal({
              title: '请输入 API Key',
              input: 'password',
              inputPlaceholder: '请输入您的 OpenAI API Key',
              showCancelButton: true,
              confirmButtonText: '保存',
              cancelButtonText: '取消',
              reverseButtons: true,
              preConfirm: value => {
                if (!value) {
                  Swal.showValidationMessage('API Key 不能为空');
                  return false;
                }
                this.apiKey = value;
                this.saveApiKey();
              }
            });
          },

          createNewSession() {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            // 保存当前会话的草稿
            this.saveDraftToCurrentSession();
            const firstSession = this.sessions[0];
            // 检查第一个会话是否为空（没有消息）
            var isFirstEmpty =
              firstSession &&
              (!firstSession.messages || firstSession.messages.length === 0);
            if (isFirstEmpty) {
              this.currentSessionId = firstSession.id;
            } else {
              var newSession = {
                id: Date.now().toString(),
                title: '新会话',
                summary: '',
                role: '',
                draft: '',
                messages: [] // 使用消息数组代替固定属性
              };
              this.sessions.unshift(newSession);
              this.currentSessionId = newSession.id;
            }
            // 加载新会话的草稿
            this.loadDraftFromCurrentSession();
            this.saveData();
            // 移动端创建新会话后隐藏侧边栏
            if (this.isMobile) {
              this.hideSidebar();
            }
          },

          switchSession(sessionId) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            // 保存当前会话的草稿
            this.saveDraftToCurrentSession();
            this.currentSessionId = sessionId;
            // 加载新会话的草稿
            this.loadDraftFromCurrentSession();
            this.saveData();
            // 移动端切换会话后隐藏侧边栏
            if (this.isMobile) {
              this.hideSidebar();
            }
            this.scrollToTop();
          },

          deleteSession(sessionId) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            const doDelete = () => {
              this.sessions = this.sessions.filter(s => s.id !== sessionId);
              if (this.currentSessionId === sessionId) {
                this.currentSessionId =
                  this.sessions.length > 0 ? this.sessions[0].id : null;
              }
              if (this.sessions.length === 0) {
                this.createNewSession();
              }
              this.loadDraftFromCurrentSession();
              this.saveData();
            };
            // 如果是空会话, 直接删除
            const session = this.sessions.find(s => s.id === sessionId);
            if (!session) return;
            const isEmpty =
              (!session.messages || session.messages.length === 0) &&
              !session.draft;
            if (isEmpty) {
              doDelete();
              return;
            }
            this.showSwal(
              {
                title: '确认删除',
                text: '您确定要删除这个会话吗？',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#d33',
                confirmButtonText: '删除',
                cancelButtonText: '取消',
                reverseButtons: true
              },
              false
            ).then(result => {
              if (result.isConfirmed) {
                doDelete();
              }
            });
          },

          // 获取会话中用户消息的数量
          getUserMessageCount(session) {
            if (!session || !session.messages) return 0;
            return session.messages.filter(m => m.type === 'user').length;
          },

          updateRolePrompt() {
            this.saveData();
          },

          async updateGlobalRolePrompt() {
            if (!this.globalRolePrompt && !this.globalRolePromptEnabled) {
              this.globalRolePromptEnabled = true;
              return;
            }
            await window.openaiDB.setItem(
              'openai_global_role_prompt',
              this.globalRolePrompt
            );
            await window.openaiDB.setItem(
              'openai_global_role_prompt_enabled',
              this.globalRolePromptEnabled
            );
          },

          getRolePrompt() {
            if (this.globalRolePromptEnabled) {
              return this.globalRolePrompt.trim();
            }
            return '';
          },

          clearRolePrompt() {
            this.globalRolePrompt = '';
            this.globalRolePromptEnabled = true;
            this.updateGlobalRolePrompt();
          },

          toggleRolePrompt() {
            this.globalRolePromptEnabled = !this.globalRolePromptEnabled;
            this.updateGlobalRolePrompt();
          },

          // 触发上传（图片或文本文件）
          triggerUpload() {
            this.showSwal({
              title: '选择上传类型',
              showCancelButton: true,
              showDenyButton: true,
              confirmButtonText: '📷 图片',
              denyButtonText: '📄 文本文件',
              cancelButtonText: '取消',
              confirmButtonColor: '#5fbdbd',
              denyButtonColor: '#9b8ed4',
              reverseButtons: false
            }).then(result => {
              if (result.isConfirmed) {
                this.triggerImageUpload();
              } else if (result.isDenied) {
                this.triggerPlaintextUpload();
              }
            });
          },

          // 触发图片上传
          triggerImageUpload() {
            if (this.uploadedImages.length >= 5) {
              this.showSwal({
                title: '无法上传',
                text: '最多只能上传5张图片',
                icon: 'warning',
                confirmButtonText: '确定'
              });
              return;
            }
            this.preheatImageUploadService();
            this.\$refs.imageInput.click();
          },

          // 触发文本文件上传
          triggerPlaintextUpload() {
            if (this.uploadedPlaintexts.length >= 5) {
              this.showSwal({
                title: '无法上传',
                text: '最多只能上传5个文本文件',
                icon: 'warning',
                confirmButtonText: '确定'
              });
              return;
            }
            this.\$refs.plaintextInput.click();
          },

          // 获取支持的文本文件后缀列表
          getSupportedTextExtensions() {
            return [
              '.txt',
              '.md',
              '.markdown',
              '.html',
              '.htm',
              '.xml',
              '.json',
              '.js',
              '.jsx',
              '.ts',
              '.tsx',
              '.vue',
              '.svelte',
              '.css',
              '.scss',
              '.sass',
              '.less',
              '.styl',
              '.py',
              '.pyw',
              '.pyi',
              '.rb',
              '.php',
              '.java',
              '.kt',
              '.kts',
              '.c',
              '.cpp',
              '.cc',
              '.cxx',
              '.h',
              '.hpp',
              '.hxx',
              '.cs',
              '.go',
              '.rs',
              '.swift',
              '.m',
              '.mm',
              '.sh',
              '.bash',
              '.zsh',
              '.fish',
              '.ps1',
              '.bat',
              '.cmd',
              '.sql',
              '.graphql',
              '.gql',
              '.yaml',
              '.yml',
              '.toml',
              '.ini',
              '.conf',
              '.cfg',
              '.env',
              '.log',
              '.csv',
              '.tsv',
              '.tex',
              '.bib',
              '.rst',
              '.adoc',
              '.org',
              '.gitignore',
              '.dockerignore',
              '.editorconfig',
              '.eslintrc',
              '.prettierrc',
              '.babelrc',
              '.htaccess',
              '.nginx',
              '.conf',
              '.r',
              '.R',
              '.rmd',
              '.Rmd',
              '.lua',
              '.pl',
              '.pm',
              '.tcl',
              '.awk',
              '.sed',
              '.vim',
              '.vimrc',
              '.emacs',
              '.el',
              '.proto',
              '.thrift',
              '.avsc',
              '.tf',
              '.tfvars',
              '.hcl',
              '.gradle',
              '.properties',
              '.pom',
              '.cmake',
              '.make',
              '.makefile',
              '.mk',
              '.asm',
              '.s',
              '.nasm',
              '.patch',
              '.diff'
            ];
          },

          // 处理文本文件选择
          async handlePlaintextSelect(event) {
            var file = event.target.files[0];
            if (!file) return;
            await this.processPlaintextFile(file);
            event.target.value = ''; // 清空input,允许重复选择同一文件
          },

          // 处理文本文件（公共逻辑）
          async processPlaintextFile(file) {
            // 检查文件数量限制
            if (this.uploadedPlaintexts.length >= 5) {
              this.showSwal({
                title: '无法上传',
                text: '最多只能上传5个文本文件',
                icon: 'warning',
                confirmButtonText: '确定'
              });
              return;
            }

            // 检查文件后缀
            var fileName = file.name || '';
            var ext =
              fileName.lastIndexOf('.') > -1
                ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
                : '';
            var supportedExts = this.getSupportedTextExtensions();
            // 如果有后缀但不在支持列表中，提示用户
            if (ext && supportedExts.indexOf(ext) === -1) {
              this.showSwal({
                title: '不支持的文件类型',
                text: '请选择文本文件，如 .txt, .md, .js, .py 等',
                icon: 'error',
                confirmButtonText: '确定'
              });
              return;
            }

            // 检查文件大小 (限制1MB)
            if (file.size > 1 * 1024 * 1024) {
              this.showSwal({
                title: '文件过大',
                text: '文本文件大小不能超过1MB',
                icon: 'error',
                confirmButtonText: '确定'
              });
              return;
            }

            // 检查是否已经上传过同名文件
            var isDuplicate = this.uploadedPlaintexts.some(
              item => item.name === fileName
            );
            if (isDuplicate) {
              this.showSwal({
                title: '文件已存在',
                text: '已经上传过同名文件: ' + fileName,
                icon: 'warning',
                confirmButtonText: '确定'
              });
              return;
            }

            // 读取文件内容
            try {
              var content = await this.readFileAsText(file);
              this.uploadedPlaintexts.push({
                name: fileName,
                content: content
              });
            } catch (error) {
              console.error('读取文件失败:', error);
              this.showSwal({
                title: '读取失败',
                text: '无法读取文件内容，请确保是有效的文本文件',
                icon: 'error',
                confirmButtonText: '确定'
              });
            }
          },

          // 读取文件为文本
          readFileAsText(file) {
            return new Promise((resolve, reject) => {
              var reader = new FileReader();
              reader.onload = () => {
                resolve(reader.result);
              };
              reader.onerror = () => {
                reject(reader.error);
              };
              reader.readAsText(file, 'UTF-8');
            });
          },

          // 移除文本文件
          removePlaintext(index) {
            this.uploadedPlaintexts.splice(index, 1);
          },

          // 清空上传的文本文件
          clearUploadedPlaintexts() {
            this.uploadedPlaintexts = [];
          },

          // 预览文本文件内容
          previewPlaintext(item) {
            var content = item.content || '';
            // 截取前3000字符预览
            var previewContent =
              content.length > 3000
                ? content.substring(0, 3000) + '\\n\\n... (内容过长，已截断)'
                : content;
            this.showSwal({
              title: item.name,
              html:
                '<pre style="text-align: left; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-wrap: break-word; background: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 13px;">' +
                this.escapeHtml(previewContent) +
                '</pre>',
              width: this.isMobile ? '95%' : '700px',
              showConfirmButton: true,
              confirmButtonText: '关闭'
            });
          },

          // HTML转义
          escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          },

          // 构建附件内容字符串
          buildAttachmentContent(plaintexts) {
            if (!plaintexts || plaintexts.length === 0) return '';
            var lines = [];
            lines.push(
              '\\n\\n---\\n\\n## 附件\\n\\n**以下是用户提供的附件内容，以 \\\`<User_Attachment_数字>\\\` 包裹：**'
            );
            for (var i = 0; i < plaintexts.length; i++) {
              var item = plaintexts[i];
              var num = i + 1;
              lines.push('\\n\\n---\\n\\n### 附件 ' + num + ':\\n\\n');
              lines.push(
                '<User_Attachment_' + num + ' filename="' + item.name + '">'
              );
              lines.push(item.content);
              lines.push('</User_Attachment_' + num + '>');
            }
            return lines.join('\\n');
          },

          // 预先调用上传图片服务的/health接口,以减少首次上传延迟
          async preheatImageUploadService() {
            if (!this.isMySite) return;
            return fetch('https://pic.keyi.ma/health')
              .then(() => {})
              .catch(() => {});
          },

          // 处理粘贴事件
          async handlePaste(event) {
            var clipboardData = event.clipboardData || window.clipboardData;
            if (!clipboardData) return;
            var items = clipboardData.items;
            if (!items || !items.length) return;

            // 遍历剪贴板项目
            for (var i = 0; i < items.length; i++) {
              var item = items[i];

              // 检查是否为图片类型
              if (item.type.startsWith('image/')) {
                event.preventDefault(); // 阻止默认粘贴行为

                // 检查是否已达到上传限制
                if (this.uploadedImages.length >= 5) {
                  this.showSwal({
                    title: '无法上传',
                    text: '最多只能上传5张图片',
                    icon: 'warning',
                    confirmButtonText: '确定'
                  });
                  return;
                }

                // 获取图片文件
                var file = item.getAsFile();
                if (!file) continue;

                // 检查文件大小 (限制10MB)
                if (file.size > 10 * 1024 * 1024) {
                  this.showSwal({
                    title: '文件过大',
                    text: '图片大小不能超过10MB',
                    icon: 'error',
                    confirmButtonText: '确定'
                  });
                  return;
                }

                if (i === 0) {
                  await this.preheatImageUploadService();
                }
                // 上传图片
                await this.uploadImageFile(file);
                return; // 只处理第一张图片
              }

              // 检查是否为文本文件类型
              if (
                item.kind === 'file' &&
                (item.type.startsWith('text/') ||
                  item.type === 'application/json' ||
                  item.type === 'application/javascript' ||
                  item.type === 'application/xml' ||
                  item.type === '')
              ) {
                var textFile = item.getAsFile();
                if (!textFile) continue;

                // 检查文件名后缀是否支持
                var fileName = textFile.name || '';
                var ext =
                  fileName.lastIndexOf('.') > -1
                    ? fileName
                        .substring(fileName.lastIndexOf('.'))
                        .toLowerCase()
                    : '';
                var supportedExts = this.getSupportedTextExtensions();

                // 如果有后缀且在支持列表中，处理文本文件
                if (ext && supportedExts.indexOf(ext) !== -1) {
                  event.preventDefault();
                  await this.processPlaintextFile(textFile);
                  return;
                }
              }
            }
          },

          // 上传图片文件（提取公共逻辑）
          async uploadImageFile(file) {
            this.isUploadingImage = true;
            try {
              // 如果当前模型支持图片上传,则上传到图床
              if (this.canUploadImage) {
                const formData = new FormData();
                formData.append('image', file);

                // 创建超时 Promise
                const timeoutPromise = new Promise((_, reject) => {
                  setTimeout(
                    () => reject(new Error('上传超时（15秒）')),
                    15000
                  );
                });

                // 创建上传图床 Promise
                const uploadPromise = fetch('https://pic.keyi.ma/upload', {
                  method: 'POST',
                  body: formData
                });

                // 使用 Promise.race 实现超时控制
                const response = await Promise.race([
                  uploadPromise,
                  timeoutPromise
                ]);

                if (!response.ok) {
                  throw new Error('上传失败: ' + response.statusText);
                }

                const data = await response.json();

                if (data.success && data.url) {
                  this.uploadedImages.push({
                    url: data.url,
                    file: file
                  });
                } else {
                  throw new Error('上传失败: 返回数据格式错误');
                }
              } else {
                // 不支持图片URL的模型,只保存file对象,发送时再转base64
                this.uploadedImages.push({
                  file: file
                });
              }
            } catch (error) {
              console.error('上传图片失败:', error);
              this.showSwal({
                title: '上传失败',
                text: error.message,
                icon: 'error',
                confirmButtonText: '确定'
              });
            } finally {
              this.isUploadingImage = false;
            }
          },

          // 处理图片选择
          async handleImageSelect(event) {
            const file = event.target.files[0];
            if (!file) return;

            // 检查文件类型
            if (!file.type.startsWith('image/')) {
              this.showSwal({
                title: '文件类型错误',
                text: '请选择图片文件',
                icon: 'error',
                confirmButtonText: '确定'
              });
              event.target.value = '';
              return;
            }

            // 检查文件大小 (限制10MB)
            if (file.size > 10 * 1024 * 1024) {
              this.showSwal({
                title: '文件过大',
                text: '图片大小不能超过10MB',
                icon: 'error',
                confirmButtonText: '确定'
              });
              event.target.value = '';
              return;
            }

            // 上传图片
            await this.uploadImageFile(file);
            event.target.value = ''; // 清空input,允许重复选择同一文件
          },

          // 移除图片
          removeImage(index) {
            this.uploadedImages.splice(index, 1);
          },

          // 清空上传的图片
          clearUploadedImages() {
            this.uploadedImages = [];
          },

          // 预览图片
          previewImage(imageUrl) {
            // 如果是INVALID标记,不支持预览
            if (imageUrl === 'INVALID') return;
            this.showSwal({
              imageUrl: imageUrl,
              imageAlt: '图片预览',
              showCloseButton: true,
              showConfirmButton: false,
              width: 'auto',
              customClass: {
                image: 'swal-image-preview'
              }
            });
          },

          // 获取图片的显示URL(用于标签显示)
          getImageDisplayUrl(img) {
            if (img.url) {
              return img.url;
            } else if (img.file) {
              return URL.createObjectURL(img.file);
            }
            return '';
          },

          // 将File对象转为base64
          fileToBase64(file) {
            return new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
          },

          formatTimeStr(time) {
            let str = new Date(time).toLocaleString();
            str = str.replace(/:\\d{1,2}\$/, '');
            return str;
          },

          checkMobile() {
            const isUaMobile = navigator.userAgent
              .toLowerCase()
              .includes('mobile');
            const isSizeMobile = window.innerWidth <= 768;
            this.isMobile = isUaMobile || isSizeMobile;
            if (this.isMobile) {
              document.body.className = 'mobile';
              this.toggleWideMode(false);
              return true;
            } else {
              document.body.className = 'pc';
              return false;
            }
          },

          toggleSidebar() {
            if (this.isLoading || this.isStreaming) return;
            this.showSidebar = !this.showSidebar;

            // 移动端优化：显示侧边栏时添加hash，隐藏时移除hash
            if (this.isMobile) {
              if (this.showSidebar) {
                this.addHash('sidebar');
                this.sidebarHashAdded = true;
              } else {
                if (this.sidebarHashAdded) {
                  this.removeHash();
                  this.sidebarHashAdded = false;
                }
              }
            }
          },

          hideSidebar() {
            this.showSidebar = false;
            // 移动端优化：隐藏侧边栏时移除hash
            if (this.isMobile && this.sidebarHashAdded) {
              this.removeHash();
              this.sidebarHashAdded = false;
            }
          },

          cancelStreaming() {
            if (this.abortController) {
              this.abortController.abort();
              this.abortController = undefined;
            }
            this.isStreaming = false;
            this.isLoading = false;
            var session = this.currentSession;
            // 将流式内容保存为最新的 bot 消息
            if (this.streamingContent && session && session.messages) {
              session.messages.push({
                type: 'bot',
                content: this.streamingContent,
                time: new Date().toISOString(),
                model: this.selectedModel
              });
            }
            this.saveData();
            this.streamingContent = '';
          },

          renderMarkdown(text) {
            if (!text) return '';

            // 使用 marked 解析 Markdown
            let html = marked.parse(text);

            return html;
          },

          copyToClipboard(text) {
            const regexRel = /\\[(\\d+)\\]\\(javascript:void\\(0\\)\\)/g;
            text = text.replace(regexRel, '\$1');
            // 将 <details class="thinking" ... 直至</detail>的内容移除
            const regexThinking =
              /<details class="thinking"[\\s\\S]*?<\\/details>/g;
            text = text.replace(regexThinking, '');
            text = text.trim();
            navigator.clipboard
              .writeText(text)
              .then(() => {
                this.showSwal({
                  title: '复制成功',
                  text: '内容已复制到剪贴板',
                  icon: 'success',
                  timer: 1500,
                  showConfirmButton: false
                });
              })
              .catch(() => {
                this.showSwal({
                  title: '复制失败',
                  text: '请手动复制内容',
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              });
          },

          answerClickHandler(e) {
            const target = e.target;
            if (target.tagName !== 'A') return;
            if (target.href === 'javascript:void(0)') {
              e.preventDefault();
            }
            const blockquote = target.closest('blockquote');
            const isClickingSearchRes =
              blockquote && blockquote.innerText.startsWith('联网搜索：');
            if (!isClickingSearchRes) return;
            const idx = Array.from(blockquote.querySelectorAll('a')).indexOf(
              target
            );
            const matches = blockquote.innerText.match(
              new RegExp('「(.*?)」', 'g')
            );
            let query = matches && matches[idx];
            if (!query) return;
            query = query.replace(/「|」/g, '').trim();
            this.showSearchRes(query);
          },

          // 展示搜索结果
          async showSearchRes(query) {
            const searchRes = this.getSearchRes(query);
            if (!searchRes) {
              this.searchRes = null;
              return;
            } else {
              this.searchRes = searchRes;
            }
            await this.\$nextTick();
            const template = this.\$refs.searchResTemplate;
            if (!template) return;
            const htmlContent = template.innerHTML;
            // 显示弹窗
            this.showSwal({
              title: '联网搜索详情',
              html: htmlContent,
              width: this.isMobile ? '95%' : '800px',
              showConfirmButton: true,
              confirmButtonText: '&nbsp;关闭&nbsp;',
              showCancelButton: false,
              reverseButtons: true,
              customClass: {
                popup: 'search-results-popup',
                htmlContainer: 'search-results-content'
              }
            });
          },

          async shareSession() {
            const sessionContent = \$('.session-content');
            if (!sessionContent) {
              this.showSwal({
                title: '截图失败',
                text: '未找到要截图的内容',
                icon: 'error',
                confirmButtonText: '确定'
              });
              return;
            }
            this.isCapturing = true;
            await this.\$nextTick();

            // 显示加载提示
            this.showSwal({
              title: '正在生成截图...',
              allowOutsideClick: false,
              didOpen: () => {
                Swal.showLoading();
              }
            });

            // 使用html2canvas截图
            html2canvas(sessionContent, {
              backgroundColor: '#ffffff',
              scale: window.devicePixelRatio || 1,
              useCORS: true,
              allowTaint: false,
              logging: false,
              height: null,
              width: null
            })
              .then(canvas => {
                // 检测是否为微信浏览器环境
                const userAgent = navigator.userAgent.toLowerCase();
                const isWechat =
                  userAgent.includes('micromessenger') &&
                  userAgent.includes('mobile');
                const isMobile = this.isMobile;
                const imageDataUrl = canvas.toDataURL('image/png');
                this.showSwal({
                  title: isMobile ? '长按保存图片' : '右键复制图片',
                  html:
                    '<div style="max-height: 70vh; overflow-y: auto;"><img src="' +
                    imageDataUrl +
                    '" style="max-width: 100%; height: auto; border-radius: 8px;" /></div>',
                  showConfirmButton: true,
                  confirmButtonText: '&nbsp;下载&nbsp;',
                  showCancelButton: true,
                  cancelButtonText: '&nbsp;关闭&nbsp;',
                  width: isMobile ? '95%' : 'auto',
                  padding: '0.25em 0 1em',
                  customClass: {
                    htmlContainer: 'swal-image-container'
                  }
                }).then(result => {
                  // 如果点击了确认按钮（显示为"下载"）
                  if (result.isConfirmed) {
                    const link = document.createElement('a');
                    const regex = new RegExp('[\\/\\: ]', 'g');
                    link.download =
                      'openai-chat-' +
                      new Date().toLocaleString().replace(regex, '-') +
                      '.png';
                    link.href = imageDataUrl;

                    // 触发下载
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    // 显示下载成功提示
                    this.showSwal({
                      title: '下载成功',
                      text: '图片已保存到下载文件夹',
                      icon: 'success',
                      timer: 2000,
                      showConfirmButton: false
                    });
                  }
                });
              })
              .catch(error => {
                console.error('截图失败:', error);
                this.showSwal({
                  title: '截图失败',
                  text: '生成图片时出现错误: ' + error.message,
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              })
              .finally(() => {
                this.isCapturing = false;
              });
          },

          updateSessionTitle() {
            var session = this.currentSession;
            if (session && session.messages && session.messages.length > 0) {
              var firstUserMsg = session.messages.find(m => m.type === 'user');
              if (firstUserMsg && firstUserMsg.content) {
                var text = firstUserMsg.content;
                session.title =
                  text.slice(0, 30) + (text.length > 30 ? '...' : '');
              }
            }
          },

          getModelName(value) {
            const model = this.availableModels.find(i => i.value === value);
            if (model) {
              return model.label;
            } else {
              return value;
            }
          },

          // 获取消息标签（问题/追问）
          getMsgLabel(msg, msgIndex) {
            if (msg.type !== 'user') return '回答';
            var session = this.currentSession;
            if (!session || !session.messages) return '问题';
            // 计算这是第几个用户消息
            var userMsgIdx = 0;
            for (var i = 0; i <= msgIndex; i++) {
              if (session.messages[i].type === 'user') userMsgIdx++;
            }
            return userMsgIdx === 1 ? '问题' : '追问';
          },

          // 判断是否可以编辑该消息
          canEditMessage(msgIndex) {
            if (this.isLoading || this.isStreaming) return false;
            var session = this.currentSession;
            if (!session || !session.messages) return false;
            var msg = session.messages[msgIndex];
            if (msg.type !== 'user') return false;
            // 只有最后一条用户消息可以编辑
            for (var i = msgIndex + 1; i < session.messages.length; i++) {
              if (session.messages[i].type === 'user') return false;
            }
            return true;
          },

          // 判断是否可以重新生成该回答
          canRegenerateMessage(msgIndex) {
            if (this.isLoading || this.isStreaming) return false;
            var session = this.currentSession;
            if (!session || !session.messages) return false;
            var msg = session.messages[msgIndex];
            if (msg.type !== 'bot') return false;
            // 只有最后一条bot消息可以重新生成
            return msgIndex === session.messages.length - 1;
          },

          // 判断是否是最后一条bot消息
          isLastBotMsg(msgIndex) {
            var session = this.currentSession;
            if (!session || !session.messages) return false;
            var msg = session.messages[msgIndex];
            if (msg.type !== 'bot') return false;
            // 检查后面是否还有bot消息
            for (var i = msgIndex + 1; i < session.messages.length; i++) {
              if (session.messages[i].type === 'bot') return false;
            }
            return true;
          },

          // 判断是否可以分叉该消息（只有非最新的bot消息可以分叉）
          canForkMessage(msgIndex) {
            if (this.isLoading || this.isStreaming) return false;
            var session = this.currentSession;
            if (!session || !session.messages) return false;
            var msg = session.messages[msgIndex];
            if (msg.type !== 'bot') return false;
            // 不是最后一条bot消息才可以分叉
            return !this.isLastBotMsg(msgIndex);
          },

          // 获取bot消息应该显示的内容（处理流式回答的显示逻辑）
          getBotMessageContent(msg, msgIndex) {
            // 如果是最后一条bot消息 且 正在加载/流式传输 且 不是为新消息生成回复
            // 则显示流式内容，否则显示原消息内容
            if (
              this.isLastBotMsg(msgIndex) &&
              (this.isLoading || this.isStreaming) &&
              !this.isStreamingNewAnswer
            ) {
              return this.streamingContent;
            }
            return msg.content;
          },

          async sendMessage() {
            if (
              (!this.messageInput.trim() &&
                this.uploadedImages.length === 0 &&
                this.uploadedPlaintexts.length === 0) ||
              !this.apiKey
            )
              return;
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;

            // 如果已达到最大消息数限制，创建新会话
            if (this.isMaxMessagesReached) {
              this.createNewSession();
              return;
            }

            this.errorMessage = '';
            var userMessage = this.messageInput.trim();

            // 处理图片:如果不支持URL,转为base64;否则使用URL
            var userImages = [];
            var userImagesForSending = []; // 用于发送API的图片数组
            for (var imgI = 0; imgI < this.uploadedImages.length; imgI++) {
              var imgItem = this.uploadedImages[imgI];
              if (imgItem.url) {
                // 有URL,使用URL
                userImages.push(imgItem.url);
                userImagesForSending.push(imgItem.url);
              } else if (imgItem.file) {
                // 没有URL,需要转base64发送,但session中保存INVALID
                userImages.push('INVALID');
                var base64 = await this.fileToBase64(imgItem.file);
                userImagesForSending.push(base64);
              }
            }

            // 处理文本附件
            var userPlaintexts = [];
            for (var txtI = 0; txtI < this.uploadedPlaintexts.length; txtI++) {
              userPlaintexts.push({
                name: this.uploadedPlaintexts[txtI].name,
                content: this.uploadedPlaintexts[txtI].content
              });
            }

            this.clearInput();
            this.clearUploadedImages(); // 清空上传的图片
            this.clearUploadedPlaintexts(); // 清空上传的文本文件
            // 清空当前会话的草稿
            if (this.currentSession) {
              this.currentSession.draft = '';
            }

            // 添加用户消息
            if (!this.currentSession) {
              this.createNewSession();
            }
            var session = this.currentSession;
            session.role = this.getRolePrompt();

            // 添加用户消息到messages数组
            var userMsgObj = {
              type: 'user',
              content: userMessage,
              images: userImages,
              plaintexts: userPlaintexts,
              time: new Date().toISOString(),
              model: this.selectedModel
            };
            session.messages.push(userMsgObj);

            // 如果是第一条消息，自动折叠角色设定
            if (session.messages.length === 1) {
              this.autoFoldRolePrompt();
            }

            this.updateSessionTitle();
            this.saveData();
            this.scrollToBottom();

            // 发送到 OpenAI API (流式)
            var apiMessages = [];
            this.isLoading = true;
            this.isStreaming = false;
            this.isSentForAWhile = false;
            this.sleep(2500).then(() => {
              this.isSentForAWhile = true;
            });
            this.streamingContent = '';
            this.abortController = new AbortController();

            // 组装messages - OpenAI格式
            if (this.getRolePrompt()) {
              var needAssistant = /claude|gpt5/i.test(this.selectedModel);
              apiMessages.push({
                role: !needAssistant ? 'system' : 'assistant',
                content: this.globalRolePrompt.trim()
              });
            }

            // 遍历messages数组构建API消息
            for (var idx = 0; idx < session.messages.length; idx++) {
              var msg = session.messages[idx];
              var isLastUserMsg =
                idx === session.messages.length - 1 && msg.type === 'user';

              if (msg.type === 'user') {
                var content = [];
                // 构建文本内容（包含附件）
                var textContent = msg.content || '';
                var plaintextsToUse = isLastUserMsg
                  ? userPlaintexts
                  : msg.plaintexts || [];
                if (plaintextsToUse && plaintextsToUse.length > 0) {
                  textContent += this.buildAttachmentContent(plaintextsToUse);
                }
                // 添加文本内容
                if (textContent && textContent.trim()) {
                  content.push({
                    type: 'text',
                    text: textContent
                  });
                }
                // 添加图片内容
                var imagesToUse = isLastUserMsg
                  ? userImagesForSending
                  : msg.images || [];
                if (imagesToUse && imagesToUse.length > 0) {
                  for (var imgIdx = 0; imgIdx < imagesToUse.length; imgIdx++) {
                    var imageUrl = imagesToUse[imgIdx];
                    if (imageUrl !== 'INVALID') {
                      content.push({
                        type: 'image_url',
                        image_url: { url: imageUrl }
                      });
                    }
                  }
                }
                apiMessages.push({
                  role: 'user',
                  content:
                    content.length === 1 && content[0].type === 'text'
                      ? content[0].text
                      : content
                });
              } else if (msg.type === 'bot') {
                apiMessages.push({
                  role: 'assistant',
                  content: msg.content
                });
              }
            }

            // 这里根据最新的问句, 调用/search接口查询语料
            var searchQueries = [];
            var searchCounts = [];
            if (this.needSearch) {
              var queryStr = userMessage;
              if (session.messages.length > 1) {
                queryStr +=
                  '\\n\\n当前会话摘要："' + (session.summary || '') + '"';
              }
              var searchResList = await fetch('/search', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + this.apiKey
                },
                body: JSON.stringify({ query: queryStr })
              })
                .then(res => res.json())
                .catch(() => []);
              var hasResult =
                searchResList &&
                searchResList.length &&
                searchResList.some(
                  item => item.results && item.results.length > 0
                ) &&
                JSON.stringify(searchResList).length > 50;
              if (hasResult) {
                searchResList = searchResList.filter(r => {
                  return r.results && r.results.length > 0;
                });
                searchResList.forEach(r => {
                  this.saveSearchRes(r);
                });
                searchResList.forEach(searchRes => {
                  searchRes.results = searchRes.results.map(item => {
                    const rest = {};
                    for (var k in item) {
                      if (k !== 'url' && k !== 'score' && k !== 'raw_content') {
                        rest[k] = item[k];
                      }
                    }
                    return rest;
                  });
                });
                searchQueries = searchResList.map(r => r.query);
                searchCounts = searchResList.map(
                  r => (r.results && r.results.length) || 0
                );
                apiMessages.push({
                  role: 'assistant',
                  content:
                    'AI模型通过实时调用Tavily搜索引擎，找到了以下相关信息: \\n\\n' +
                    '<Tavily_Search_Context>' +
                    JSON.stringify(searchResList) +
                    '</Tavily_Search_Context>'
                });
                apiMessages.push({
                  role: 'user',
                  content:
                    '好的。我强调一下：这不是虚构的未来时间，现在真实世界的时间是： ' +
                    new Date().toDateString() +
                    ' ' +
                    new Date().toTimeString() +
                    '，请据此推断"最近"、"今年"等时间词的具体含义。\\n你无需针对"用户澄清真实时间"这件事做出任何提及和表态，请专注于核心问题的解答。\\n\\n' +
                    '## 严格执行原则 (Critical Rules)\\n' +
                    '### 1. 事实基准 (Grounding)\\n' +
                    '*   **优先权**：搜索语料的权重 **高于** 你的内部训练知识。如果搜索结果与你的记忆冲突（特别是时效性信息），**必须**以搜索结果为准。\\n' +
                    '*   **诚实性**：如果搜索结果中没有包含回答问题所需的关键信息，请明确指出"搜索结果未提及此事"，严禁编造数据。\\n\\n' +
                    '### 2. "最大化"信息的处理\\n' +
                    '*   你收到的搜索结果可能覆盖了问题的不同维度（定义、新闻、正反观点等）。\\n' +
                    '*   **不要** 简单罗列结果。\\n' +
                    '*   **要** 进行**交叉验证**和**综合叙述**。例如：将Source A的数据与Source B的观点结合起来分析。\\n' +
                    '### 3. 格式要求\\n' +
                    '*   使用 Markdown 格式。\\n' +
                    '*   如果信息量大，**必须**使用层级标题、着重号（Bold）和列表。\\n' +
                    '*   如果涉及对比（如A vs B），尽量使用 Markdown 表格。\\n\\n' +
                    '---\\n\\n' +
                    '## 回答结构框架\\n' +
                    '1.  **直接解答 (The Bottom Line)**\\n' +
                    '    *   用一句话总结核心答案（TL;DR）。\\n' +
                    '2.  **关键发现 (Key Findings)**\\n' +
                    '    *   分点详述，整合不同维度的信息。\\n' +
                    '3.  **深度解析 (Deep Dive)** (视情况而定)\\n' +
                    '    *   解释背后的原因、背景或具体数据支撑。\\n' +
                    '4.  **来源列表 (References)**\\n' +
                    '    *   列出你实际引用的参考链接(应当是包含真实url、可通过点击跳转的Markdown超链接，例如：1. [](https://en.wikipedia.org/wiki/DeepSeek) )。\\n\\n' +
                    '---\\n\\n' +
                    '## 用户问题 (User Question)\\n' +
                    '<User_Question>\\n' +
                    queryStr +
                    '\\n' +
                    '</User_Question>\\n\\n' +
                    '现在你的任务是基于上述提供的**实时搜索结果**（Tavily_Search_Context），回答用户的原始问题。你需要像撰写深度调查报告一样，将碎片化的信息拼凑成完整的逻辑链条。'
                });
                // 显示搜索结果数量（如果有）
                if (searchQueries.length && !this.streamingContent) {
                  this.streamingContent =
                    '> 联网搜索：' +
                    searchQueries.map(q => '「' + q + '」').join('、') +
                    '\\n> \\n> AI 模型通过实时调用 Tavily 搜索引擎，找到了 ' +
                    searchCounts
                      .map(c => '[' + c + '](javascript:void(0))')
                      .join(' + ') +
                    ' 条相关信息。\\n\\n';
                }
              }
            }

            try {
              // 如果上一步search中途已经被用户主动中止,则不再继续
              if (this.abortController === undefined) return;

              var url = '/v1/chat/completions';
              var response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + this.apiKey
                },
                body: JSON.stringify({
                  model: this.selectedModel,
                  messages: apiMessages,
                  temperature: 1,
                  stream: true
                }),
                signal: this.abortController.signal
              }).catch(e => {
                throw e;
              });

              if (!response.ok) {
                var errorData = await response.json().catch(() => ({}));
                var errorMessage =
                  (errorData.error && errorData.error.message) ||
                  errorData.error;
                var errMsg =
                  errorMessage ||
                  'HTTP ' + response.status + ': ' + response.statusText;
                throw new Error(errMsg);
              }

              // 开始流式读取
              this.isLoading = false;
              this.isStreaming = true;

              var reader = response.body.getReader();
              var decoder = new TextDecoder();
              var buffer = '';
              var isInThinking = false; // 标记是否处于思考模式

              while (true) {
                var readResult = await reader.read();
                if (readResult.done) break;

                buffer += decoder.decode(readResult.value, { stream: true });

                var lines = buffer.split('\\n');
                buffer = lines.pop() || ''; // 保留最后一个不完整的行

                for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                  var lineItem = lines[lineIdx];
                  var trimmedLine = lineItem.trim();
                  if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;

                  if (trimmedLine.startsWith('data:')) {
                    try {
                      // 移除 'data:' 前缀（注意可能没有空格）
                      var jsonStr = trimmedLine.startsWith('data: ')
                        ? trimmedLine.slice(6)
                        : trimmedLine.slice(5);
                      var data = JSON.parse(jsonStr);

                      // 处理 reasoning_content (思考内容)
                      if (
                        data.choices &&
                        data.choices[0].delta.reasoning_content
                      ) {
                        var reasoningDelta =
                          data.choices[0].delta.reasoning_content;
                        if (reasoningDelta) {
                          var shouldScroll = !this.streamingContent;
                          // 如果还未进入思考模式，添加开始标签
                          if (!isInThinking) {
                            this.streamingContent +=
                              '<details class="thinking" open style="position: relative; overflow: hidden; font-size: 0.75em">\\n<summary>思考内容</summary>\\n\\n';
                            isInThinking = true;
                          }
                          this.streamingContent += reasoningDelta;
                          if (shouldScroll) {
                            this.scrollToBottom();
                          }
                        }
                      }

                      // 处理 content (正式回答)
                      if (data.choices && data.choices[0].delta.content) {
                        var delta = data.choices[0].delta.content;
                        // 如果之前在思考模式，现在要输出正式内容了，先关闭思考块
                        if (isInThinking) {
                          this.streamingContent += '\\n</details>\\n\\n';
                          this.streamingContent = this.streamingContent.replace(
                            '<details class="thinking" open',
                            '<details class="thinking"'
                          );
                          isInThinking = false;
                        }
                        var regThinkStart = new RegExp('<think>');
                        var regThinkEnd = new RegExp('</think>');
                        var shouldFoldThinking = false;
                        delta = delta.replace(
                          regThinkStart,
                          '<details class="thinking" open style="position: relative; overflow: hidden; font-size: 0.75em">\\n<summary>思考内容</summary>\\n\\n'
                        );
                        if (regThinkEnd.test(delta)) {
                          delta = delta.replace(regThinkEnd, '</details>\\n');
                          shouldFoldThinking = true;
                        }

                        if (delta) {
                          var shouldScroll = !this.streamingContent;
                          var content = delta;
                          if (shouldFoldThinking) {
                            content = content.replace(
                              '<details class="thinking" open',
                              '<details class="thinking"'
                            );
                          }
                          this.streamingContent += content;
                          if (shouldScroll) {
                            this.scrollToBottom();
                          }
                        }
                      }
                    } catch (parseError) {
                      console.warn(
                        '解析 SSE 数据失败:',
                        parseError,
                        'Line:',
                        trimmedLine
                      );
                    }
                  }
                }
              }

              // 流式完成，将内容保存到消息数组中
              session.messages.push({
                type: 'bot',
                content: this.streamingContent,
                time: new Date().toISOString(),
                model: this.selectedModel
              });
              this.saveData();
            } catch (error) {
              console.error('Error:', error);
              if (error.name === 'AbortError') {
                this.errorMessage = '请求已取消';
              } else {
                this.errorMessage = '发送失败: ' + error.message;
                // 显示错误提示
                this.showSwal({
                  title: '发送失败',
                  text: error.message,
                  icon: 'error',
                  confirmButtonText: '确定'
                });
              }
              // 如果有流式内容，仍然保存到消息数组
              if (this.streamingContent) {
                session.messages.push({
                  type: 'bot',
                  content: this.streamingContent,
                  time: new Date().toISOString(),
                  model: this.selectedModel
                });
                this.saveData();
              }
            } finally {
              this.isLoading = false;
              this.isStreaming = false;
              this.streamingContent = '';
              this.abortController = null;
              this.generateSessionSummary();
              // this.scrollToBottom();
            }
          },
          // 保存tavily的搜索结果,用于后续回显
          saveSearchRes(res) {
            const KEY = 'openai_search_results';
            const query = res && res.query;
            if (!query) return;
            if (!res.results || res.results.length === 0) return;
            let cache = localStorage.getItem(KEY);
            if (cache) {
              try {
                cache = JSON.parse(cache);
              } catch (e) {
                cache = [];
              }
            } else {
              cache = [];
            }
            const idx = cache.findIndex(i => i.query === query);
            if (idx >= 0) {
              cache.splice(idx, 1, res);
            } else {
              cache.unshift(res);
              cache = cache.slice(0, 30);
            }
            localStorage.setItem(KEY, JSON.stringify(cache));
          },

          // 根据query找到cache中缓存的搜索结果
          getSearchRes(query) {
            if (!query) return null;
            const KEY = 'openai_search_results';
            let cache = localStorage.getItem(KEY);
            if (cache) {
              try {
                cache = JSON.parse(cache);
              } catch (e) {
                cache = [];
              }
            } else {
              cache = [];
            }
            const res = cache.find(i => i.query === query);
            return res || null;
          },

          // 编辑已经问过的问题
          editQuestion(msgIndex) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            if (!this.currentSession) return;
            var session = this.currentSession;
            var msg = session.messages[msgIndex];
            if (!msg || msg.type !== 'user') return;

            // 二次确认
            this.showSwal({
              title: '确认编辑问题',
              text: '这会删除该问题及之后的所有对话，您确定要编辑这个问题吗？',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确定',
              confirmButtonColor: '#d33',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (!result.isConfirmed) return;
              var questionText = msg.content || '';
              // 恢复图片到上传列表
              this.uploadedImages = (msg.images || [])
                .filter(i => i && i !== 'INVALID')
                .map(i => ({ url: i }));
              // 恢复文本附件到上传列表
              this.uploadedPlaintexts = (msg.plaintexts || []).map(item => {
                return { name: item.name, content: item.content };
              });
              // 删除从 msgIndex 开始的所有消息
              session.messages = session.messages.slice(0, msgIndex);
              // 如果删除了所有消息，重置标题和摘要
              if (session.messages.length === 0) {
                session.title = '新会话';
                session.summary = '';
              }
              session.draft = questionText;
              this.messageInput = questionText;
              session.role = this.getRolePrompt();
              this.saveData();
            });
          },

          // 删除最新的回答并重新回答
          regenerateAnswer(msgIndex) {
            // 二次确认
            this.showSwal({
              title: '确认删除回答',
              text: '确定要删除这个回答并重新生成吗？',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: '确定',
              confirmButtonColor: '#d33',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (!result.isConfirmed) return;
              if (this.isLoading || this.isStreaming || this.isUploadingImage)
                return;
              var session = this.currentSession;
              if (
                !session ||
                !session.messages ||
                session.messages.length === 0
              )
                return;

              var msg = session.messages[msgIndex];
              if (!msg || msg.type !== 'bot') return;

              // 删除这个回答（保留之前的用户问题）
              session.messages = session.messages.slice(0, msgIndex);
              this.saveData();

              // 重新发送消息
              this.retryCurrentQuestion();
            });
          },

          // 从指定消息分叉创建新会话
          forkFromMessage(msgIndex) {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            var session = this.currentSession;
            if (!session || !session.messages) return;
            var msg = session.messages[msgIndex];
            if (!msg || msg.type !== 'bot') return;

            // 二次确认
            this.showSwal({
              title: '确认分叉会话',
              text: '将从此消息往前的所有对话创建为新会话，是否继续？',
              icon: 'question',
              showCancelButton: true,
              confirmButtonText: '确定',
              confirmButtonColor: '#3085d6',
              cancelButtonText: '取消',
              reverseButtons: true
            }).then(result => {
              if (!result.isConfirmed) return;

              // 截取从开始到 msgIndex 的所有消息
              var forkedMessages = session.messages.slice(0, msgIndex + 1);

              // 创建新会话
              var newSession = {
                id: Date.now().toString(),
                title: '🔀 ' + (session.title || '新会话'),
                summary: session.summary ? '🔀 ' + session.summary : '',
                role: session.role || '',
                draft: '',
                messages: forkedMessages
              };

              // 添加到会话列表
              this.sessions.unshift(newSession);
              // 切换到新会话
              this.currentSessionId = newSession.id;
              // 加载新会话的草稿
              this.loadDraftFromCurrentSession();
              this.saveData();

              // 移动端创建新会话后隐藏侧边栏
              if (this.isMobile) {
                this.hideSidebar();
              }

              // 提示用户
              this.showSwal({
                title: '分叉成功',
                text: '已创建新会话，包含 ' + forkedMessages.length + ' 条消息',
                icon: 'success',
                timer: 2000,
                showConfirmButton: false
              });
            });
          },

          // 重新发送当前问题（用于API错误后的重试）
          retryCurrentQuestion() {
            if (this.isLoading || this.isStreaming || this.isUploadingImage)
              return;
            var session = this.currentSession;
            if (!session || !session.messages) return;

            // 清除错误消息
            this.errorMessage = '';

            // 找到最后一条用户消息
            var lastUserMsgIdx = -1;
            for (var i = session.messages.length - 1; i >= 0; i--) {
              if (session.messages[i].type === 'user') {
                lastUserMsgIdx = i;
                break;
              }
            }

            if (lastUserMsgIdx === -1) return;

            var lastUserMsg = session.messages[lastUserMsgIdx];
            // 检查这条用户消息后面是否已经有回答
            var hasAnswer =
              session.messages.length > lastUserMsgIdx + 1 &&
              session.messages[lastUserMsgIdx + 1].type === 'bot';

            if (!hasAnswer) {
              // 没有回答，需要重试：删除这条用户消息并重新发送
              this.messageInput = lastUserMsg.content || '';
              this.uploadedImages = (lastUserMsg.images || [])
                .filter(i => i && i !== 'INVALID')
                .map(i => ({ url: i }));
              // 恢复文本附件到上传列表
              this.uploadedPlaintexts = (lastUserMsg.plaintexts || []).map(
                item => {
                  return { name: item.name, content: item.content };
                }
              );
              // 删除最后一条用户消息
              session.messages = session.messages.slice(0, lastUserMsgIdx);
              this.sendMessage();
            }
          },

          // 生成会话摘要
          async generateSessionSummary() {
            var session = this.currentSession;
            if (!session || !session.messages || session.messages.length < 2)
              return;
            // 已有摘要且消息数超过2条时不再生成
            if (session.summary && session.messages.length > 2) return;

            // 获取第一条用户消息和第一条bot回复
            var firstUserMsg = null;
            var firstBotMsg = null;
            for (var i = 0; i < session.messages.length; i++) {
              if (!firstUserMsg && session.messages[i].type === 'user') {
                firstUserMsg = session.messages[i];
              } else if (!firstBotMsg && session.messages[i].type === 'bot') {
                firstBotMsg = session.messages[i];
              }
              if (firstUserMsg && firstBotMsg) break;
            }

            if (!firstUserMsg || !firstBotMsg) return;

            var sessionId = session.id;
            var question = firstUserMsg.content;
            var answer = firstBotMsg.content;

            await this.sleep(150);

            fetch('/summarize', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + this.apiKey
              },
              body: JSON.stringify({
                question: question,
                answer: answer
              })
            })
              .then(response => {
                if (!response.ok) {
                  throw new Error(
                    'HTTP ' + response.status + ': ' + response.statusText
                  );
                }
                return response.json();
              })
              .then(data => {
                if (data.success && data.summary) {
                  var summary = data.summary.trim();
                  var item = this.sessions.find(s => s.id === sessionId);
                  if (item) {
                    // 移除结尾的标点符号
                    if (
                      summary.endsWith('。') ||
                      summary.endsWith('！') ||
                      summary.endsWith('？')
                    ) {
                      summary = summary.slice(0, -1);
                    }
                    item.summary = summary;
                    this.sleep(1000).then(() => {
                      this.saveData();
                    });
                  }
                } else {
                  throw new Error('未能生成摘要');
                }
              })
              .catch(error => {
                console.error('生成摘要失败:', error);
              });
          },

          // 根据全局角色设定的字符长度决定是否折叠
          autoFoldRolePrompt() {
            const len = (
              (this.currentSession && this.currentSession.role) ||
              ''
            ).length;
            if (len > 150) {
              this.isFoldRole = true;
            } else {
              this.isFoldRole = false;
            }
          },

          handleKeyDown(event) {
            if (this.isPC && event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              this.sendMessage();
            }
          },

          autoResizeTextarea() {
            this.\$nextTick(() => {
              const textarea = this.\$refs.messageInputRef;
              if (textarea) {
                textarea.style.height = 'auto';
                textarea.style.height =
                  Math.min(textarea.scrollHeight, 144) + 'px';
              }
            });
          },

          scrollToTop() {
            this.\$nextTick(() => {
              const container = this.\$refs.messagesContainer;
              if (container) {
                container.scrollTop = 0;
              }
            });
          },

          scrollToBottom() {
            this.\$nextTick(() => {
              const container = this.\$refs.messagesContainer;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
            });
          },

          // 如果当前已经滑动到底部，则保持在底部
          async stickToBottom() {
            await this.\$nextTick();
            const vh = window.innerHeight;
            const container = this.\$refs.messagesContainer;
            if (!container) return;
            // 如果当前容器滚动高度低于1.15倍window.innerHeight, 强制滚动到底部
            if (container.scrollHeight < vh * 1.15) {
              container.scrollTop = container.scrollHeight;
              return;
            }
            const isAtBottom =
              container.scrollHeight - container.scrollTop <=
              container.clientHeight + vh * 0.2;
            if (isAtBottom) {
              container.scrollTop = container.scrollHeight;
            }
          },

          // 清空输入框
          clearInput() {
            this.messageInput = '';
            this.saveDraftToCurrentSession();
          },

          // 输入变化时的处理
          onInputChange() {
            this.saveDraftToCurrentSession();
          },

          // 保存草稿到当前会话
          saveDraftToCurrentSession() {
            if (this.currentSession) {
              this.currentSession.draft = this.messageInput;
              this.saveData();
            }
          },

          // 从当前会话加载草稿
          loadDraftFromCurrentSession() {
            if (this.currentSession) {
              this.messageInput = (this.currentSession.draft || '').trim();
            } else {
              this.messageInput = '';
            }
          },

          // 显示关于信息
          showAbout() {
            const isMobile = this.isMobile;
            const template = this.\$refs.aboutTemplate;
            if (!template) return;
            const htmlContent = template.innerHTML;
            this.showSwal({
              title: '关于 OpenAI WebUI Lite',
              confirmButtonText: '&emsp;知道了&emsp;',
              width: isMobile ? '95%' : '600px',
              html: htmlContent
            });
          }
        }
      }).mount('#app');
    </script>
  </body>
</html>
`; // htmlContent FINISHED
  htmlContent = htmlContent.replace(`'$MODELS_PLACEHOLDER$'`, `'${modelIds}'`);
  // 控制"联网搜索"复选框的显隐
  if (!tavilyKeys) {
    htmlContent = htmlContent.replace(`"model-search-label"`, `"hidden"`);
  }
  // 替换网页标题
  if (title) {
    const regex = new RegExp(TITLE_DEFAULT, 'g');
    htmlContent = htmlContent.replace(regex, title);
  }
  // 如果模型<=10个, 则不必引入tom-select.js
  if (modelIds.split(',').length <= 10) {
    htmlContent = htmlContent.replace(
      /<script[\s]*src="https:\/\/unpkg\.com\/tom-select[\s\S]{0,80}?\/script>/,
      ''
    );
    htmlContent = htmlContent.replace(
      /<link[\s]*href="https:\/\/unpkg\.com\/tom-select[\s\S]{0,80}?\/>/,
      ''
    );
  }
  return htmlContent;
}
