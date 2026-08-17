# Sistema de Justificativas - LARSIL

Sistema completo de gestão de ponto e justificativas integrado com API Secullum.

## 🚀 Funcionalidades

- ✅ **Gestão de Justificativas**: Criação, edição e aprovação de justificativas de ponto
- ✅ **Integração Secullum**: Conexão direta com API de ponto eletrônico
- ✅ **Painel de Presença**: Visualização de presença por departamento e origem de batidas
- ✅ **Monitor de Batidas**: Acompanhamento em tempo real de registros de ponto
- ✅ **Sistema de Anexos**: Upload e gestão de documentos via Azure Blob Storage
- ✅ **Autenticação JWT**: Sistema seguro de login e permissões
- ✅ **Multi-empresa**: Suporte para múltiplas empresas/bancos de dados

## 🛠️ Tecnologias

### Backend
- **Node.js** + Express
- **SQL Server** (Azure SQL Database)
- **Azure Blob Storage** para arquivos
- **JWT** para autenticação

### Frontend
- **HTML5** + **CSS3** + **JavaScript** puro
- **Chart.js** para gráficos
- **Font Awesome** para ícones

## 📦 Instalação Local

```bash
# Clone o repositório
git clone https://github.com/EEdu13/pontosrh.git
cd pontosrh

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o arquivo .env com suas credenciais

# Inicie o servidor
npm start
```

O servidor estará rodando em `http://localhost:3000`

## 🌐 Deploy no Railway

### Passo 1: Preparar o Repositório

1. Certifique-se de que o `.gitignore` está configurado corretamente
2. **NÃO** commite o arquivo `.env` com suas credenciais
3. Faça push do código para o GitHub

```bash
git add .
git commit -m "Deploy inicial"
git push origin main
```

### Passo 2: Configurar no Railway

1. Acesse [railway.app](https://railway.app) e faça login com GitHub
2. Clique em **"New Project"** → **"Deploy from GitHub repo"**
3. Selecione o repositório `pontosrh`
4. Railway detectará automaticamente o Node.js e package.json

### Passo 3: Configurar Variáveis de Ambiente

No painel do Railway, vá em **Variables** e adicione:

```env
PORT=3000
NODE_ENV=production

# JWT
JWT_SECRET=sua_chave_secreta_aqui_use_senha_forte
JWT_EXPIRES_IN=24h

# SQL Server
DB_USER=seu_usuario_sql
DB_PASSWORD=sua_senha_sql
DB_SERVER=seu_servidor.database.windows.net
DB_DATABASE=nome_do_banco

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=sua_connection_string
AZURE_STORAGE_ACCOUNT=nome_da_conta
AZURE_STORAGE_CONTAINER=nome_do_container

# API Secullum
SECULLUM_API_URL=https://pontowebintegracaoexterna.secullum.com.br
SECULLUM_AUTH_URL=https://autenticador.secullum.com.br/Token
SECULLUM_USERNAME=seu_usuario@empresa.com.br
SECULLUM_PASSWORD=sua_senha_secullum
SECULLUM_CLIENT_ID=3
```

### Passo 4: Deploy

- Railway fará o deploy automaticamente
- Acesse a URL fornecida (ex: `https://pontosrh-production.up.railway.app`)

## 🔐 Segurança

⚠️ **IMPORTANTE**: Nunca commite credenciais no GitHub!

- ✅ Use `.env` para variáveis locais (já está no `.gitignore`)
- ✅ Configure variáveis de ambiente no Railway
- ✅ Use senhas fortes para JWT_SECRET — em produção o servidor **não sobe** sem ela
- ✅ Mantenha credenciais do SQL Server e Azure privadas
- ✅ `.env.example` só contém placeholders — nunca preencha com valores reais
- ❌ Nunca coloque senha em arquivo `.html` ou `.js` do frontend

## 📁 Estrutura do Projeto

```
pontosrh/
├── server.js                 # Servidor Node.js principal (API + estáticos)
├── login.html                # Página de login
├── index.html                # Painel de justificativas
├── presenca.html             # Painel de presença
├── monitor.html              # Monitor de relógios de ponto
├── coletas.html              # Status das comunicações dos relógios
├── relatorio.html            # Dashboard de estatísticas
├── assets/
│   ├── theme.css             # Tokens de tema compartilhados
│   └── session.js            # Sessão/tokens compartilhados entre as páginas
├── package.json              # Dependências do projeto
├── .env.example              # Exemplo de variáveis de ambiente
├── .gitignore                # Arquivos ignorados pelo Git
└── README.md                 # Este arquivo
```

## 🔑 Como funciona a autenticação

**A identidade não mora aqui.** Quem autentica é a **IAM Larsil** — este projeto
não tem tabela de usuário nem compara senha (ver `INTEGRACAO.md`).

1. `login.html` envia `{ login, senha }` para o nosso `POST /api/auth/login`.
2. O backend repassa para a IAM e devolve ao navegador o **token da IAM** com
   papéis, permissões e escopos.
3. O token acompanha toda chamada `/api/*`; o backend valida em
   `GET {IAM_URL}/api/auth/resolve` (cache de 60s), então liberar ou negar uma
   tela no console da IAM passa a valer no próximo F5.
4. Se a senha for provisória, o usuário é levado a `primeiro-acesso.html`.

Regras que valem para qualquer alteração no projeto:

- **Não criar tabela de login/usuário.** Permissão nova = declarar no manifesto
  de `scripts/iam-sync.js` e rodar `npm run iam:sync`.
- **Nenhuma página carrega credenciais.** O HTML é público para o navegador.
- **Toda rota `/api/*` exige token** por um middleware global no `server.js`.
  Para abrir uma rota, adicione o caminho em `PUBLIC_API_PATHS`.
- **A Secullum é falada só pelo backend**, em `/api/secullum/*`, com a conta de
  serviço do `.env` (`SECULLUM_USERNAME`/`SECULLUM_PASSWORD`) — porque nem todo
  usuário do RH tem permissão de Integração Externa lá. O e-mail de quem
  executou fica gravado no campo `Motivo` de cada escrita.

### Fotos de perfil

A IAM **não** guarda foto. Quem resolve é o **Painel PCP**, por nome:

```
<img src="{PCP_URL}/api/foto/{nome}">
```

O front pega essa URL em `GET /api/config` e usa `SESSION.avatar(nome)` —
que já trata fallback para iniciais, `loading="lazy"` e o clique que amplia.

### Variáveis novas

```env
IAM_URL=https://painelgestor.up.railway.app
PCP_URL=https://gestao.up.railway.app
IAM_SISTEMA=PONTORH
IAM_REGISTRY_KEY=<chave dada pela TI>
```

## 📱 Páginas do Sistema

- `/` ou `/login.html` - Login
- `/index.html` - Justificativas (requer autenticação)
- `/presenca.html` - Painel de Presença
- `/monitor.html` - Monitor de Relógios de Ponto
- `/coletas.html` - Coletas / Comunicações
- `/relatorio.html` - Dashboard de Relatórios

## 🤝 Contribuindo

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/nova-feature`)
3. Commit suas mudanças (`git commit -m 'Adiciona nova feature'`)
4. Push para a branch (`git push origin feature/nova-feature`)
5. Abra um Pull Request

## 📄 Licença

ISC License

## 👨‍💻 Autor

Eduardo Ferreira - LARSIL

---

⚙️ **Desenvolvido com Node.js + Express + SQL Azure**
