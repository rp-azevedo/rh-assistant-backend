const http = require('http');
const https = require('https');

const USERS = JSON.parse(process.env.USERS || '{}');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const PORT = process.env.PORT || 8080;
const GITHUB_REPO = process.env.GITHUB_REPO || 'rp-azevedo/rh-wiki';
const WIKI_PATH = process.env.WIKI_PATH || '';

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = new URL(url);
    https.request({
      hostname: options.hostname,
      path: options.pathname + options.search,
      method: 'GET',
      headers: { 'User-Agent': 'rh-assistant' }
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
    const arquivos = (tree.tree || []).filter(f => f.path.endsWith('.md'));

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
    console.log(`Wiki carregado: ${docs.length} documentos.`);
  } catch (e) {
    console.error('Erro ao carregar wiki:', e.message);
  }
}

// Normaliza texto: remove acentos, pontuação, converte para minúsculas
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')   // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

// Expande termos comuns de RH para sinônimos
function expandirTermos(query) {
  const sinonimos = {
    'ferias': ['ferias', 'descanso', 'folga', 'periodo aquisitivo', 'gozo'],
    'folga': ['folga', 'ferias', 'descanso', 'falta'],
    'falta': ['falta', 'ausencia', 'atestado', 'abono'],
    'atestado': ['atestado', 'falta', 'medico', 'cid'],
    'salario': ['salario', 'remuneracao', 'pagamento', 'holerite', 'adiantamento'],
    'ponto': ['ponto', 'jornada', 'horario', 'controle', 'registro'],
    'uniforme': ['uniforme', 'cracha', 'vestimenta'],
    'demissao': ['demissao', 'justa causa', 'rescisao', 'desligamento'],
    'beneficio': ['beneficio', 'convenio', 'odontologico', 'seguro', 'vale'],
    'convenio': ['convenio', 'odontologico', 'plano', 'saude'],
    'seguro': ['seguro', 'vida', 'beneficio'],
    'transporte': ['transporte', 'vale transporte', 'vt'],
    'banco de horas': ['banco de horas', 'horas extras', 'compensacao'],
    'loja': ['loja', 'filial', 'unidade'],
    'conduta': ['conduta', 'normas', 'comportamento', 'disciplina'],
  };

  const queryNorm = normalizar(query);
  const termos = new Set(queryNorm.split(' ').filter(t => t.length > 2));

  for (const [chave, expansao] of Object.entries(sinonimos)) {
    if (queryNorm.includes(chave)) {
      expansao.forEach(t => termos.add(t));
    }
  }

  return [...termos];
}

function calcularRelevancia(doc, termos) {
  const nomeNorm = normalizar(doc.nome);
  const conteudoNorm = normalizar(doc.conteudo);
  let score = 0;

  for (const termo of termos) {
    // Nome do arquivo tem peso maior
    const ocNome = (nomeNorm.match(new RegExp(termo, 'g')) || []).length;
    score += ocNome * 5;

    // Conteúdo
    const ocConteudo = (conteudoNorm.match(new RegExp(termo, 'g')) || []).length;
    score += ocConteudo;
  }

  return score;
}

function extrairLinks(conteudo) {
  const matches = conteudo.match(/\[\[([^\]]+)\]\]/g) || [];
  return matches.map(m => m.replace(/\[\[|\]\]/g, '').trim());
}

function buscarContexto(query) {
  if (wikiCache.length === 0) return '(wiki ainda carregando)';

  const termos = expandirTermos(query);

  const resultados = wikiCache
    .map(doc => ({ ...doc, score: calcularRelevancia(doc, termos) }))
    .sort((a, b) => b.score - a.score);

  // Pega os 3 mais relevantes com score > 0
  const principais = resultados.filter(r => r.score > 0).slice(0, 3);

  // Se não achou nada, pega os 2 primeiros mesmo assim
  if (principais.length === 0) principais.push(...resultados.slice(0, 2));

  // Segue links cruzados
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
          if (extras.length >= 2) break;
        }
      }
    }
  }

  const todos = [...principais, ...extras];
  console.log(`Contexto: ${todos.map(r => r.nome).join(', ')}`);

  return todos
    .map(r => `=== ${r.nome} ===\n${r.conteudo.substring(0, 2500)}`)
    .join('\n\n');
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
