const http = require('http');
const https = require('https');

const USERS = JSON.parse(process.env.USERS || '{}');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const PORT = process.env.PORT || 8080;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/login') {
    const body = await readBody(req);
    const user = USERS[body.username];
    if (!user || user.password !== body.password) {
      return sendJSON(res, 401, { error: 'Usuário ou senha incorretos.' });
    }
    return sendJSON(res, 200, { name: user.name, username: body.username });
  }

  if (req.method === 'POST' && req.url === '/chat') {
    const body = await readBody(req);
    const user = USERS[body.username];
    if (!user || user.password !== body.password) {
      return sendJSON(res, 401, { error: 'Não autorizado.' });
    }

    try {
      const payload = JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: `Você é um assistente de RH da empresa. O colaborador logado é: ${user.name}. Responda dúvidas sobre regras, direitos, deveres, benefícios e informações institucionais com base no wiki da empresa no Notion (conectado via MCP). Seja simpático, claro e objetivo. Use linguagem informal mas profissional. Se não encontrar a informação no Notion, diga que vai verificar e sugira contato com o RH. Responda sempre em português brasileiro.`,
        messages: body.messages,
        mcp_servers: [{
          type: 'url',
          url: 'https://mcp.notion.com/mcp',
          name: 'notion-mcp',
          authorization_token: process.env.NOTION_TOKEN
        }]
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'mcp-client-2025-04-04',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiRes = await new Promise((resolve, reject) => {
        const apiReq = https.request(options, resolve);
        apiReq.on('error', reject);
        apiReq.write(payload);
        apiReq.end();
      });

      let rawData = '';
      await new Promise((resolve) => {
        apiRes.on('data', chunk => rawData += chunk);
        apiRes.on('end', resolve);
      });

      const data = JSON.parse(rawData);

      if (data.error) {
        console.error('API error:', JSON.stringify(data.error));
        return sendJSON(res, 500, { error: data.error.message });
      }

      const reply = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      return sendJSON(res, 200, { reply });

    } catch (err) {
      console.error('ERRO:', err.message);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
