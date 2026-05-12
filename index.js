const http = require('http');
const https = require('https');

const USERS = JSON.parse(process.env.USERS || '{}');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const PORT = process.env.PORT || 8080;
const GITHUB_REPO = process.env.GITHUB_REPO || 'rp-azevedo/rh-wiki';
const WIKI_PATH = process.env.WIKI_PATH || 'Wiki da Azevedo Tintas';

// Cache do wiki em memória
let wikiCache = [];
let cacheCarregado = false;

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

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    https.request({
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'GET',
      headers: { 'User-Agent': 'rh-assistant', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject).end();
  });
}

async function carregarWiki() {
  console.log('Carregando wiki do GitHub...');
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/main?recursive=1`;
    const tree = await httpsGet(url);
    const arquivos = (tree.tree || []).filter(f =>
      f.path.endsWith('.md') && f.path.startsWith(WIKI_PATH)
    );

    console.log(`Encontrados ${arquivos.length} arquivos. Baixando...`);
    const docs = [];

    for (const arquivo of arquivos) {
      try {
        const encoded = arquivo.path.split('/').map(p => encodeURIComponent(p)).join('/');
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${encoded}`;
        const conteudo = await httpsGet(rawUrl);
        const nome = arquivo.path.split('/').pop().replace('.md', '');
        if (typeof conteudo === 'string' && conteudo.length > 10) {
          docs.push({ nome, conteudo, path: arquivo.path });
        }
      } catch (e) {
        console.error(`Erro ao baixar ${arquivo.path}:`, e.message);
      }
    }

    wikiCache = docs;
    cacheCarregado = true;
    console.log(`✅ Wiki carregado: ${docs.length} documentos em memória.`);
  } catch (e) {
    console.error('Erro ao carregar wiki:', e.message);
  }
}

function extrairLinks(conteudo) {
  const matches = conteudo.match(/\[\[([^\]]+)\]\]/g) || [];
  return matches.map(m => m.replace(/\[\[|\]\]/g, '').trim());
}

function calcularRelevancia(conteudo, query) {
  const palavras = query.toLowerCase().split(/\s+/).filter(p => p.length > 2);
  const texto = conteudo.toLowerCase();
  let score = 0;
  for (const palavra of palavras) {
    score += (texto.match(new RegExp(palavra, 'g')) || []).length;
  }
  return score;
}

function buscarContexto(query) {
  if (wikiCache.length === 0) return '(wiki ainda carregando, tente novamente em instantes)';

  const resultados = wikiCache.map(doc => ({
    ...doc,
    score: calcularRelevancia(doc.conteudo, query)
  })).sort((a, b) => b.score - a.score);

  const principais = resultados.slice(0, 3).filter(r => r.score > 0);
  if (principais.length === 0) principais.push(...resultados.slice(0, 2));

  const nomesIncluidos = new Set(principais.map(r => r.nome));
  const extras = [];

  for (const principal of principais) {
    const links = extrairLinks(principal.conteudo);
    for (const link of links) {
      if (!nomesIncluidos.has(link)) {
        const encontrado = wikiCache.find(r => r.nome === link);
        if (encontrado) {
          extras.push(encontrado);
          nomesIncluidos.add(link);
        }
      }
    }
  }

  const todos = [...principais, ...extras.slice(0, 2)];
  return todos.map(r => `=== ${r.nome} ===\n${r.conteudo.substring(0, 2000)}`).join('\n\n');
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Resposta inválida')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { ok: true, wikiCarregado: cacheCarregado, documentos: wikiCache.length });
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
      const ultimaMensagem = body.messages[body.messages.length - 1].content;
      const contexto = buscarContexto(ultimaMensagem);

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: `Você é um assistente de RH da Azevedo Tintas. O colaborador logado é: ${user.name}.

Responda dúvidas usando APENAS as informações do wiki abaixo. Seja simpático, claro e objetivo. Use linguagem informal mas profissional. Se a informação não estiver no wiki, diga que vai verificar e sugira contato com o RH em rh@azevedotintas.com.br. Responda sempre em português brasileiro.

WIKI DA EMPRESA:
${contexto}`,
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
  carregarWiki();
});
