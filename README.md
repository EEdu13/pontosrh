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
- ✅ Use senhas fortes para JWT_SECRET
- ✅ Mantenha credenciais do SQL Server e Azure privadas

## 📁 Estrutura do Projeto

```
pontosrh/
├── server.js                 # Servidor Node.js principal
├── login.html                # Página de login
├── index.html                # Painel de justificativas
├── presenca.html             # Painel de presença
├── monitor.html              # Monitor de batidas
├── package.json              # Dependências do projeto
├── .env.example              # Exemplo de variáveis de ambiente
├── .gitignore                # Arquivos ignorados pelo Git
└── README.md                 # Este arquivo
```

## 🔄 Atualizando server.js para usar variáveis de ambiente

O arquivo `server.js` precisa ser atualizado para ler as variáveis do `.env`. Exemplo:

```javascript
require('dotenv').config();

const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    // ...
};
```

## 📱 Páginas do Sistema

- `/` ou `/login.html` - Login
- `/index.html` - Justificativas (requer autenticação)
- `/presenca.html` - Painel de Presença
- `/monitor.html` - Monitor de Batidas

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
