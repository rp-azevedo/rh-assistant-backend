const http = require('http');
const https = require('https');

const USERS = JSON.parse(process.env.USERS || '{}');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const PORT = process.env.PORT || 8080;
const GITHUB_REPO = process.env.GITHUB_REPO || 'rp-azevedo/rh-wiki';
const WIKI_PATH = process.env.WIKI_PATH || 'Wiki da Azevedo Tintas';

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    const req = https.request({
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'GET',
      headers: {
        'User-Agent': 'rh-assistant',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getWikiFiles() {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/main?recursive=1`;
    const tree = await httpsGet(url);
    return (tree.tree || [])
      .filter(f => f.path.endsWith('.md') && f.path.startsWith(WIKI_PATH))
      .map(f => ({ path: f.path, url: f.url }));
  } catch (e) {
    console.error('Erro ao listar arquivos:', e.message);
    return [];
  }
}

async function getFileContent(filePath) {
  try {
    const encoded = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${encoded}`;
    return await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'rh-assistant' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  } catch (e) {
    return '';
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
    const ocorrencias = (texto.match(new RegExp(palavra, 'g')) || []).length;
    score += ocorrencias;
  }
  return score;
}

async function buscarContexto(query) {
  const arquivos = await getWikiFiles();
  if (arquivos.length === 0) return '(nenhum documento encontrado no wiki)';

  const resultados = [];

  for (const arquivo of arquivos) {
    const conteudo = await getFileContent(arquivo.path);
    if (!conteudo) continue;
    const score = calcularRelevancia(conteudo, query);
    const nome = arquivo.path.split('/').pop().replace('.md', '');
    resultados.push({ nome, conteudo, score, path: arquivo.path });
  }

  // Ordena por relevância
  resultados.sort((a, b) => b.score - a.score);

  // Pega os 3 mais relevantes
  const principais = resultados.slice(0, 3).filter(r => r.score > 0);

  if (principais.length === 0) {
    // Se não achou nada relevante, pega os 2 primeiros mesmo assim
    principais.push(...resultados.slice(0, 2));
  }

  // Segue links cruzados dos principais
  const nomesIncluidos = new Set(principais.map(r => r.nome));
  const extras = [];

  for (const principal of principais) {
    const links = extrairLinks(principal.conteudo);
    for (const link of links) {
      if (!nomesIncluidos.has(link)) {
        const encontrado = resultados.find(r => r.nome === link);
        if (encontrado) {
          extras.push(encontrado);
          nomesIncluidos.add(link);
        }
      }
    }
  }

  // Monta o contexto final
  const todos = [...principais, ...extras.slice(0, 2)];
  let contexto = '';
  for (const r of todos) {
    // Limita cada documento a 2000 caracteres para não estourar o contexto
    const texto = r.conteudo.substring(0, 2000);
    contexto += `\n\n=== ${r.nome} ===\n${texto}`;
  }

  return contexto || '(nenhuma informação relevante encontrada)';
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida')); }
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
      const ultimaMensagem = body.messages[body.messages.length - 1].content;
      const contexto = await buscarContexto(ultimaMensagem);

      const payload = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: `Você é um assistente de RH da Azevedo Tintas. O colaborador logado é: ${user.name}.

Responda dúvidas usando APENAS as informações do wiki abaixo. Seja simpático, claro e objetivo. Use linguagem informal mas profissional. Se a informação não estiver no wiki, diga que vai verificar e sugira contato com o RH. Responda sempre em português brasileiro.

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
});
