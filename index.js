const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const USERS = JSON.parse(process.env.USERS || '{}');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
  res.json({ name: user.name, username });
});

app.post('/chat', async (req, res) => {
  const { username, password, messages } = req.body;

  const user = USERS[username];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `Você é um assistente de RH da empresa. O colaborador logado é: ${user.name}.

Responda dúvidas sobre regras, direitos, deveres, benefícios e informações institucionais com base no wiki da empresa no Notion (conectado via MCP).

Seja simpático, claro e objetivo. Use linguagem informal mas profissional. Se não encontrar a informação no Notion, diga que vai verificar e sugira contato com o RH.

Responda sempre em português brasileiro.`,
        messages,
        mcp_servers: [{
          type: 'url',
          url: 'https://mcp.notion.com/mcp',
          name: 'notion-mcp',
          authorization_token: NOTION_TOKEN
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    res.json({ reply });
 } catch (err) {
    console.error('ERRO CHAT:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
