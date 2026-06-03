# 📦 Rastreio de Pedidos

Site de rastreamento próprio, integrado ao SSW (Fitlog + Mira).
Roda no Netlify com Functions (proxy serverless).

## 🚀 Como subir no Netlify

### Opção 1 — Arrastar e soltar (mais simples)

1. Acesse https://app.netlify.com/drop
2. Arraste a pasta inteira (`rastreio-site/`) pro navegador
3. Pronto! O Netlify gera uma URL tipo `https://nome-aleatorio.netlify.app`

### Opção 2 — Via Git (recomendado para atualizações fáceis)

1. Crie um repositório no GitHub e dê push nesta pasta
2. No Netlify: **Add new site → Import an existing project → GitHub**
3. Escolha o repositório
4. Build settings:
   - Build command: *(deixar vazio)*
   - Publish directory: `.`
   - Functions directory: `netlify/functions`
5. Deploy

## 🔐 Configurar variáveis de ambiente (recomendado)

Por padrão, o CNPJ e senha estão hardcoded no `rastrear.js`.
Pra deixar mais seguro, no painel do Netlify:

**Site settings → Environment variables → Add a variable**

| Variável | Valor |
|----------|-------|
| `CNPJ` | `42418313000104` |
| `SENHA_FITLOG` | `0104` |
| `SENHA_MIRA` | *(deixar vazio)* |

Depois faça um novo deploy pra pegar as variáveis.

## 🧪 Testar localmente (opcional)

```bash
npm install -g netlify-cli
netlify dev
```

Vai abrir em `http://localhost:8888`.

## 📁 Estrutura

```
rastreio-site/
├── index.html              ← Página principal
├── netlify.toml            ← Config Netlify (redirects, headers)
├── package.json            ← Marca como projeto Node
└── netlify/
    └── functions/
        └── rastrear.js     ← Proxy SSW (CORS-free)
```

## 🛠️ Como funciona

1. Usuário escolhe transportadora + digita NF
2. JS faz GET em `/api/rastrear?carrier=FITLOG&nf=99812`
3. O Netlify redireciona pra `/.netlify/functions/rastrear`
4. A Function faz POST no `ssw.inf.br/2/resultSSW` com CNPJ+NF+senha
5. Parser extrai o status do HTML do SSW
6. Devolve JSON pro front

## ➕ Adicionar Jamef depois

Atualmente só Fitlog e Mira (via SSW). Pra adicionar Jamef:
- Precisa armazenar cookies de sessão (Lambda é stateless, não persiste)
- Opções: usar Redis (Upstash grátis), planilha do Google, ou hardcode token
- Avise quando quiser fazer
