require('dotenv').config();

// POLYFILL para crypto no Node.js (necessário para @azure/storage-blob no Railway)
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = require('crypto').webcrypto;
}

const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Railway/proxy reverso

// ==========================================
// CONFIGURAÇÃO DE AUTENTICAÇÃO
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_aqui_mude_em_producao';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

if (process.env.NODE_ENV === 'production' &&
    JWT_SECRET === 'sua_chave_secreta_super_segura_aqui_mude_em_producao') {
    console.error('❌ FATAL: JWT_SECRET não configurado em produção. Defina a variável de ambiente JWT_SECRET.');
    process.exit(1);
}

// ==========================================
// CONFIGURAÇÃO DA API SECULLUM
// ==========================================
const SECULLUM_AUTH_URL = process.env.SECULLUM_AUTH_URL || 'https://autenticador.secullum.com.br/Token';
const SECULLUM_API_URL = process.env.SECULLUM_API_URL || 'https://pontowebintegracaoexterna.secullum.com.br';
const SECULLUM_CLIENT_ID = process.env.SECULLUM_CLIENT_ID || '3';

// ==========================================
// UTILITÁRIOS
// ==========================================

// Normaliza data para YYYY-MM-DD, aceitando DD/MM/YYYY e ISO com timestamp.
// Retorna null se não for possível normalizar.
function normalizarData(data) {
    if (!data) return null;
    const str = String(data);

    if (str.includes('/')) {
        const [dia, mes, ano] = str.split('/');
        if (!dia || !mes || !ano) return null;
        return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }

    const semHora = str.includes('T') ? str.split('T')[0] : str;
    return /^\d{4}-\d{2}-\d{2}$/.test(semHora) ? semHora : null;
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido ou expirado' });
        }
        req.user = user;
        next();
    });
}

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Desabilitado: muitos inline scripts/styles no projeto
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Aumentar limite para imagens base64
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Rate limit anti-brute-force só no login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

// ==========================================
// PROTEÇÃO: bloquear download de arquivos sensíveis via static
// ==========================================
const BLOCKED_PATTERNS = [
    /\.bak$/i, /\.backup$/i, /\.sql$/i, /\.env/i,
    /token\.txt$/i, /pdfseculum/i, /package(-lock)?\.json$/i,
    /^\/server[^/]*\.js$/i, /^\/servidor\.js$/i, /^\/config\.js$/i,
    /\.md$/i, /leiame\.txt$/i,
    /^\/_backup_/i, /\.git\//i, /node_modules/i,
    /^\/Captura/i // screenshots na raiz
];
app.use((req, res, next) => {
    const p = req.path;
    if (BLOCKED_PATTERNS.some(rx => rx.test(p))) {
        return res.status(404).end();
    }
    next();
});

// Servir arquivos estáticos (HTML, CSS, JS) com cache
app.use(express.static('.', {
    maxAge: '1h',
    etag: true,
    setHeaders: (res, filePath) => {
        if (/\.html$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache'); // HTML sempre fresco
        }
    }
}));

// Rota raiz vai para login
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

// Configuração do SQL Azure
const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: true, // Azure requer criptografia
        trustServerCertificate: false,
        enableArithAbort: true
    },
    pool: {
        max: 20, // Aumentado de 10 para 20
        min: 2,  // Manter 2 conexões sempre abertas
        idleTimeoutMillis: 60000, // 60 segundos antes de fechar conexão ociosa
        acquireTimeoutMillis: 30000 // 30 segundos para adquirir conexão
    },
    connectionTimeout: 30000, // 30 segundos para conectar
    requestTimeout: 60000 // 60 segundos para executar query
};

// Configuração do Azure Blob Storage
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'justificativas';

// Token da API Secullum (deve ser gerado via /Token endpoint)
// NOTA: Este token expira! Em produção, implementar renovação automática
let SECULLUM_TOKEN = '';

// Cliente do Blob Storage
let blobServiceClient;
let containerClient;

function initBlobStorage() {
    try {
        if (!AZURE_STORAGE_CONNECTION_STRING) {
            throw new Error('AZURE_STORAGE_CONNECTION_STRING não configurada');
        }
        blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
        console.log('✅ Azure Blob Storage conectado');
    } catch (err) {
        console.error('❌ Erro ao conectar Azure Blob:', err.message);
    }
}

let poolPromise;
let sqlConnected = false;
let tokenRenewalInProgress = false;
let tokenRenewalTimer = null;

// Agenda a próxima renovação, cancelando a anterior.
// Sem isso, um sucesso após uma falha deixava duas cadeias de setTimeout ativas.
function scheduleTokenRenewal(delayMs) {
    if (tokenRenewalTimer) clearTimeout(tokenRenewalTimer);
    tokenRenewalTimer = setTimeout(authenticateSecullum, delayMs);
    tokenRenewalTimer.unref?.(); // não segura o processo aberto no shutdown
}

// Autenticar na API Secullum e obter token
async function authenticateSecullum() {
    if (tokenRenewalInProgress) {
        console.log('⏳ Renovação de token já em andamento, aguardando...');
        return;
    }

    tokenRenewalInProgress = true;

    try {
        if (!process.env.SECULLUM_USERNAME || !process.env.SECULLUM_PASSWORD) {
            console.error('❌ SECULLUM_USERNAME/SECULLUM_PASSWORD não configurados — token de serviço indisponível');
            return;
        }

        console.log('🔑 Autenticando na API Secullum...');
        const response = await fetch(SECULLUM_AUTH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'password',
                username: process.env.SECULLUM_USERNAME,
                password: process.env.SECULLUM_PASSWORD,
                client_id: SECULLUM_CLIENT_ID
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        SECULLUM_TOKEN = data.access_token;
        console.log('✅ Token Secullum obtido com sucesso');

        // Renovar 10 minutos antes de expirar (expires_in vem em segundos)
        const ttlMs = (Number(data.expires_in) || 3600) * 1000;
        scheduleTokenRenewal(Math.max(60000, ttlMs - 10 * 60 * 1000));

    } catch (err) {
        console.error('❌ Erro ao autenticar Secullum:', err.message);
        // Tentar novamente após 30 segundos em caso de erro
        scheduleTokenRenewal(30000);
    } finally {
        tokenRenewalInProgress = false;
    }
}

// Conectar ao SQL Azure
async function connectDB() {
    try {
        poolPromise = sql.connect(sqlConfig);
        await poolPromise;
        sqlConnected = true;
    } catch (err) {
        sqlConnected = false;
        console.error('Erro ao conectar SQL Azure:', err.message);
    }
}

// ==========================================
// PROTEÇÃO GLOBAL DA API
// Tudo sob /api exige JWT, exceto as rotas listadas aqui.
// Vale para rotas futuras também — não há como esquecer de proteger uma.
// ==========================================
const PUBLIC_API_PATHS = new Set([
    '/auth/login',
    '/auth/logout'
]);

app.use('/api', (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    return authenticateToken(req, res, next);
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// POST - Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios' });
        }

        // Autenticar na API Secullum
        const authResponse = await fetch(SECULLUM_AUTH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'password',
                username,
                password,
                client_id: SECULLUM_CLIENT_ID
            })
        });

        if (!authResponse.ok) {
            return res.status(401).json({ error: 'Email ou senha incorretos' });
        }

        const secullumData = await authResponse.json();

        // Buscar dados do usuário autenticado
        let userName = username.split('@')[0];
        const userInfoResponse = await fetch('https://autenticador.secullum.com.br/api/Account/UserInfo', {
            headers: { 'Authorization': `Bearer ${secullumData.access_token}` }
        });

        if (userInfoResponse.ok) {
            const userInfo = await userInfoResponse.json();
            userName = userInfo.Nome || userName;
        }

        // Gerar token JWT interno do sistema
        const token = jwt.sign(
            {
                username,
                name: userName,
                role: 'user'
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        // Validade do token Secullum (expires_in vem em segundos; fallback 1h)
        const secullumExpiresIn = Number(secullumData.expires_in) || 3600;

        res.json({
            success: true,
            token,
            secullumToken: secullumData.access_token,
            secullumExpiresIn,
            user: { username, name: userName, role: 'user' }
        });

    } catch (err) {
        console.error('Erro no login:', err.message);
        res.status(500).json({ error: 'Erro ao conectar com servidor de autenticação' });
    }
});

// GET - Verificar token
app.get('/api/auth/verify', (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});

// GET - Logout (limpar token no cliente)
app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true, message: 'Logout realizado' });
});

// GET - Obter configurações da API Secullum (protegido)
// NUNCA devolve credenciais: o cliente usa o token obtido no próprio login.
app.get('/api/secullum-config', (req, res) => {
    res.json({
        authURL: SECULLUM_AUTH_URL,
        baseURL: SECULLUM_API_URL,
        clientId: SECULLUM_CLIENT_ID
    });
});

// ==========================================
// PROXY DA API SECULLUM
//
// Por que existe: nem todo usuário do RH tem permissão de Integração Externa
// na Secullum (a API responde 400 "Operação não permitida"). O backend usa a
// conta de serviço do .env para ler/escrever, e o navegador nunca vê credencial
// nenhuma — ele se identifica com o JWT da aplicação.
//
// Rastreabilidade: como a Secullum atribui a autoria ao dono do token, todas as
// escritas sairiam com o nome da conta de serviço. Para não perder de vista quem
// realmente mexeu, o e-mail do usuário logado é gravado no campo Motivo.
// ==========================================

// Campo Motivo da Secullum: mantido curto para não estourar o limite da coluna.
const MOTIVO_MAX = 150;

function carimbarUsuario(body, usuario) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    if (!('Motivo' in body) || !usuario) return body;

    const base = String(body.Motivo || '').trim();
    const marca = ` [${usuario}]`;
    const espaco = MOTIVO_MAX - marca.length;

    body.Motivo = (base.length > espaco ? base.slice(0, espaco).trim() : base) + marca;
    return body;
}

async function chamarSecullum(caminho, { method = 'GET', bancoId, body }) {
    const url = `${SECULLUM_API_URL}${caminho}`;
    const headers = {
        'Authorization': `Bearer ${SECULLUM_TOKEN}`,
        'Content-Type': 'application/json'
    };
    if (bancoId) headers['secullumidbancoselecionado'] = String(bancoId);

    return fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

// GET - Empresas (bancos) visíveis pela conta de serviço
app.get('/api/secullum/bancos', async (req, res) => {
    if (!SECULLUM_TOKEN) {
        return res.status(503).json({ error: 'Token Secullum indisponível. Tente novamente em instantes.' });
    }

    try {
        const response = await fetch(`${SECULLUM_AUTH_URL.replace('/Token', '')}/ContasSecullumExterno/ListarBancos`, {
            headers: { 'Authorization': `Bearer ${SECULLUM_TOKEN}` }
        });

        if (response.status === 401) {
            await authenticateSecullum();
            return res.status(503).json({ error: 'Renovando sessão Secullum. Tente novamente.' });
        }

        if (!response.ok) {
            return res.status(response.status).json({ error: `Secullum respondeu ${response.status}` });
        }

        res.json(await response.json());
    } catch (err) {
        console.error('❌ Erro ao listar bancos:', err.message);
        res.status(502).json({ error: 'Falha ao consultar a Secullum' });
    }
});

// Somente os endpoints que o sistema realmente usa.
// A conta de serviço é administrativa: sem essa lista, qualquer usuário logado
// poderia alcançar qualquer rota da Secullum através do proxy.
const SECULLUM_PERMITIDOS = [
    { metodo: 'GET',  caminho: '/IntegracaoExterna/Batidas' },
    { metodo: 'GET',  caminho: '/IntegracaoExterna/Funcionarios' },
    { metodo: 'GET',  caminho: '/IntegracaoExterna/Justificativas' },
    { metodo: 'GET',  caminho: '/IntegracaoExterna/FonteDados' },
    { metodo: 'GET',  caminho: '/IntegracaoExterna/Equipamentos' },
    { metodo: 'GET',  caminho: '/IntegracaoExterna/Bancos' },
    { metodo: 'POST', caminho: '/IntegracaoExterna/CartaoPonto/Manual' },
    { metodo: 'POST', caminho: '/IntegracaoExterna/CartaoPonto/Troca' },
    { metodo: 'POST', caminho: '/IntegracaoExterna/CartaoPonto/Justificativa' }
];

function rotaPermitida(metodo, caminho) {
    return SECULLUM_PERMITIDOS.some(r => r.metodo === metodo && r.caminho === caminho);
}

// Proxy: tudo sob /api/secullum/ vira uma chamada à Secullum
app.all(/^\/api\/secullum\/(.+)/, async (req, res) => {
    if (!SECULLUM_TOKEN) {
        return res.status(503).json({ error: 'Token Secullum indisponível. Tente novamente em instantes.' });
    }

    const caminho = req.path.replace('/api/secullum', '');

    if (!rotaPermitida(req.method, caminho)) {
        console.warn(`🚫 Rota Secullum não permitida: ${req.method} ${caminho} (usuário ${req.user?.username})`);
        return res.status(403).json({ error: 'Endpoint não permitido' });
    }

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const bancoId = req.headers['secullumidbancoselecionado'];
    const escrita = req.method !== 'GET';

    // Só o e-mail do login vale como identidade — o cliente não escolhe quem assina.
    const usuario = req.user?.username;
    const corpo = escrita ? carimbarUsuario(req.body, usuario) : undefined;

    if (escrita) {
        console.log(`📝 ${usuario} -> ${req.method} ${caminho} (banco ${bancoId})`);
    }

    try {
        let response = await chamarSecullum(caminho + query, { method: req.method, bancoId, body: corpo });

        // Token de serviço expirado: renova uma vez e repete
        if (response.status === 401) {
            await authenticateSecullum();
            response = await chamarSecullum(caminho + query, { method: req.method, bancoId, body: corpo });
        }

        const texto = await response.text();
        res.status(response.status);

        try {
            res.json(JSON.parse(texto));
        } catch {
            res.send(texto); // Secullum às vezes responde vazio ou texto puro
        }
    } catch (err) {
        console.error(`❌ Erro no proxy Secullum (${caminho}):`, err.message);
        res.status(502).json({ error: 'Falha ao comunicar com a Secullum' });
    }
});

// GET - Obter configurações do Azure Vision (protegido)
app.get('/api/azure-vision-config', (req, res) => {
    res.json({
        apiKey: process.env.AZURE_VISION_KEY || '',
        endpoint: process.env.AZURE_VISION_ENDPOINT || 'https://testedeocr123.cognitiveservices.azure.com/'
    });
});

// ==========================================
// ENDPOINTS - COLABORADORES (PROTEGIDOS)
// ==========================================

// GET - Listar todos os colaboradores
app.get('/api/colaboradores', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query('SELECT * FROM COLABORADORES ORDER BY Nome');
        res.json(result.recordset);
    } catch (err) {
        console.error('Erro ao buscar colaboradores:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar colaborador por ID
app.get('/api/colaboradores/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query('SELECT * FROM COLABORADORES WHERE Id = @id');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Colaborador não encontrado' });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('❌ Erro ao buscar colaborador:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar colaborador por REG (número de registro)
app.get('/api/colaboradores/reg/:reg', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('reg', sql.VarChar, req.params.reg)
            .query('SELECT * FROM COLABORADORES WHERE Reg = @reg');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Colaborador não encontrado' });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('❌ Erro ao buscar colaborador:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar colaborador por CPF (para fazer match com Secullum)
app.get('/api/colaboradores/cpf/:cpf', async (req, res) => {
    try {
        const pool = await poolPromise;
        // Remove formatação do CPF (pontos e traços)
        const cpfLimpo = req.params.cpf.replace(/[^\d]/g, '');
        
        const result = await pool.request()
            .input('cpf', sql.VarChar, cpfLimpo)
            .query(`
                SELECT * FROM COLABORADORES 
                WHERE REPLACE(REPLACE(REPLACE(CPF, '.', ''), '-', ''), ' ', '') = @cpf
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Colaborador não encontrado' });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('❌ Erro ao buscar colaborador por CPF:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST - Buscar múltiplos colaboradores por CPFs (batch)
app.post('/api/colaboradores/batch-cpf', async (req, res) => {
    try {
        if (!sqlConnected) {
            return res.status(503).json({ 
                error: 'SQL Azure não conectado', 
                message: 'Verifique firewall ou conexão',
                data: [] 
            });
        }
        
        let { cpfs } = req.body; // Array de CPFs
        
        if (!cpfs || !Array.isArray(cpfs) || cpfs.length === 0) {
            return res.status(400).json({ error: 'Array de CPFs é obrigatório' });
        }
        
        // Limitar a 1000 CPFs por request (SQL Server limit)
        if (cpfs.length > 1000) {
            cpfs = cpfs.slice(0, 1000);
        }
        
        const pool = await poolPromise;
        
        // Limpar formatação dos CPFs
        const cpfsLimpos = cpfs
            .map(cpf => String(cpf).replace(/[^\d]/g, ''))
            .filter(cpf => cpf.length > 0);
        
        if (cpfsLimpos.length === 0) {
            return res.json([]);
        }
        
        // Criar a query com IN
        const placeholders = cpfsLimpos.map((_, index) => `@cpf${index}`).join(', ');
        
        const request = pool.request();
        cpfsLimpos.forEach((cpf, index) => {
            request.input(`cpf${index}`, sql.VarChar, cpf);
        });
        
        const result = await request.query(`
            SELECT * FROM COLABORADORES 
            WHERE REPLACE(REPLACE(REPLACE(CPF, '.', ''), '-', ''), ' ', '') IN (${placeholders})
        `);
        
        res.json(result.recordset);
    } catch (err) {
        console.error('Erro ao buscar colaboradores por CPFs:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST - Criar novo colaborador
app.post('/api/colaboradores', async (req, res) => {
    try {
        const { Reg, Nome, CPF, Empresa, Email, Telefone } = req.body;
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('Reg', sql.VarChar, Reg)
            .input('Nome', sql.VarChar, Nome)
            .input('CPF', sql.VarChar, CPF)
            .input('Empresa', sql.VarChar, Empresa)
            .input('Email', sql.VarChar, Email || null)
            .input('Telefone', sql.VarChar, Telefone || null)
            .query(`
                INSERT INTO COLABORADORES (Reg, Nome, CPF, Empresa, Email, Telefone)
                OUTPUT INSERTED.*
                VALUES (@Reg, @Nome, @CPF, @Empresa, @Email, @Telefone)
            `);
        
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        console.error('Erro ao criar colaborador:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT - Atualizar colaborador
app.put('/api/colaboradores/:id', async (req, res) => {
    try {
        const { Reg, Nome, CPF, Empresa, Email, Telefone } = req.body;
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .input('Reg', sql.VarChar, Reg)
            .input('Nome', sql.VarChar, Nome)
            .input('CPF', sql.VarChar, CPF)
            .input('Empresa', sql.VarChar, Empresa)
            .input('Email', sql.VarChar, Email || null)
            .input('Telefone', sql.VarChar, Telefone || null)
            .query(`
                UPDATE COLABORADORES
                SET Reg = @Reg,
                    Nome = @Nome,
                    CPF = @CPF,
                    Empresa = @Empresa,
                    Email = @Email,
                    Telefone = @Telefone
                OUTPUT INSERTED.*
                WHERE Id = @id
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Colaborador não encontrado' });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('Erro ao atualizar colaborador:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Deletar colaborador
app.delete('/api/colaboradores/:id', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query('DELETE FROM COLABORADORES WHERE Id = @id');
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ error: 'Colaborador não encontrado' });
        }
        
        res.json({ message: 'Colaborador deletado com sucesso' });
    } catch (err) {
        console.error('Erro ao deletar colaborador:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ENDPOINTS - ANEXOS (Azure Blob + SQL)
// ==========================================

// POST - Upload de anexo (imagem) - SEM AUTENTICAÇÃO JWT (usa apenas validação de dados)
app.post('/api/anexos/upload', async (req, res) => {
    try {
        let { reg, cpf, data, empresa_id, empresa_nome, funcionario_nome, imageBase64, motivo, ocr_texto, horarios, created_by, justificativa_secullum, justificativa_folha } = req.body;
        
        if (!cpf || !data || !imageBase64) {
            return res.status(400).json({ error: 'CPF, data e imagem são obrigatórios' });
        }
        
        // Normalizar data: remover timestamp se existir (2025-10-23T00:00:00 → 2025-10-23)
        if (data.includes('T')) {
            data = data.split('T')[0];
        }
        
        // Gerar nome único para o arquivo
        const timestamp = Date.now();
        const filename = `${reg}_${data}_${timestamp}.png`;
        
        // Converter base64 para buffer
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Upload pro Azure Blob
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        await blockBlobClient.uploadData(buffer, {
            blobHTTPHeaders: { blobContentType: 'image/png' }
        });
        
        const blobUrl = blockBlobClient.url.split('?')[0]; // URL sem SAS token
        
        // Salvar no SQL (usando REG + DATA + EMPRESA_ID como chave única)
        if (sqlConnected) {
            const pool = await poolPromise;
            const userName = created_by || 'Sistema'; // Usar created_by do frontend
            
            await pool.request()
                .input('cpf', sql.VarChar, cpf)
                .input('reg', sql.VarChar, reg)
                .input('data', sql.Date, data)
                .input('empresa_id', sql.Int, empresa_id)
                .input('empresa_nome', sql.VarChar, empresa_nome)
                .input('funcionario_nome', sql.VarChar, funcionario_nome)
                .input('blob_url', sql.VarChar, blobUrl)
                .input('blob_filename', sql.VarChar, filename)
                .input('motivo_detectado', sql.VarChar, motivo)
                .input('horarios_detectados', sql.NVarChar, JSON.stringify(horarios))
                .input('ocr_texto_completo', sql.NVarChar, ocr_texto)
                .input('perguntas_rh', sql.NVarChar, req.body.perguntas_rh || '{}')
                .input('created_by', sql.VarChar, userName)
                .input('justificativa_secullum', sql.VarChar, justificativa_secullum)
                .input('justificativa_folha', sql.VarChar, justificativa_folha)
                .query(`
                    IF EXISTS (SELECT 1 FROM ANEXOS WHERE reg = @reg AND data = @data AND empresa_id = @empresa_id)
                        UPDATE ANEXOS SET 
                            cpf = @cpf,
                            funcionario_nome = @funcionario_nome,
                            empresa_nome = @empresa_nome,
                            blob_url = @blob_url,
                            blob_filename = @blob_filename,
                            motivo_detectado = @motivo_detectado,
                            horarios_detectados = @horarios_detectados,
                            ocr_texto_completo = @ocr_texto_completo,
                            created_by = @created_by,
                            justificativa_secullum = @justificativa_secullum,
                            justificativa_folha = @justificativa_folha,
                            perguntas_rh = CASE 
                                WHEN @perguntas_rh != '{}' THEN @perguntas_rh 
                                ELSE COALESCE(perguntas_rh, '{}') 
                            END
                        WHERE reg = @reg AND data = @data AND empresa_id = @empresa_id
                    ELSE
                        INSERT INTO ANEXOS (cpf, reg, data, empresa_id, empresa_nome, funcionario_nome, blob_url, blob_filename, motivo_detectado, horarios_detectados, ocr_texto_completo, perguntas_rh, created_by, justificativa_secullum, justificativa_folha)
                        VALUES (@cpf, @reg, @data, @empresa_id, @empresa_nome, @funcionario_nome, @blob_url, @blob_filename, @motivo_detectado, @horarios_detectados, @ocr_texto_completo, @perguntas_rh, @created_by, @justificativa_secullum, @justificativa_folha)
                `);
        }
        
        res.json({ 
            success: true, 
            blobUrl,
            filename,
            motivo 
        });
        
    } catch (err) {
        console.error('❌ Erro ao fazer upload:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar anexos por data e empresa
app.get('/api/anexos/:data/:empresa_id', async (req, res) => {
    try {
        if (!sqlConnected) {
            return res.json([]);
        }
        
        let { data, empresa_id } = req.params;

        // Normalizar data: remover timestamp se existir (2025-10-23T00:00:00 → 2025-10-23)
        if (data.includes('T')) {
            data = data.split('T')[0];
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
            return res.status(400).json({ error: 'Formato de data inválido. Use YYYY-MM-DD' });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input('data', sql.Date, data)
            .input('empresa_id', sql.Int, empresa_id)
            .query(`
                SELECT * FROM ANEXOS 
                WHERE data = @data 
                AND (empresa_id = @empresa_id OR empresa_id = 0)
            `);
        
        res.json(result.recordset);
    } catch (err) {
        console.error('Erro ao buscar anexos:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar anexo específico por REG e Data
// Caminho com prefixo /reg/ para não colidir com /api/anexos/:data/:empresa_id acima
// (ambas eram rotas de 2 segmentos e a primeira capturava todas as requisições).
app.get('/api/anexos/reg/:reg/:data', async (req, res) => {
    try {
        if (!sqlConnected || !poolPromise) {
            return res.status(404).json({ error: 'Anexo não encontrado' });
        }
        
        let { reg, data } = req.params;
        
        // Normalizar data: remover timestamp se existir
        if (data.includes('T')) {
            data = data.split('T')[0];
        }
        
        // Validar formato de data (YYYY-MM-DD)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
            return res.status(400).json({ error: 'Formato de data inválido. Use YYYY-MM-DD' });
        }
        
        const pool = await poolPromise;
        const result = await pool.request()
            .input('reg', sql.VarChar, reg)
            .input('data', sql.Date, data)
            .query('SELECT * FROM ANEXOS WHERE reg = @reg AND data = @data');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Anexo não encontrado' });
        }
        
        res.json(result.recordset[0]);
    } catch (err) {
        console.error('❌ Erro ao buscar anexo:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT - Atualizar APENAS as perguntas de um anexo (usando CPF + DATA) - PROTEGIDO
app.put('/api/anexos/:cpf/:data/questions', async (req, res) => {
    try {
        if (!sqlConnected || !poolPromise) {
            return res.status(503).json({ error: 'SQL não conectado' });
        }
        
        let { cpf, data } = req.params;
        const { perguntas_rh, reg, empresa_id, empresa_nome, funcionario_nome } = req.body;
        
        // Normalizar data
        if (data.includes('T')) {
            data = data.split('T')[0];
        }
        
        const pool = await poolPromise;
        const userName = req.body.created_by || 'Sistema'; // Usar created_by do frontend
        
        // 🔑 UPSERT: Verificar se já existe registro
        const checkResult = await pool.request()
            .input('cpf', sql.VarChar, cpf)
            .input('data', sql.Date, data)
            .query('SELECT id FROM ANEXOS WHERE cpf = @cpf AND data = @data');
        
        if (checkResult.recordset.length > 0) {
            // ✅ JÁ EXISTE: Atualizar perguntas_rh
            const updateResult = await pool.request()
                .input('cpf', sql.VarChar, cpf)
                .input('data', sql.Date, data)
                .input('perguntas_rh', sql.NVarChar, perguntas_rh || '{}')
                .input('created_by', sql.VarChar, userName)
                .query(`
                    UPDATE ANEXOS 
                    SET perguntas_rh = @perguntas_rh,
                        created_by = @created_by
                    WHERE cpf = @cpf AND data = @data
                `);
            
            res.json({ success: true, action: 'updated', rowsAffected: updateResult.rowsAffected[0] });
            
        } else {
            // ✅ NÃO EXISTE: Criar registro vazio com apenas perguntas
            const insertResult = await pool.request()
                .input('cpf', sql.VarChar, cpf)
                .input('reg', sql.VarChar, reg)
                .input('data', sql.Date, data)
                .input('perguntas_rh', sql.NVarChar, perguntas_rh || '{}')
                .input('empresa_id', sql.Int, empresa_id || 0)
                .input('empresa_nome', sql.VarChar, empresa_nome || 'N/A')
                .input('funcionario_nome', sql.VarChar, funcionario_nome || 'N/A')
                .input('created_by', sql.VarChar, userName)
                .query(`
                    INSERT INTO ANEXOS (cpf, reg, data, perguntas_rh, empresa_id, empresa_nome, funcionario_nome, blob_url, blob_filename, created_by)
                    VALUES (@cpf, @reg, @data, @perguntas_rh, @empresa_id, @empresa_nome, @funcionario_nome, '', '', @created_by)
                `);
            
            res.json({ success: true, action: 'inserted', rowsAffected: insertResult.rowsAffected[0] });
        }
        
    } catch (err) {
        console.error('❌ Erro ao atualizar perguntas:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST - Buscar dados em batch (anexos, perguntas, IDs) por período - OTIMIZADO
app.post('/api/anexos/batch-period', async (req, res) => {
    try {
        if (!sqlConnected || !poolPromise) {
            return res.status(503).json({ error: 'SQL não conectado' });
        }

        const { dateStart, dateEnd, empresaIds } = req.body;

        if (!dateStart || !dateEnd) {
            return res.status(400).json({ error: 'dateStart e dateEnd são obrigatórios' });
        }

        const pool = await poolPromise;
        
        // 🚀 QUERY OTIMIZADA: 1 única chamada ao banco
        const request = pool.request()
            .input('dateStart', sql.Date, dateStart)
            .input('dateEnd', sql.Date, dateEnd);

        let query = `
            SELECT 
                id,
                cpf,
                reg,
                data,
                perguntas_rh,
                empresa_id,
                empresa_nome,
                funcionario_nome,
                blob_url,
                blob_filename,
                created_by,
                created_at
            FROM ANEXOS 
            WHERE data BETWEEN @dateStart AND @dateEnd
        `;

        // Adicionar filtro de empresas se fornecido (usando OR para múltiplos IDs)
        if (empresaIds && empresaIds.length > 0) {
            const conditions = empresaIds.map((id, index) => {
                const paramName = `empresaId${index}`;
                request.input(paramName, sql.Int, parseInt(id));
                return `empresa_id = @${paramName}`;
            }).join(' OR ');
            query += ` AND (${conditions})`;
        }

        query += ` ORDER BY data DESC, empresa_id, reg`;

        console.log('📊 Executando query batch:', { dateStart, dateEnd, empresaIds });
        const result = await request.query(query);

        // Processar resultados em estruturas organizadas
        const anexos = {};
        const perguntas = {};
        const aprovacoes = {};

        result.recordset.forEach(row => {
            const dataKey = row.data.toISOString().split('T')[0];
            const empresaId = row.empresa_id;
            
            // Organizar anexos por data e empresa
            if (!anexos[dataKey]) anexos[dataKey] = {};
            if (!anexos[dataKey][empresaId]) anexos[dataKey][empresaId] = [];
            
            anexos[dataKey][empresaId].push({
                id: row.id,
                cpf: row.cpf,
                reg: row.reg,
                data: dataKey,
                empresa_id: row.empresa_id,
                empresa_nome: row.empresa_nome,
                funcionario_nome: row.funcionario_nome,
                blob_url: row.blob_url,
                blob_filename: row.blob_filename,
                created_by: row.created_by,
                created_at: row.created_at
            });

            // Extrair perguntas se existirem
            if (row.perguntas_rh) {
                try {
                    const perguntasObj = JSON.parse(row.perguntas_rh);
                    const key = `${row.reg}_${dataKey}`;
                    perguntas[key] = perguntasObj;
                } catch (e) {
                    // Ignorar JSON inválido
                }
            }
        });

        // Retornar tudo de uma vez
        res.json({
            success: true,
            anexos: anexos,
            perguntas: perguntas,
            aprovacoes: aprovacoes,
            totalRecords: result.recordset.length
        });

    } catch (err) {
        console.error('❌ Erro ao buscar dados em batch:', err);
        console.error('Stack trace:', err.stack);
        res.status(500).json({ 
            error: err.message,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

// DELETE - Remover anexo
app.delete('/api/anexos/:id', async (req, res) => {
    try {
        if (!sqlConnected) {
            return res.status(503).json({ error: 'SQL não conectado' });
        }
        
        const pool = await poolPromise;
        
        // Buscar filename antes de deletar
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query('SELECT blob_filename FROM ANEXOS WHERE id = @id');
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Anexo não encontrado' });
        }
        
        const filename = result.recordset[0].blob_filename;
        
        // Deletar do Blob
        try {
            const blockBlobClient = containerClient.getBlockBlobClient(filename);
            await blockBlobClient.delete();
        } catch (err) {
            // Ignora erro se blob não existir
        }
        
        // Deletar do SQL
        await pool.request()
            .input('id', sql.Int, req.params.id)
            .query('DELETE FROM ANEXOS WHERE id = @id');
        
        res.json({ success: true });
        
    } catch (err) {
        console.error('❌ Erro ao deletar anexo:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET - Buscar colaboradores por empresa
app.get('/api/colaboradores/empresa/:empresa', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('empresa', sql.VarChar, req.params.empresa)
            .query('SELECT * FROM COLABORADORES WHERE Empresa = @empresa ORDER BY Nome');
        
        res.json(result.recordset);
    } catch (err) {
        console.error('Erro ao buscar colaboradores por empresa:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET - Testar conexão
app.get('/api/test', async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request().query('SELECT 1');
        res.json({ status: 'Conectado!', database: sqlConfig.database });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
// INICIALIZAÇÃO
// ==========================================

// GET - Monitor de equipamentos de ponto (SEM AUTENTICAÇÃO JWT - usa token Secullum)
app.get('/api/machine-monitor', async (req, res) => {
    try {
        const { bancoid, dataInicio: dataInicioParam, dataFim: dataFimParam } = req.query;
        
        if (!bancoid) {
            return res.status(400).json({ error: 'bancoid é obrigatório como query parameter' });
        }
        
        // Verificar se temos token Secullum ativo
        if (!SECULLUM_TOKEN) {
            console.error('❌ Token Secullum não disponível - aguarde autenticação');
            return res.status(503).json({ error: 'Serviço temporariamente indisponível', message: 'Aguarde alguns segundos e tente novamente' });
        }
        
        // PASSO 1: Buscar lista de equipamentos
        const equipResponse = await fetch('https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Equipamentos', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SECULLUM_TOKEN}`,
                'secullumidbancoselecionado': bancoid
            }
        });
        
        // Se 401, token expirou - não renovar aqui, aguardar timer automático
        if (equipResponse.status === 401) {
            console.error('❌ Token Secullum expirou (401) - aguarde renovação automática');
            return res.status(503).json({ error: 'Token temporariamente indisponível', message: 'Aguarde renovação automática' });
        }
        
        if (!equipResponse.ok) {
            throw new Error(`Equipamentos: HTTP ${equipResponse.status}`);
        }
        
        const equipamentos = await equipResponse.json();
        
        if (!Array.isArray(equipamentos) || equipamentos.length === 0) {
            return res.json([]);
        }
        
        // PASSO 2: Usar datas fornecidas ou padrão (últimos 90 dias)
        const dataFim = dataFimParam ? new Date(dataFimParam) : new Date();
        const dataInicio = dataInicioParam ? new Date(dataInicioParam) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        
        const machines = await Promise.all(equipamentos.map(async (equip) => {
            try {
                const equipId = equip.Id || equip.EquipamentoId || equip.id;
                const equipNome = equip.Descricao || equip.Nome || equip.descricao || `Equipamento ${equipId}`;
                
                // Buscar registros dos últimos 90 dias
                const fontUrl = `https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/FonteDados?equipamentoId=${equipId}&dataInicio=${dataInicio.toISOString().split('T')[0]}&dataFim=${dataFim.toISOString().split('T')[0]}`;
                
                const fontResponse = await fetch(fontUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SECULLUM_TOKEN}`,
                        'secullumidbancoselecionado': bancoid
                    }
                });
                
                let lastSync = null;
                let totalBatidas = 0;
                let lastSyncCount = 0;
                
                if (fontResponse.ok) {
                    const batidas = await fontResponse.json();
                    totalBatidas = Array.isArray(batidas) ? batidas.length : 0;
                    
                    if (totalBatidas > 0) {
                        // Ordenar por data DESC para pegar a mais recente
                        batidas.sort((a, b) => new Date(b.Data || b.data) - new Date(a.Data || a.data));
                        lastSync = batidas[0].Data || batidas[0].data;
                        
                        // Contar quantas batidas foram na MESMA data (mesma sincronização)
                        const lastSyncDate = new Date(lastSync).toISOString().split('T')[0];
                        lastSyncCount = batidas.filter(b => {
                            const bData = (b.Data || b.data || '').split('T')[0];
                            return bData === lastSyncDate;
                        }).length;
                    }
                }
                
                return {
                    id: equipId,
                    name: equipNome,
                    lastSync: lastSync || null,
                    totalBatidas: totalBatidas,
                    lastSyncCount: lastSyncCount,
                    ip: equip.EnderecoIP || 'N/A'
                };
                
            } catch (err) {
                return {
                    id: equip.Id,
                    name: equip.Descricao || equip.Nome || 'N/A',
                    lastSync: null,
                    totalBatidas: 0,
                    lastSyncCount: 0,
                    ip: equip.EnderecoIP || 'N/A'
                };
            }
        }));
        
        res.json(machines);
        
    } catch (err) {
        console.error('❌ Erro ao consultar equipamentos:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ENDPOINT - RELATÓRIO DE ESTATÍSTICAS
// ==========================================

// GET - Estatísticas de justificativas por período
app.get('/api/relatorio/estatisticas', async (req, res) => {
    try {
        if (!sqlConnected || !poolPromise) {
            return res.status(503).json({ error: 'SQL não conectado' });
        }

        const { dataInicio, dataFim } = req.query;

        if (!dataInicio || !dataFim) {
            return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios' });
        }

        const pool = await poolPromise;

        // Query 1: Totais gerais
        const totaisResult = await pool.request()
            .input('dataInicio', sql.Date, dataInicio)
            .input('dataFim', sql.Date, dataFim)
            .query(`
                SELECT 
                    COUNT(*) as total_enviadas,
                    SUM(CASE WHEN blob_url IS NOT NULL AND blob_url != '' THEN 1 ELSE 0 END) as total_retornadas,
                    SUM(CASE WHEN blob_url IS NULL OR blob_url = '' THEN 1 ELSE 0 END) as total_pendentes
                FROM ANEXOS 
                WHERE data BETWEEN @dataInicio AND @dataFim
            `);

        // Query 2: Estatísticas por empresa (agrupado apenas por empresa_id)
        const porEmpresaResult = await pool.request()
            .input('dataInicio', sql.Date, dataInicio)
            .input('dataFim', sql.Date, dataFim)
            .query(`
                SELECT 
                    empresa_id,
                    COUNT(*) as total_enviadas,
                    SUM(CASE WHEN blob_url IS NOT NULL AND blob_url != '' THEN 1 ELSE 0 END) as total_retornadas,
                    SUM(CASE WHEN blob_url IS NULL OR blob_url = '' THEN 1 ELSE 0 END) as total_pendentes
                FROM ANEXOS 
                WHERE data BETWEEN @dataInicio AND @dataFim
                GROUP BY empresa_id
                ORDER BY total_enviadas DESC
            `);

        // Query 3: Evolução temporal (por dia)
        const temporalResult = await pool.request()
            .input('dataInicio', sql.Date, dataInicio)
            .input('dataFim', sql.Date, dataFim)
            .query(`
                SELECT 
                    CONVERT(VARCHAR(10), data, 120) as data_formatada,
                    COUNT(*) as total_enviadas,
                    SUM(CASE WHEN blob_url IS NOT NULL AND blob_url != '' THEN 1 ELSE 0 END) as total_retornadas
                FROM ANEXOS 
                WHERE data BETWEEN @dataInicio AND @dataFim
                GROUP BY data
                ORDER BY data ASC
            `);

        const totais = totaisResult.recordset[0] || { total_enviadas: 0, total_retornadas: 0, total_pendentes: 0 };
        const taxaRetorno = totais.total_enviadas > 0 
            ? Math.round((totais.total_retornadas / totais.total_enviadas) * 100) 
            : 0;

        res.json({
            success: true,
            periodo: { dataInicio, dataFim },
            totais: {
                enviadas: totais.total_enviadas,
                retornadas: totais.total_retornadas,
                pendentes: totais.total_pendentes,
                taxaRetorno: taxaRetorno
            },
            porEmpresa: porEmpresaResult.recordset.map(row => ({
                empresaId: row.empresa_id,
                enviadas: row.total_enviadas,
                retornadas: row.total_retornadas,
                pendentes: row.total_pendentes,
                taxaRetorno: row.total_enviadas > 0 
                    ? Math.round((row.total_retornadas / row.total_enviadas) * 100) 
                    : 0
            })),
            evolucaoTemporal: temporalResult.recordset.map(row => ({
                data: row.data_formatada,
                enviadas: row.total_enviadas,
                retornadas: row.total_retornadas
            }))
        });

    } catch (err) {
        console.error('❌ Erro ao buscar estatísticas:', err);
        res.status(500).json({ error: err.message });
    }
});

// 🆔 SALVAR JUSTIFICATIVA PARA IMPRESSÃO
// Salva a justificativa no banco e retorna o ID auto-increment
app.post('/api/justificativa/salvar', async (req, res) => {
    try {
        const { cpf, reg, data, empresa_id, nome, motivo } = req.body;
        
        if (!cpf || !reg || !data) {
            return res.status(400).json({ error: 'CPF, REG e DATA são obrigatórios' });
        }

        // Normalizar CPF (remover pontuação)
        const cpfLimpo = cpf.replace(/[^\d]/g, '');
        
        // Normalizar data (converter DD/MM/YYYY para YYYY-MM-DD)
        let dataNormalizada;
        if (data.includes('/')) {
            const [dia, mes, ano] = data.split('/');
            dataNormalizada = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
        } else if (data.includes('T')) {
            dataNormalizada = data.split('T')[0];
        } else {
            dataNormalizada = data;
        }
        
        const pool = await poolPromise;
        
        // Verificar se já existe registro (usando REG + DATA + EMPRESA_ID, igual à constraint)
        const checkResult = await pool.request()
            .input('reg', sql.VarChar, reg)
            .input('data', sql.Date, dataNormalizada)
            .input('empresa_id', sql.Int, empresa_id || 0)
            .query('SELECT id FROM ANEXOS WHERE reg = @reg AND data = @data AND empresa_id = @empresa_id');
        
        if (checkResult.recordset.length > 0) {
            // Já existe, retorna o ID existente
            return res.json({
                id: checkResult.recordset[0].id,
                novo: false,
                mensagem: 'Registro já existe'
            });
        }
        
        // Não existe, inserir novo registro
        const insertResult = await pool.request()
            .input('cpf', sql.VarChar, cpfLimpo)
            .input('reg', sql.VarChar, reg)
            .input('data', sql.Date, dataNormalizada)
            .input('empresa_id', sql.Int, empresa_id || 0)
            .input('funcionario_nome', sql.NVarChar, nome || '')
            .input('blob_url', sql.NVarChar, '')
            .input('blob_filename', sql.NVarChar, '')
            .input('motivo_detectado', sql.NVarChar, motivo || '')
            .input('created_by', sql.VarChar, 'Sistema')
            .query(`
                INSERT INTO ANEXOS (cpf, reg, data, empresa_id, funcionario_nome, blob_url, blob_filename, motivo_detectado, created_by) 
                OUTPUT INSERTED.id
                VALUES (@cpf, @reg, @data, @empresa_id, @funcionario_nome, @blob_url, @blob_filename, @motivo_detectado, @created_by)
            `);
        
        const novoId = insertResult.recordset[0].id;
        
        res.json({
            id: novoId,
            novo: true,
            mensagem: 'Registro criado com sucesso'
        });
        
    } catch (err) {
        console.error('Erro ao salvar justificativa:', err.message);
        res.status(500).json({ error: 'Erro ao salvar justificativa', details: err.message });
    }
});

// 🚀 SALVAR JUSTIFICATIVAS EM BATCH
// Salva múltiplas justificativas de uma vez para evitar múltiplas conexões
app.post('/api/justificativa/salvar-batch', async (req, res) => {
    try {
        const { registros } = req.body; // Array de { cpf, reg, data, empresa_id, nome, motivo }
        
        if (!registros || !Array.isArray(registros) || registros.length === 0) {
            return res.status(400).json({ error: 'Array de registros é obrigatório' });
        }
        
        console.log(`📦 Salvando batch de ${registros.length} justificativas...`);
        
        const pool = await poolPromise;
        const resultados = [];
        const existentes = [];
        const novos = [];
        
        // Processar em uma única transação
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            for (const registro of registros) {
                const { cpf, reg, data, empresa_id, nome, motivo } = registro;
                
                if (!cpf || !reg || !data) {
                    resultados.push({ reg, data, error: 'CPF, REG e DATA são obrigatórios' });
                    continue;
                }
                
                // Normalizar CPF
                const cpfLimpo = cpf.replace(/[^\d]/g, '');
                
                // Normalizar data
                let dataNormalizada;
                if (data.includes('/')) {
                    const [dia, mes, ano] = data.split('/');
                    dataNormalizada = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
                } else if (data.includes('T')) {
                    dataNormalizada = data.split('T')[0];
                } else {
                    dataNormalizada = data;
                }
                
                // Verificar se já existe
                const checkResult = await transaction.request()
                    .input('reg', sql.VarChar, reg)
                    .input('data', sql.Date, dataNormalizada)
                    .input('empresa_id', sql.Int, empresa_id || 0)
                    .query('SELECT id FROM ANEXOS WHERE reg = @reg AND data = @data AND empresa_id = @empresa_id');
                
                if (checkResult.recordset.length > 0) {
                    // Já existe
                    const id = checkResult.recordset[0].id;
                    resultados.push({ reg, data: dataNormalizada, id, novo: false, nome });
                    existentes.push(nome);
                } else {
                    // Inserir novo
                    const insertResult = await transaction.request()
                        .input('cpf', sql.VarChar, cpfLimpo)
                        .input('reg', sql.VarChar, reg)
                        .input('data', sql.Date, dataNormalizada)
                        .input('empresa_id', sql.Int, empresa_id || 0)
                        .input('funcionario_nome', sql.NVarChar, nome || '')
                        .input('blob_url', sql.NVarChar, '')
                        .input('blob_filename', sql.NVarChar, '')
                        .input('motivo_detectado', sql.NVarChar, motivo || '')
                        .input('created_by', sql.VarChar, 'Sistema')
                        .query(`
                            INSERT INTO ANEXOS (cpf, reg, data, empresa_id, funcionario_nome, blob_url, blob_filename, motivo_detectado, created_by) 
                            OUTPUT INSERTED.id
                            VALUES (@cpf, @reg, @data, @empresa_id, @funcionario_nome, @blob_url, @blob_filename, @motivo_detectado, @created_by)
                        `);
                    
                    const novoId = insertResult.recordset[0].id;
                    resultados.push({ reg, data: dataNormalizada, id: novoId, novo: true, nome });
                    novos.push(nome);
                }
            }
            
            await transaction.commit();
            console.log(`✅ Batch concluído: ${novos.length} novos, ${existentes.length} existentes`);
            
            res.json({
                success: true,
                total: registros.length,
                novos: novos.length,
                existentes: existentes.length,
                resultados,
                nomesExistentes: existentes
            });
            
        } catch (transactionError) {
            await transaction.rollback();
            throw transactionError;
        }
        
    } catch (err) {
        console.error('❌ Erro ao salvar batch:', err.message);
        res.status(500).json({ error: 'Erro ao salvar batch de justificativas', details: err.message });
    }
});

// Buscar IDs de registros existentes por REG + DATA + EMPRESA_ID
app.post('/api/justificativa/buscar-ids', async (req, res) => {
    try {
        const { registros } = req.body; // Array de { reg, data, empresa_id }
        
        if (!registros || !Array.isArray(registros)) {
            return res.status(400).json({ error: 'Array de registros é obrigatório' });
        }
        
        const pool = await poolPromise;
        const ids = {};

        // Normaliza e descarta registros inválidos antes de ir ao banco
        const alvos = registros
            .map(({ reg, data, empresa_id }) => ({
                reg,
                data: normalizarData(data),
                empresa_id: parseInt(empresa_id) || 0
            }))
            .filter(r => r.reg && r.data);

        // Uma query por lote em vez de uma por registro.
        // SQL Server aceita ~2100 parâmetros; 3 por registro → lotes de 500 com folga.
        const TAMANHO_LOTE = 500;

        for (let i = 0; i < alvos.length; i += TAMANHO_LOTE) {
            const lote = alvos.slice(i, i + TAMANHO_LOTE);
            const request = pool.request();

            const condicoes = lote.map((alvo, idx) => {
                request.input(`reg${idx}`, sql.VarChar, alvo.reg);
                request.input(`data${idx}`, sql.Date, alvo.data);
                request.input(`emp${idx}`, sql.Int, alvo.empresa_id);
                return `(reg = @reg${idx} AND data = @data${idx} AND empresa_id = @emp${idx})`;
            }).join(' OR ');

            const result = await request.query(`
                SELECT id, reg, data, empresa_id FROM ANEXOS
                WHERE ${condicoes}
            `);

            result.recordset.forEach(row => {
                const dataKey = row.data.toISOString().split('T')[0];
                ids[`${row.reg}_${dataKey}_${row.empresa_id}`] = row.id;
            });
        }

        res.json({ ids });

    } catch (err) {
        console.error('Erro ao buscar IDs:', err.message);
        res.status(500).json({ error: 'Erro ao buscar IDs' });
    }
});

// ==========================================
// INICIALIZAÇÃO
// Só depois de TODAS as rotas estarem registradas.
// ==========================================
async function initServer() {
    await connectDB();
    initBlobStorage();
    await authenticateSecullum();

    app.listen(PORT, () => {
        console.log('\nServidor iniciado em http://localhost:' + PORT + '\n');
    });
}

initServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    try {
        if (poolPromise) {
            const pool = await poolPromise;
            await pool.close();
        }
    } catch (err) {
        // Ignora erros no shutdown
    }
    process.exit(0);
});