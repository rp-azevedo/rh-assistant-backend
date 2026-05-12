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

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function searchNotion(query) {
  const body = JSON.stringify({ query, page_size: 5 });
  const res = await httpsRequest({
    hostname: 'api.notion.com',
    path: '/v1/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  return res.results || [];
}

async function getPageContent(pageId) {
  const res = await httpsRequest({
    hostname: 'api.notion.com',
    path: `/v1/blocks/${pageId}/children?page_size=100`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    }
  });
  return (res.results || []).map(block => {
    const type = block.type;
    const rich = block[type]?.rich_text || [];
    return rich.map(r => r.plain_text).join('');
  }).filter(Boolean).join('\n');
}

function getPageTitle(page) {
  const props = page.properties || {};
  for (const key in props) {
    if (props[key].type === 'title') {
      return props[key].title.map(t => t.plain_text).join('');
    }
  }
  return 'Sem título';
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
      const lastMessage = body.messages[body.messages.length - 1].content;

      const searchResults = await searchNotion(lastMessage);
      let context = '';
      for (const page of searchResults.slice(0, 3)) {
        if (page.object !== 'page') continue;
        const title = getPageTitle(page);
        try {
          const content = await getPageContent(page.id);
          context += `\n\n=== ${title} ===\n${content}`;
        } catch (e) {}
      }

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: `Você é um assistente de RH da empresa. O colaborador logado é: ${user.name}.

Responda dúvidas usando APENAS as informações do wiki abaixo. Seja simpático, claro e objetivo. Use linguagem informal mas profissional. Se a informação não estiver no wiki, diga que vai verificar e sugira contato com o RH. Responda sempre em português brasileiro.

WIKI DA EMPRESA:
${context || '(nenhuma informação encontrada para essa pergunta)'}`,
        messages: body.messages
      });

      const data = await httpsRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, payload);

      if (data.error) {
        console.error('API error:', JSON.stringify(data.error));
        return sendJSON(res, 500, { error: data.error.message });
      }

      const reply = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n').trim();

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
