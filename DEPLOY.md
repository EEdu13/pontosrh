# 🚀 Guia de Deploy - Railway

## Preparação do Código

### 1️⃣ Instalar dotenv localmente

```bash
npm install dotenv
```

### 2️⃣ Criar arquivo .env local (NÃO COMMITAR)

```bash
cp .env.example .env
```

Edite `.env` com suas credenciais reais para teste local.

### 3️⃣ Verificar .gitignore

Certifique-se que o `.gitignore` inclui:
```
.env
.env.local
*.backup.*
node_modules/
token.txt
pdfseculum.txt
```

## Deploy no GitHub

### 4️⃣ Inicializar repositório (se ainda não fez)

```bash
git init
git add .
git commit -m "Primeiro commit - Sistema de Justificativas"
git branch -M main
git remote add origin https://github.com/EEdu13/pontosrh.git
git push -u origin main
```

### 5️⃣ Verificar que credenciais NÃO foram commitadas

```bash
git log --all --full-history -- "*token.txt"
git log --all --full-history -- "*.env"
```

Se aparecer algo, **PARE** e limpe o histórico antes de prosseguir!

## Deploy no Railway

### 6️⃣ Criar projeto no Railway

1. Acesse [railway.app](https://railway.app)
2. Login com GitHub
3. **New Project** → **Deploy from GitHub repo**
4. Selecione `EEdu13/pontosrh`
5. Railway detectará Node.js automaticamente

### 7️⃣ Configurar Variáveis de Ambiente

No painel Railway, vá em **Variables** e adicione **TODAS** estas variáveis:

```env
# Servidor
PORT=3000
NODE_ENV=production

# JWT
JWT_SECRET=MUDE_ESTA_SENHA_POR_UMA_FORTE_123456789
JWT_EXPIRES_IN=24h

# SQL Server (Azure)
DB_USER=sqladmin
DB_PASSWORD=SenhaForte123!
DB_SERVER=alrflorestal.database.windows.net
DB_DATABASE=Tabela_teste

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=https://checklistfilesferre.blob.core.windows.net/justificativas?sp=racwdli&st=2025-10-29T04:17:35Z&se=2027-03-01T12:32:35Z&spr=https&sv=2024-11-04&sr=c&sig=1jKY%2BiMTkvdPXs940ahhnNFkDw%2FvoJ3di4uAVr76fa4%3D
AZURE_STORAGE_ACCOUNT=checklistfilesferre
AZURE_STORAGE_CONTAINER=justificativas

# API Secullum
SECULLUM_API_URL=https://pontowebintegracaoexterna.secullum.com.br
SECULLUM_AUTH_URL=https://autenticador.secullum.com.br/Token
SECULLUM_USERNAME=ferreira.eduardo@larsil.com.br
SECULLUM_PASSWORD=larsil123@
SECULLUM_CLIENT_ID=3
```

⚠️ **IMPORTANTE**: 
- Mude `JWT_SECRET` para uma senha forte e única
- Verifique todas as credenciais do SQL Server e Azure
- Confirme username e password da API Secullum

### 8️⃣ Configurar Domínio (Opcional)

1. No Railway, vá em **Settings** → **Domains**
2. Clique em **Generate Domain**
3. Você receberá uma URL como: `pontosrh-production.up.railway.app`

### 9️⃣ Deploy Automático

- Railway fará o deploy automaticamente após configurar as variáveis
- Acompanhe os logs em **Deployments**
- Aguarde até ver "✅ Deploy successful"

### 🔟 Testar o Sistema

Acesse: `https://seu-dominio.up.railway.app`

- Deve aparecer a tela de login
- Teste login com suas credenciais Secullum
- Verifique se os dados carregam corretamente

## Troubleshooting

### ❌ Erro: "Cannot find module 'dotenv'"

```bash
npm install dotenv
git add package.json package-lock.json
git commit -m "Adicionar dotenv"
git push
```

### ❌ Erro: "Connection timeout" no SQL

Verifique:
1. Firewall do Azure SQL permite conexões do Railway
2. Credenciais `DB_*` estão corretas no Railway
3. String de conexão está completa

### ❌ Erro: "Unauthorized" na API Secullum

Verifique:
1. `SECULLUM_USERNAME` e `SECULLUM_PASSWORD` corretos
2. Credenciais ainda válidas na Secullum
3. `SECULLUM_CLIENT_ID` é `3`

### ❌ Site não carrega (404)

1. Verifique se `login.html` está no root do projeto
2. Confirme que rota `/` está configurada no server.js:
   ```javascript
   app.get('/', (req, res) => {
       res.sendFile(__dirname + '/login.html');
   });
   ```

## Atualizações Futuras

Para atualizar o código:

```bash
git add .
git commit -m "Descrição da alteração"
git push
```

Railway fará deploy automático em ~2-3 minutos.

## Monitoramento

- **Logs**: Railway → Deployments → View Logs
- **Métricas**: Railway → Metrics (CPU, memória, requisições)
- **Uptime**: Use serviços como UptimeRobot ou Pingdom

## Segurança Pós-Deploy

✅ **Checklist de Segurança:**

- [ ] `.env` está no `.gitignore`
- [ ] Nenhuma credencial commitada no GitHub
- [ ] `JWT_SECRET` é forte e única
- [ ] Firewall do SQL Server configurado
- [ ] HTTPS habilitado (Railway faz automaticamente)
- [ ] Credenciais Secullum atualizadas se necessário

---

✨ **Deploy concluído com sucesso!**
