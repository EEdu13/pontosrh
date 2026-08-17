require('dotenv').config();

// POLYFILL para crypto no Node.js (necessário para @azure/storage-blob no Railway)
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = require('crypto').webcrypto;
}

const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const { BlobServiceClient, ContainerClient } = require('@azure/storage-blob');
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

// ==========================================
// IAM LARSIL — identidade única
// A identidade NÃO mora aqui: quem autentica é a IAM. Este sistema só valida o
// token dela e lê papéis/permissões/escopos. Ver INTEGRACAO.md.
// ==========================================
const IAM_URL = process.env.IAM_URL || 'https://painelgestor.up.railway.app';
const IAM_SISTEMA = process.env.IAM_SISTEMA || 'PONTORH';
const IAM_REGISTRY_KEY = process.env.IAM_REGISTRY_KEY || '';

// Exigir a permissão "pontorh.acesso" para entrar.
//
// Fica DESLIGADO por padrão durante a transição: o sistema acabou de ser
// registrado na IAM e, enquanto a TI não conceder a permissão aos papéis do RH,
// ligar isto trancaria todo mundo para fora. Assim que a concessão estiver
// feita, defina IAM_EXIGIR_ACESSO=true — sem isso, qualquer pessoa com conta na
// IAM entra no sistema de ponto.
const IAM_EXIGIR_ACESSO = process.env.IAM_EXIGIR_ACESSO === 'true';
const PERMISSAO_ACESSO = 'pontorh.acesso';

// URL do Painel PCP, que resolve a foto de perfil de qualquer pessoa por nome.
// A IAM não guarda foto (INTEGRACAO.md §5.3).
const PCP_URL = process.env.PCP_URL || 'https://gestao.up.railway.app';

// Cache das validações de token. Sem ele, toda requisição viraria um round-trip
// à IAM. TTL curto para que negar um acesso lá reflita aqui rapidamente.
const TTL_RESOLVE = 60 * 1000;
const cacheResolve = new Map(); // token -> { usuario, quando }

setInterval(() => {
    const agora = Date.now();
    for (const [t, v] of cacheResolve) {
        if (agora - v.quando > TTL_RESOLVE) cacheResolve.delete(t);
    }
}, TTL_RESOLVE).unref?.();

/**
 * Valida o token na IAM.
 *
 * Usa o modo remoto (INTEGRACAO.md §2-B): pergunta à IAM em vez de compartilhar
 * o JWT_SECRET dela. Assim mudança de permissão vale sem esperar o token expirar,
 * e não guardamos segredo de outro sistema aqui.
 */
async function resolverUsuario(token) {
    const cached = cacheResolve.get(token);
    if (cached && (Date.now() - cached.quando) < TTL_RESOLVE) return cached.usuario;

    const response = await fetch(`${IAM_URL}/api/auth/resolve`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        const corpo = await response.json().catch(() => ({}));
        const erro = new Error(corpo.erro || 'Token inválido');
        erro.status = response.status;
        erro.motivo = corpo.motivo;
        throw erro;
    }

    // O /resolve devolve acesso atualizado; o nome vem do próprio JWT.
    const acesso = await response.json();
    let identidade = {};
    try {
        identidade = jwt.decode(token) || {};
    } catch { /* token malformado cai no catch de quem chamou */ }

    const usuario = {
        username: identidade.login || acesso.login || '',
        login: identidade.login || '',
        nome: identidade.nome || '',
        cpf: identidade.cpf || null,
        admin: !!identidade.admin,
        papeis: acesso.papeis || identidade.papeis || [],
        permissoes: acesso.permissoes || identidade.permissoes || [],
        escopos: acesso.escopos || identidade.escopos || [],
        global: acesso.global ?? identidade.global ?? false
    };

    cacheResolve.set(token, { usuario, quando: Date.now() });
    return usuario;
}

// Middleware de autenticação
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    try {
        req.user = await resolverUsuario(token);
        req.token = token;

        if (IAM_EXIGIR_ACESSO && !(req.user.permissoes || []).includes(PERMISSAO_ACESSO)) {
            return res.status(403).json({
                error: 'Você não tem acesso ao sistema de ponto. Peça liberação à TI.'
            });
        }

        next();
    } catch (err) {
        // 403 + motivo INATIVO = conta desativada pela TI; o front mostra a mensagem.
        if (err.motivo === 'INATIVO') {
            return res.status(403).json({ error: err.message, motivo: 'INATIVO' });
        }
        return res.status(err.status === 403 ? 403 : 401).json({ error: 'Token inválido ou expirado' });
    }
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

        // A variável aceita DOIS formatos, e o SDK só entende um deles:
        //   1. connection string  -> DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...
        //   2. URL SAS do container -> https://conta.blob.core.windows.net/container?sp=...&sig=...
        // O formato (2) fazia fromConnectionString() lançar "Invalid URL", o
        // containerClient ficava undefined e todo upload quebrava com
        // "Cannot read properties of undefined (reading 'getBlockBlobClient')".
        if (/^https?:\/\//i.test(AZURE_STORAGE_CONNECTION_STRING.trim())) {
            const sas = new URL(AZURE_STORAGE_CONNECTION_STRING.trim());
            const container = sas.pathname.replace(/^\/+|\/+$/g, '') || CONTAINER_NAME;

            // A URL já aponta para o container; o cliente é construído direto dela
            containerClient = new ContainerClient(AZURE_STORAGE_CONNECTION_STRING.trim());
            console.log(`✅ Azure Blob conectado por URL SAS (container: ${container})`);
        } else {
            blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            console.log('✅ Azure Blob Storage conectado');
        }
    } catch (err) {
        containerClient = null;
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
        await garantirColunasAnexo();
    } catch (err) {
        sqlConnected = false;
        console.error('Erro ao conectar SQL Azure:', err.message);
    }
}

/**
 * Gerar e anexar são duas ações, de duas pessoas diferentes: uma imprime o
 * formulário, outra recebe o papel assinado e anexa a foto. As duas gravavam
 * em created_by, e o upload apagava quem tinha gerado.
 *
 * Estas colunas são novas e opcionais — nenhuma linha existente muda de valor,
 * e as antigas ficam com anexado_por nulo (não dá para saber quem foi).
 */
async function garantirColunasAnexo() {
    try {
        const pool = await poolPromise;
        await pool.request().query(`
            IF COL_LENGTH('ANEXOS', 'anexado_por') IS NULL
                ALTER TABLE ANEXOS ADD anexado_por VARCHAR(255) NULL;
        `);
        await pool.request().query(`
            IF COL_LENGTH('ANEXOS', 'anexado_em') IS NULL
                ALTER TABLE ANEXOS ADD anexado_em DATETIME NULL;
        `);
        console.log('✅ Colunas de autoria do anexo verificadas (anexado_por / anexado_em)');
    } catch (err) {
        // Sem permissão de ALTER a tela ainda funciona: a coluna some, o resto fica
        console.warn('⚠️ Não foi possível garantir anexado_por/anexado_em:', err.message);
    }
}

// ==========================================
// PROTEÇÃO GLOBAL DA API
// Tudo sob /api exige JWT, exceto as rotas listadas aqui.
// Vale para rotas futuras também — não há como esquecer de proteger uma.
// ==========================================
const PUBLIC_API_PATHS = new Set([
    '/auth/login',
    '/auth/logout',
    '/config'      // só URLs públicas; a tela de login precisa antes de autenticar
]);

app.use('/api', (req, res, next) => {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    return authenticateToken(req, res, next);
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// GET - Configuração pública (sem segredo). A tela de login precisa da URL de
// fotos antes de existir token, para mostrar o avatar enquanto a pessoa digita.
app.get('/api/config', (req, res) => {
    res.json({ fotoBaseUrl: `${PCP_URL}/api/foto`, sistema: IAM_SISTEMA });
});

// POST - Login (delegado à IAM Larsil)
// Este sistema NÃO tem tabela de usuário nem compara senha. Ele repassa para a
// IAM e devolve o token dela ao navegador. Ver INTEGRACAO.md §1.
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        // Aceita { login, senha } (padrão IAM) e { username, password } (formato antigo)
        const login = req.body.login || req.body.username;
        const senha = req.body.senha || req.body.password;

        if (!login || !senha) {
            return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
        }

        const authResponse = await fetch(`${IAM_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: String(login).trim(), senha })
        });

        const dados = await authResponse.json().catch(() => ({}));

        if (!authResponse.ok) {
            // 403 + INATIVO: a conta existe, a TI desativou. A mensagem é para o usuário ler.
            if (authResponse.status === 403) {
                return res.status(403).json({ error: dados.erro || 'Conta desativada.', motivo: dados.motivo });
            }
            return res.status(401).json({ error: dados.erro || 'Usuário ou senha inválidos.' });
        }

        const usuario = dados.usuario || {};

        if (IAM_EXIGIR_ACESSO && !(usuario.permissoes || []).includes(PERMISSAO_ACESSO)) {
            return res.status(403).json({
                error: 'Você não tem acesso ao sistema de ponto. Peça liberação à TI.'
            });
        }

        // Registra no perfil da pessoa que ela entrou NESTE sistema.
        // Fire-and-forget: se a IAM não responder, o login não pode falhar por isso.
        fetch(`${IAM_URL}/api/auth/acesso`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dados.token}` },
            body: JSON.stringify({ sistema: IAM_SISTEMA })
        }).catch(() => {});

        res.json({
            success: true,
            token: dados.token,
            senha_provisoria: !!dados.senha_provisoria,
            user: {
                login: usuario.login,
                username: usuario.login,
                nome: usuario.nome,
                name: usuario.nome,
                cpf: usuario.cpf || null,
                email: usuario.email || null,
                admin: !!usuario.admin,
                papeis: usuario.papeis || [],
                permissoes: usuario.permissoes || [],
                escopos: usuario.escopos || [],
                global: !!usuario.global
            }
        });

    } catch (err) {
        console.error('Erro no login:', err.message);
        res.status(502).json({ error: 'Não foi possível falar com o servidor de identidade (IAM).' });
    }
});

// GET - Verificar token / reconsultar acesso
// Chamado a cada carregamento: assim, liberar ou negar uma tela no console da IAM
// passa a valer no próximo F5, sem exigir novo login.
app.get('/api/auth/verify', (req, res) => {
    res.json({
        success: true,
        user: req.user,
        fotoBaseUrl: `${PCP_URL}/api/foto`
    });
});

// POST - Primeiro acesso: troca a senha provisória (INTEGRACAO.md §4)
app.post('/api/auth/onboarding', async (req, res) => {
    try {
        const { novaSenha, telefone, email } = req.body;

        if (!novaSenha) {
            return res.status(400).json({ error: 'Nova senha é obrigatória' });
        }

        const response = await fetch(`${IAM_URL}/api/auth/onboarding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${req.token}` },
            body: JSON.stringify({ novaSenha, telefone, email })
        });

        const dados = await response.json().catch(() => ({}));
        if (!response.ok) {
            return res.status(response.status).json({ error: dados.erro || 'Não foi possível concluir.' });
        }

        // A senha mudou: o acesso em cache não vale mais
        cacheResolve.delete(req.token);
        res.json({ ok: true });

    } catch (err) {
        console.error('Erro no onboarding:', err.message);
        res.status(502).json({ error: 'Falha ao falar com a IAM' });
    }
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

// ==========================================
// OCR DA JUSTIFICATIVA — Claude vision
//
// A leitura roda no BACKEND. A chave da Anthropic nunca vai para o navegador
// (foi assim que a chave do Azure Vision acabou exposta num endpoint público).
//
// Modelo: Haiku por padrão — é o mais barato da linha e dá conta de um
// formulário impresso com poucos campos manuscritos. Trocável por CLAUDE_OCR_MODEL.
// ==========================================
const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_OCR_MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-haiku-4-5';

// O `fetch` vai explícito: o SDK procura `globalThis.fetch`, que só existe a
// partir do Node 18. O `fetch` deste arquivo é o node-fetch do require lá em
// cima — de escopo do módulo, invisível para o SDK. Sem isto o processo morre
// na subida, antes de servir a primeira página (foi o que aconteceu no Railway,
// que rodava Node 16).
const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch })
    : null;

// O formulário tem campos fixos; pedir JSON com esquema evita ter de
// interpretar texto livre no frontend (era o que o parser do Azure fazia,
// com dezenas de regex).
const ESQUEMA_OCR = {
    type: 'object',
    properties: {
        // Primeira pergunta: isso é mesmo o formulário? Sem essa checagem qualquer
        // foto (selfie, print de conversa, documento errado) virava anexo de ponto.
        ehFormulario: {
            type: 'boolean',
            description: 'true SOMENTE se a imagem for o formulário "PONTO MANUAL COMPLEMENTAR AO PONTO ELETRÔNICO" da Larsil.'
        },
        oQueE: {
            type: ['string', 'null'],
            description: 'Se ehFormulario for false, descreva em poucas palavras o que a imagem realmente mostra. Caso contrário, null.'
        },
        id: { type: ['string', 'null'], description: 'Número após "ID IMP:" no cabeçalho. null se ilegível.' },
        // enum não pode conviver com type união (['string','null']) — o schema
        // é recusado com 400. A forma aceita é anyOf.
        motivo: {
            description: 'Justificativa marcada com X ou círculo. null se nenhuma.',
            anyOf: [
                {
                    type: 'string',
                    enum: [
                        'Esqueceu de registrar o Ponto', 'Falha no App', 'Falta', 'Folga',
                        'Hora Parada', 'Maquina Ponto com defeito',
                        'Registro em duplicidade', 'Registro indevido'
                    ]
                },
                { type: 'null' }
            ]
        },
        ent1: { type: ['string', 'null'], description: 'Entrada 1 manuscrita, formato HH:MM. null se vazio ou já impresso como batido.' },
        sai1: { type: ['string', 'null'], description: 'Saída 1 manuscrita, HH:MM.' },
        ent2: { type: ['string', 'null'], description: 'Entrada 2 manuscrita, HH:MM.' },
        sai2: { type: ['string', 'null'], description: 'Saída 2 manuscrita, HH:MM.' },
        ent3: { type: ['string', 'null'], description: 'Entrada 3 manuscrita, HH:MM.' },
        sai3: { type: ['string', 'null'], description: 'Saída 3 manuscrita, HH:MM.' },
        // A ordem das propriedades importa: a evidência vem ANTES do booleano,
        // então o modelo precisa descrever o que viu na linha antes de decidir.
        // Foi o que acabou com o falso "assinado" causado pelo nome impresso.
        assinaturas: {
            type: 'object',
            properties: {
                // Evidência em 3-5 palavras: o suficiente para forçar a olhada
                // antes de decidir, sem gastar tempo de geração. Descrições
                // longas custavam ~40 tokens de saída por leitura.
                funcionarioEvidencia: {
                    type: 'string',
                    description: 'Máximo 5 palavras: o que existe SOBRE a linha do FUNCIONÁRIO. Ex.: "linha limpa" ou "rabisco azul sobre a linha".'
                },
                funcionario: { type: 'boolean', description: 'true só se a evidência descreve tinta manuscrita sobre a linha.' },
                liderEvidencia: {
                    type: 'string',
                    description: 'Máximo 5 palavras, idem para a linha do Líder.'
                },
                lider: { type: 'boolean', description: 'true só se a evidência descreve tinta manuscrita sobre a linha.' }
            },
            required: ['funcionarioEvidencia', 'funcionario', 'liderEvidencia', 'lider'],
            additionalProperties: false
        },
        confianca: {
            type: 'object',
            description: 'Confiança de 0 a 100 por campo lido.',
            properties: {
                id: { type: 'number' }, motivo: { type: 'number' },
                ent1: { type: 'number' }, sai1: { type: 'number' },
                ent2: { type: 'number' }, sai2: { type: 'number' },
                ent3: { type: 'number' }, sai3: { type: 'number' }
            },
            required: ['id', 'motivo', 'ent1', 'sai1', 'ent2', 'sai2', 'ent3', 'sai3'],
            additionalProperties: false
        }
    },
    required: [
        'ehFormulario', 'oQueE',
        'id', 'motivo', 'ent1', 'sai1', 'ent2', 'sai2', 'ent3', 'sai3',
        'assinaturas', 'confianca'
    ],
    additionalProperties: false
};

const INSTRUCOES_OCR = `Você lê fotos de um formulário de ponto da Larsil, preenchido à mão pelo colaborador.

O formulário tem, de cima para baixo:
- Título "PONTO MANUAL COMPLEMENTAR AO PONTO ELETRÔNICO" com o logotipo LARSIL à esquerda
- Cabeçalho com Nome, Empresa, Data, REG, Projeto e "ID IMP: <número>"
- Uma faixa "Horários (preencher somente os que faltaram)" com pares Entrada/Saída.
  Horários JÁ REGISTRADOS aparecem impressos com o selo "BATIDO" embaixo.
  Horários A PREENCHER aparecem como campos vazios "__:__" que o colaborador escreve à mão.
- Uma faixa "JUSTIFICATIVA (marque o motivo)" com opções e um círculo/quadrado ao lado de cada
- Duas linhas de assinatura no rodapé: FUNCIONÁRIO à esquerda, Líder à direita

PASSO 1 — é o formulário?
Antes de qualquer leitura, confirme que a imagem é ESTE formulário: título, faixa de
Horários e faixa de JUSTIFICATIVA precisam estar visíveis. Foto de pessoa, print de
conversa, atestado, holerite, crachá, documento de outro tipo, foto desfocada demais
para identificar o título ou pedaço solto do formulário sem o cabeçalho → ehFormulario
= false, descreva em oQueE o que a imagem mostra e devolva todos os demais campos null
ou false. Nesse caso NÃO tente adivinhar horário nenhum.

PASSO 2 — leitura (só se ehFormulario for true):
- Devolva APENAS o que foi escrito À MÃO nos campos vazios. Um horário impresso com selo
  "BATIDO" já está no sistema — devolva null para ele, senão ele seria reenviado em duplicidade.
- Horários sempre em HH:MM com 24 horas. "7h", "07 00" e "7:00" viram "07:00".
- Motivo é o que está marcado com X, traço ou círculo. Nenhum marcado: null.
- Se um campo estiver ilegível ou em dúvida, devolva null e uma confiança baixa.
  Um campo em branco é melhor do que um horário errado no ponto de alguém.

PASSO 3 — assinaturas (leia com atenção, é onde mais se erra):
Abaixo de cada linha de assinatura o formulário JÁ VEM com texto impresso: o nome do
colaborador em letra de fôrma e a legenda "Assinatura do FUNCIONÁRIO" / "Assinatura do
Líder". Esse texto faz parte do formulário em branco e NÃO é assinatura.

Para cada uma das duas linhas, primeiro descreva em "evidência" o que existe SOBRE a
própria linha horizontal — e só então responda o booleano, coerente com o que descreveu.
- Nada sobre a linha, apenas o nome e a legenda impressos abaixo dela → false.
- Traço manuscrito, cursivo, irregular, frequentemente em cor de caneta diferente do
  preto impresso, escrito sobre ou cruzando a linha → true.
Na dúvida, false: dizer que alguém assinou quando não assinou é o pior erro possível aqui.`;

// POST - Ler a justificativa anexada
app.post('/api/ocr/justificativa', async (req, res) => {
    if (!anthropic) {
        return res.status(503).json({ error: 'OCR não configurado no servidor (ANTHROPIC_API_KEY ausente).' });
    }

    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'imageBase64 é obrigatório' });
        }

        const m = String(imageBase64).match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i);
        if (!m) {
            return res.status(400).json({ error: 'Formato de imagem inválido' });
        }

        const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
        const dados = m[2];

        // ~5MB de imagem já é bastante para um A4; acima disso o custo sobe à toa
        if ((dados.length * 3 / 4) > 5 * 1024 * 1024) {
            return res.status(413).json({ error: 'Imagem muito grande. Reduza para até 5MB.' });
        }

        const inicio = Date.now();
        const resposta = await anthropic.messages.create({
            model: CLAUDE_OCR_MODEL,
            // A resposta inteira cabe em ~200 tokens; 2048 era teto de sobra
            max_tokens: 600,
            system: INSTRUCOES_OCR,
            output_config: { format: { type: 'json_schema', schema: ESQUEMA_OCR } },
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: dados } },
                    { type: 'text', text: 'Leia este formulário e devolva os campos preenchidos à mão.' }
                ]
            }]
        });

        if (resposta.stop_reason === 'refusal') {
            return res.status(422).json({ error: 'Não foi possível ler esta imagem.' });
        }

        const bloco = resposta.content.find(b => b.type === 'text');
        if (!bloco) {
            return res.status(502).json({ error: 'Resposta vazia do leitor' });
        }

        let dadosLidos;
        try {
            dadosLidos = JSON.parse(bloco.text);
        } catch {
            console.error('OCR devolveu JSON inválido:', bloco.text.slice(0, 300));
            return res.status(502).json({ error: 'Leitura inválida' });
        }

        const ms = Date.now() - inicio;
        console.log(`🔎 OCR ${CLAUDE_OCR_MODEL}: ${ms}ms | ${resposta.usage.input_tokens} in / ${resposta.usage.output_tokens} out | ${req.user?.username || ''}`);

        // Não é o formulário: recusa antes de deixar virar anexo. O `recusado`
        // diz ao frontend que isto é uma rejeição, não uma falha de leitura —
        // são tratamentos diferentes na tela.
        if (dadosLidos.ehFormulario === false) {
            console.warn(`🚫 Imagem recusada pelo OCR: ${dadosLidos.oQueE || 'não é o formulário'}`);
            return res.status(422).json({
                recusado: true,
                error: 'Esta imagem não é o formulário de ponto da Larsil.',
                detalhe: dadosLidos.oQueE || null
            });
        }

        const assin = dadosLidos.assinaturas || {};
        if (assin.funcionario || assin.lider) {
            console.log(`   assinaturas → funcionário: ${assin.funcionarioEvidencia} | líder: ${assin.liderEvidencia}`);
        }

        res.json({
            ...dadosLidos,
            // Achatado para o formato que a tela já consome
            assinaturaFuncionario: !!assin.funcionario,
            assinaturaLider: !!assin.lider,
            _meta: {
                modelo: CLAUDE_OCR_MODEL,
                ms,
                tokens: { entrada: resposta.usage.input_tokens, saida: resposta.usage.output_tokens },
                assinaturas: assin
            }
        });

    } catch (err) {
        console.error('❌ Erro no OCR:', err.message);
        if (err.status === 429) {
            return res.status(429).json({ error: 'Limite de leituras atingido. Aguarde alguns instantes.' });
        }
        res.status(502).json({ error: 'Falha ao ler a imagem' });
    }
});

// (removido) /api/azure-vision-config — entregava a chave do Azure Vision ao
// navegador. O OCR agora roda no servidor, em /api/ocr/justificativa.

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

/**
 * POST - Sobe só a imagem e devolve a URL.
 *
 * Existe para o navegador começar a subir a foto no mesmo instante em que a
 * leitura da IA começa, em vez de esperar o RH conferir e clicar em Confirmar.
 * Quando o clique chega, o arquivo já está no Blob e o Confirmar só grava a
 * linha — o tempo de upload sai do caminho da pessoa.
 */
app.post('/api/anexos/blob', async (req, res) => {
    try {
        const { reg, data, imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'imagem é obrigatória' });
        if (!containerClient) {
            return res.status(503).json({ error: 'Armazenamento de anexos indisponível.' });
        }

        const { blobUrl, filename } = await subirImagem(imageBase64, reg, data);
        res.json({ success: true, blobUrl, filename });

    } catch (err) {
        console.error('❌ Erro ao subir imagem:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** Grava a imagem no Blob e devolve URL e nome do arquivo. */
async function subirImagem(imageBase64, reg, data) {
    // O tipo vem da própria data URL: o navegador manda JPEG (a foto é
    // reduzida antes de subir), e gravar tudo como .png deixava o arquivo
    // com extensão e content-type que não batiam com o conteúdo.
    const tipo = (String(imageBase64).match(/^data:image\/(png|jpeg|jpg|webp)/i) || [, 'jpeg'])[1]
        .toLowerCase().replace('jpg', 'jpeg');

    const filename = `${reg || 'sem-reg'}_${String(data || '').split('T')[0]}_${Date.now()}`
        + `.${tipo === 'jpeg' ? 'jpg' : tipo}`;

    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    const blockBlobClient = containerClient.getBlockBlobClient(filename);
    await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: `image/${tipo}` }
    });

    return { blobUrl: blockBlobClient.url.split('?')[0], filename };
}

// POST - Upload de anexo (imagem) - SEM AUTENTICAÇÃO JWT (usa apenas validação de dados)
app.post('/api/anexos/upload', async (req, res) => {
    try {
        let { reg, cpf, data, empresa_id, empresa_nome, funcionario_nome, imageBase64, motivo, ocr_texto, horarios, created_by, justificativa_secullum, justificativa_folha,
              blobFilenamePronto } = req.body;

        // A imagem pode já ter subido em paralelo com a leitura da IA
        const jaSubiu = !!blobFilenamePronto;

        if (!cpf || !data || (!imageBase64 && !jaSubiu)) {
            return res.status(400).json({ error: 'CPF, data e imagem são obrigatórios' });
        }

        // Normalizar data: remover timestamp se existir (2025-10-23T00:00:00 → 2025-10-23)
        if (data.includes('T')) {
            data = data.split('T')[0];
        }

        if (!containerClient) {
            return res.status(503).json({
                error: 'Armazenamento de anexos indisponível. Verifique AZURE_STORAGE_CONNECTION_STRING no servidor.'
            });
        }

        // Se a imagem já subiu em paralelo com a leitura, reaproveita o arquivo:
        // o upload é a parte demorada, e repetir aqui é fazer o RH esperar duas
        // vezes.
        //
        // A URL NÃO vem do cliente — só o nome do arquivo, e ele é conferido
        // antes de virar endereço. O anexo é a prova documental da justificativa:
        // aceitar a URL como veio deixaria qualquer usuário logado apontar essa
        // prova para uma imagem de fora, ou para o anexo de outra pessoa.
        let blobUrl, filename;

        if (jaSubiu) {
            filename = String(blobFilenamePronto);

            // Sem barra, sem "..", sem query: só o nome que este servidor gera
            if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(filename)) {
                return res.status(400).json({ error: 'Nome de arquivo inválido' });
            }

            // O nome é gerado como reg_data_timestamp: exigir esse prefixo amarra
            // o arquivo à linha que está sendo gravada, então não dá para pendurar
            // o anexo de um colaborador no dia de outro.
            const prefixo = `${reg || 'sem-reg'}_${data}_`;
            if (!filename.startsWith(prefixo)) {
                console.warn(`🚫 Anexo recusado: "${filename}" não pertence a ${prefixo}`);
                return res.status(400).json({ error: 'Arquivo não corresponde a este registro' });
            }

            // E tem de existir de verdade no nosso container
            const cliente = containerClient.getBlockBlobClient(filename);
            if (!(await cliente.exists())) {
                return res.status(400).json({ error: 'Arquivo não encontrado no armazenamento' });
            }

            // A URL é derivada aqui, do nosso próprio container
            blobUrl = cliente.url.split('?')[0];

        } else {
            ({ blobUrl, filename } = await subirImagem(imageBase64, reg, data));
        }

        // Salvar no SQL (usando REG + DATA + EMPRESA_ID como chave única)
        if (sqlConnected) {
            const pool = await poolPromise;
            const userName = created_by || 'Sistema'; // Usar created_by do frontend

            // Sempre só dígitos. Este endpoint gravava o CPF como veio da tela
            // (com pontos e traço) enquanto a geração gravava limpo — o mesmo
            // colaborador acabava com duas grafias no banco, e qualquer junção
            // por CPF em SQL puro só enxergava metade das linhas dele.
            const cpfLimpo = String(cpf || '').replace(/[^\d]/g, '');

            await pool.request()
                .input('cpf', sql.VarChar, cpfLimpo)
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
                            -- created_by fica: é quem GEROU o formulário.
                            -- Anexar é outra ação, de outra pessoa.
                            anexado_por = @created_by,
                            anexado_em = GETDATE(),
                            justificativa_secullum = @justificativa_secullum,
                            justificativa_folha = @justificativa_folha,
                            perguntas_rh = CASE
                                WHEN @perguntas_rh != '{}' THEN @perguntas_rh
                                ELSE COALESCE(perguntas_rh, '{}')
                            END
                        WHERE reg = @reg AND data = @data AND empresa_id = @empresa_id
                    ELSE
                        -- Anexo sem geração prévia: a mesma pessoa fez as duas coisas
                        INSERT INTO ANEXOS (cpf, reg, data, empresa_id, empresa_nome, funcionario_nome, blob_url, blob_filename, motivo_detectado, horarios_detectados, ocr_texto_completo, perguntas_rh, created_by, anexado_por, anexado_em, justificativa_secullum, justificativa_folha)
                        VALUES (@cpf, @reg, @data, @empresa_id, @empresa_nome, @funcionario_nome, @blob_url, @blob_filename, @motivo_detectado, @horarios_detectados, @ocr_texto_completo, @perguntas_rh, @created_by, @created_by, GETDATE(), @justificativa_secullum, @justificativa_folha)
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

        // Só dígitos, igual ao que é gravado. Comparar o CPF como veio da URL
        // ("123.456.789-00") contra o do banco ("12345678900") nunca casava,
        // e o else abaixo criava uma linha nova em vez de atualizar a existente.
        cpf = String(cpf || '').replace(/[^\d]/g, '');
        
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
                    SET perguntas_rh = @perguntas_rh
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
                created_at,
                anexado_por,
                anexado_em
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
                created_at: row.created_at,
                anexado_por: row.anexado_por,
                anexado_em: row.anexado_em
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

// ==========================================
// RELATÓRIO ANALÍTICO
//
// Cruza ANEXOS com COLABORADORES pelo CPF para poder agrupar por projeto,
// líder, supervisor, coordenador, setor e área — nada disso existe em ANEXOS.
//
// O cadastro cobre ~57% das linhas (tem 468 pessoas; ANEXOS inclui gente de
// empresas que não estão nele). O que não casa vai para "sem cadastro" em vez
// de sumir da conta: um total que não fecha com a tela principal geraria mais
// dúvida do que a lacuna em si.
// ==========================================
/**
 * CPFs de quem já foi desligado, segundo a Secullum.
 *
 * Boa parte do "Sem cadastro" do relatório é justamente isso: a pessoa saiu da
 * empresa, sumiu do cadastro de colaboradores, mas as justificativas que ela
 * deixou em aberto continuam no banco. Separar os dois casos muda a leitura —
 * cobrar um pendente de quem já foi embora não faz sentido.
 *
 * A lista é grande e muda pouco, então fica em cache por 30 minutos.
 */
let cacheDemitidos = { quando: 0, cpfs: new Set(), erro: null };
const DEMITIDOS_TTL = 30 * 60 * 1000;

async function cpfsDemitidos() {
    if (Date.now() - cacheDemitidos.quando < DEMITIDOS_TTL && cacheDemitidos.cpfs.size) {
        return cacheDemitidos;
    }
    if (!SECULLUM_TOKEN) return cacheDemitidos;

    try {
        const bancos = await fetch(
            `${SECULLUM_AUTH_URL.replace('/Token', '')}/ContasSecullumExterno/ListarBancos`,
            { headers: { Authorization: `Bearer ${SECULLUM_TOKEN}` } }
        ).then(r => r.ok ? r.json() : []);

        const cpfs = new Set();

        // Em paralelo: uma empresa por vez levava minutos
        await Promise.all((bancos || []).map(async banco => {
            try {
                const r = await chamarSecullum('/IntegracaoExterna/Funcionarios', { bancoId: banco.id });
                if (!r.ok) return;
                for (const f of await r.json()) {
                    const saida = f.Demissao;
                    // A Secullum devolve 0001-01-01 para "sem demissão"
                    if (!saida || String(saida).startsWith('0001-01-01')) continue;
                    const cpf = String(f.Cpf || f.CPF || '').replace(/\D/g, '');
                    if (cpf.length === 11) cpfs.add(cpf);
                }
            } catch { /* uma empresa fora não invalida as demais */ }
        }));

        if (cpfs.size) {
            cacheDemitidos = { quando: Date.now(), cpfs, erro: null };
            console.log(`👥 Demitidos em cache: ${cpfs.size} CPFs`);
        }
    } catch (err) {
        cacheDemitidos.erro = err.message;
        console.warn('⚠️ Não foi possível listar demitidos:', err.message);
    }

    return cacheDemitidos;
}

const CAMPOS_AGRUPAMENTO = {
    projeto:     'c.PROJETO',
    projeto_rh:  'c.PROJETO_RH',
    lider:       'c.NOME_LIDER',
    supervisor:  'c.SUPERVISOR',
    coordenador: 'c.COORDENADOR',
    setor:       'c.SETOR',
    area:        'c.AREA',
    funcao:      'c.FUNCAO',
    empresa:     'a.empresa_nome',
    motivo:      'a.motivo_detectado'
};

app.get('/api/relatorio/analitico', async (req, res) => {
    try {
        if (!sqlConnected || !poolPromise) {
            return res.status(503).json({ error: 'SQL não conectado' });
        }

        const { dataInicio, dataFim } = req.query;
        if (!dataInicio || !dataFim) {
            return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios' });
        }

        const pool = await poolPromise;

        // Filtros opcionais. Cada um vira um AND parametrizado — nada de
        // concatenar valor do usuário dentro do SQL.
        const filtros = [];
        const parametros = {};
        for (const [chave, coluna] of Object.entries(CAMPOS_AGRUPAMENTO)) {
            const valor = req.query[chave];
            if (valor && String(valor).trim()) {
                filtros.push(`${coluna} = @f_${chave}`);
                parametros[`f_${chave}`] = String(valor).trim();
            }
        }
        if (req.query.situacao === 'ativos') filtros.push(`c.SITUACAO = '1'`);
        if (req.query.pendentes === '1') filtros.push(`a.blob_url = ''`);

        const onde = filtros.length ? ' AND ' + filtros.join(' AND ') : '';

        const pedido = () => {
            const r = pool.request()
                .input('dataInicio', sql.Date, dataInicio)
                .input('dataFim', sql.Date, dataFim);
            for (const [nome, valor] of Object.entries(parametros)) {
                r.input(nome, sql.NVarChar, valor);
            }
            return r;
        };

        // Base reaproveitada por todos os recortes
        const BASE = `
            FROM dbo.ANEXOS a
            LEFT JOIN dbo.COLABORADORES c
                   ON REPLACE(REPLACE(c.CPF, '.', ''), '-', '') = a.cpf
            WHERE a.data BETWEEN @dataInicio AND @dataFim ${onde}`;

        const DEVOLVIDA = `CASE WHEN a.blob_url <> '' THEN 1 ELSE 0 END`;

        // Um recorte agrupado por qualquer coluna do cadastro.
        // O CAST é necessário: sem ele o ISNULL herda o tamanho da coluna
        // (PROJETO é varchar(10)) e 'Sem cadastro' chegava cortado como
        // "Sem cadast" no gráfico.
        const porCampo = (coluna, rotulo) => {
            const expr = `ISNULL(NULLIF(LTRIM(RTRIM(CAST(${coluna} AS nvarchar(200)))), ''), 'Sem cadastro')`;
            return pedido().query(`
                SELECT TOP 40
                    ${expr} AS rotulo,
                    COUNT(*) AS geradas,
                    SUM(${DEVOLVIDA}) AS devolvidas,
                    COUNT(*) - SUM(${DEVOLVIDA}) AS pendentes,
                    CAST(100.0 * SUM(${DEVOLVIDA}) / COUNT(*) AS decimal(5,1)) AS taxa
                ${BASE}
                GROUP BY ${expr}
                ORDER BY COUNT(*) DESC
            `).then(r => ({ [rotulo]: r.recordset }));
        };

        const [
            totais, temporal, ranking, foraDoCadastro, opcoes,
            ...recortes
        ] = await Promise.all([
            pedido().query(`
                SELECT COUNT(*) geradas,
                       SUM(${DEVOLVIDA}) devolvidas,
                       COUNT(*) - SUM(${DEVOLVIDA}) pendentes,
                       COUNT(DISTINCT a.cpf) pessoas,
                       SUM(CASE WHEN c.CPF IS NULL THEN 1 ELSE 0 END) sem_cadastro
                ${BASE}`).then(r => r.recordset[0]),

            pedido().query(`
                SELECT CONVERT(varchar(10), a.data, 120) dia,
                       COUNT(*) geradas, SUM(${DEVOLVIDA}) devolvidas
                ${BASE}
                GROUP BY a.data ORDER BY a.data`).then(r => r.recordset),

            // Ranking: quem mais recebeu formulário e menos devolveu
            pedido().query(`
                SELECT TOP 50
                    a.cpf,
                    MAX(a.funcionario_nome) nome,
                    MAX(a.reg) reg,
                    MAX(ISNULL(c.PROJETO, '')) projeto,
                    MAX(ISNULL(c.NOME_LIDER, '')) lider,
                    MAX(ISNULL(c.SUPERVISOR, '')) supervisor,
                    MAX(ISNULL(a.empresa_nome, '')) empresa,
                    COUNT(*) geradas,
                    SUM(${DEVOLVIDA}) devolvidas,
                    COUNT(*) - SUM(${DEVOLVIDA}) pendentes,
                    CAST(100.0 * (COUNT(*) - SUM(${DEVOLVIDA})) / COUNT(*) AS decimal(5,1)) pct_pendente,
                    CONVERT(varchar(10), MAX(a.data), 120) ultima
                ${BASE}
                GROUP BY a.cpf
                HAVING COUNT(*) - SUM(${DEVOLVIDA}) > 0
                ORDER BY COUNT(*) - SUM(${DEVOLVIDA}) DESC, COUNT(*) DESC`).then(r => r.recordset),

            // Quem está fora do cadastro — para cruzar com a lista de demitidos
            pedido().query(`
                SELECT a.cpf,
                       MAX(a.funcionario_nome) nome,
                       MAX(a.reg) reg,
                       COUNT(*) geradas,
                       SUM(${DEVOLVIDA}) devolvidas
                ${BASE} AND c.CPF IS NULL
                GROUP BY a.cpf`).then(r => r.recordset),

            // Valores possíveis para os seletores de filtro, dentro do período
            pedido().query(`
                SELECT DISTINCT 'projeto' campo, LTRIM(RTRIM(c.PROJETO)) valor ${BASE} AND NULLIF(LTRIM(RTRIM(c.PROJETO)),'') IS NOT NULL
                UNION SELECT DISTINCT 'lider', LTRIM(RTRIM(c.NOME_LIDER)) ${BASE} AND NULLIF(LTRIM(RTRIM(c.NOME_LIDER)),'') IS NOT NULL
                UNION SELECT DISTINCT 'supervisor', LTRIM(RTRIM(c.SUPERVISOR)) ${BASE} AND NULLIF(LTRIM(RTRIM(c.SUPERVISOR)),'') IS NOT NULL
                UNION SELECT DISTINCT 'coordenador', LTRIM(RTRIM(c.COORDENADOR)) ${BASE} AND NULLIF(LTRIM(RTRIM(c.COORDENADOR)),'') IS NOT NULL
                UNION SELECT DISTINCT 'setor', LTRIM(RTRIM(c.SETOR)) ${BASE} AND NULLIF(LTRIM(RTRIM(c.SETOR)),'') IS NOT NULL
                UNION SELECT DISTINCT 'area', LTRIM(RTRIM(c.AREA)) ${BASE} AND NULLIF(LTRIM(RTRIM(c.AREA)),'') IS NOT NULL
                UNION SELECT DISTINCT 'empresa', LTRIM(RTRIM(a.empresa_nome)) ${BASE} AND NULLIF(LTRIM(RTRIM(a.empresa_nome)),'') IS NOT NULL
                UNION SELECT DISTINCT 'motivo', LTRIM(RTRIM(a.motivo_detectado)) ${BASE} AND NULLIF(LTRIM(RTRIM(a.motivo_detectado)),'') IS NOT NULL
                ORDER BY campo, valor`).then(r => r.recordset),

            porCampo('c.PROJETO', 'porProjeto'),
            porCampo('c.NOME_LIDER', 'porLider'),
            porCampo('c.SUPERVISOR', 'porSupervisor'),
            porCampo('c.COORDENADOR', 'porCoordenador'),
            porCampo('a.empresa_nome', 'porEmpresa'),
            porCampo('c.SETOR', 'porSetor'),
            porCampo('a.motivo_detectado', 'porMotivo'),
            porCampo('a.anexado_por', 'porQuemAnexou')
        ]);

        const agrupado = Object.assign({}, ...recortes);
        const taxa = totais.geradas > 0
            ? Math.round((totais.devolvidas / totais.geradas) * 100) : 0;

        // Opções de filtro organizadas por campo
        const listas = {};
        for (const linha of opcoes) {
            (listas[linha.campo] = listas[linha.campo] || []).push(linha.valor);
        }

        // Quem está fora do cadastro se divide em dois: já foi desligado, ou
        // simplesmente não está no cadastro (empresa que não é gerida por ele).
        const { cpfs: demitidos } = await cpfsDemitidos();
        const desligados = { pessoas: 0, geradas: 0, devolvidas: 0, lista: [] };
        const semCadastro = { pessoas: 0, geradas: 0, devolvidas: 0 };

        for (const p of foraDoCadastro) {
            const alvo = demitidos.has(p.cpf) ? desligados : semCadastro;
            alvo.pessoas++;
            alvo.geradas += p.geradas;
            alvo.devolvidas += p.devolvidas;
            if (alvo === desligados) {
                desligados.lista.push({
                    cpf: p.cpf, nome: p.nome, reg: p.reg,
                    geradas: p.geradas, devolvidas: p.devolvidas,
                    pendentes: p.geradas - p.devolvidas
                });
            }
        }
        desligados.pendentes = desligados.geradas - desligados.devolvidas;
        semCadastro.pendentes = semCadastro.geradas - semCadastro.devolvidas;
        desligados.lista.sort((a, b) => b.pendentes - a.pendentes);

        // Nos recortes, 'Sem cadastro' vira 'Demitidos' quando é o caso.
        // A separação é feita aqui, e não no SQL, porque a lista de demitidos
        // vem da Secullum — não existe no banco para entrar num JOIN.
        const marcarDemitidos = linhas => {
            const semCad = linhas.find(l => l.rotulo === 'Sem cadastro');
            if (!semCad || !desligados.geradas) return linhas;

            const restante = semCad.geradas - desligados.geradas;
            const novas = linhas.filter(l => l !== semCad);

            if (desligados.geradas > 0) {
                novas.push({
                    rotulo: 'Demitidos',
                    geradas: desligados.geradas,
                    devolvidas: desligados.devolvidas,
                    pendentes: desligados.pendentes,
                    taxa: desligados.geradas
                        ? Number((desligados.devolvidas * 100 / desligados.geradas).toFixed(1)) : 0
                });
            }
            if (restante > 0) {
                const dev = semCad.devolvidas - desligados.devolvidas;
                novas.push({
                    rotulo: 'Sem cadastro',
                    geradas: restante,
                    devolvidas: dev,
                    pendentes: restante - dev,
                    taxa: Number((dev * 100 / restante).toFixed(1))
                });
            }
            return novas.sort((a, b) => b.geradas - a.geradas);
        };

        for (const chave of ['porProjeto', 'porLider', 'porSupervisor', 'porCoordenador', 'porSetor']) {
            if (agrupado[chave]) agrupado[chave] = marcarDemitidos(agrupado[chave]);
        }

        res.json({
            periodo: { dataInicio, dataFim },
            totais: { ...totais, taxaRetorno: taxa },
            demitidos: desligados,
            semCadastro,
            evolucao: temporal,
            ranking,
            listas,
            ...agrupado
        });

    } catch (err) {
        console.error('❌ Erro no relatório analítico:', err.message);
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

        // Normaliza tudo antes de falar com o banco
        const normalizarData = (d) => {
            if (d.includes('/')) {
                const [dia, mes, ano] = d.split('/');
                return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
            }
            return d.includes('T') ? d.split('T')[0] : d;
        };

        const validos = [];
        for (const r of registros) {
            if (!r.cpf || !r.reg || !r.data) {
                resultados.push({ reg: r.reg, data: r.data, error: 'CPF, REG e DATA são obrigatórios' });
                continue;
            }
            validos.push({
                cpf: String(r.cpf).replace(/[^\d]/g, ''),
                reg: String(r.reg),
                data: normalizarData(String(r.data)),
                empresa_id: parseInt(r.empresa_id) || 0,
                nome: r.nome || '',
                motivo: r.motivo || ''
            });
        }

        if (!validos.length) {
            return res.json({ success: true, total: registros.length, novos: 0, existentes: 0,
                              resultados, nomesExistentes: [] });
        }

        const chave = v => `${v.reg}|${v.data}|${v.empresa_id}`;
        const autor = req.user?.username || 'Sistema';

        const transaction = pool.transaction();
        await transaction.begin();

        try {
            // ==================================================================
            // 1) UMA consulta para saber quem já tem formulário gerado.
            //
            // Antes eram duas consultas POR COLABORADOR, em série. Medido contra
            // o banco real: 60 colaboradores gastavam 17s só de ida-e-volta
            // (~270ms cada), e o RH esperava isso olhando a tela. A mesma
            // informação numa consulta leva ~1,2s.
            // ==================================================================
            const listaRegs = [...new Set(validos.map(v => v.reg))].join(',');
            const datas = validos.map(v => v.data).sort();

            const jaExiste = new Map();
            const achados = await transaction.request()
                .input('regs', sql.NVarChar, listaRegs)
                .input('de', sql.Date, datas[0])
                .input('ate', sql.Date, datas[datas.length - 1])
                .query(`
                    SELECT reg, data, empresa_id, id, created_by, created_at
                    FROM ANEXOS
                    WHERE data BETWEEN @de AND @ate
                      AND reg IN (SELECT value FROM STRING_SPLIT(@regs, ','))
                `);

            for (const linha of achados.recordset) {
                const dia = linha.data.toISOString().split('T')[0];
                jaExiste.set(`${linha.reg}|${dia}|${linha.empresa_id}`, linha);
            }

            // ==================================================================
            // 2) Os novos entram em blocos, com OUTPUT para recuperar os ids.
            //
            // O limite é do SQL Server: 2100 parâmetros por comando. Com 6
            // parâmetros por linha, 100 linhas por bloco ficam bem abaixo disso.
            // ==================================================================
            const paraInserir = validos.filter(v => !jaExiste.has(chave(v)));
            const idsNovos = new Map();
            const BLOCO = 100;

            for (let i = 0; i < paraInserir.length; i += BLOCO) {
                const bloco = paraInserir.slice(i, i + BLOCO);
                const pedido = transaction.request();
                const linhasSQL = [];

                bloco.forEach((v, k) => {
                    pedido.input(`cpf${k}`, sql.VarChar, v.cpf);
                    pedido.input(`reg${k}`, sql.VarChar, v.reg);
                    pedido.input(`data${k}`, sql.Date, v.data);
                    pedido.input(`emp${k}`, sql.Int, v.empresa_id);
                    pedido.input(`nome${k}`, sql.NVarChar, v.nome);
                    pedido.input(`motivo${k}`, sql.NVarChar, v.motivo);
                    linhasSQL.push(`(@cpf${k}, @reg${k}, @data${k}, @emp${k}, @nome${k}, '', '', @motivo${k}, @autor)`);
                });
                pedido.input('autor', sql.VarChar, autor);

                // O OUTPUT devolve a chave natural junto do id, então dá para
                // ligar cada id ao registro certo sem depender da ordem
                const inseridos = await pedido.query(`
                    INSERT INTO ANEXOS
                        (cpf, reg, data, empresa_id, funcionario_nome, blob_url, blob_filename, motivo_detectado, created_by)
                    OUTPUT INSERTED.id, INSERTED.reg, INSERTED.data, INSERTED.empresa_id
                    VALUES ${linhasSQL.join(', ')}
                `);

                for (const linha of inseridos.recordset) {
                    const dia = linha.data.toISOString().split('T')[0];
                    idsNovos.set(`${linha.reg}|${dia}|${linha.empresa_id}`, linha.id);
                }
            }

            // 3) Monta a resposta na mesma forma de antes
            for (const v of validos) {
                const k = chave(v);
                const antigo = jaExiste.get(k);

                if (antigo) {
                    // Reimpressão: quem gerou da primeira vez e quando — o RH
                    // precisa saber com quem falar antes de reincomodar o colaborador
                    resultados.push({
                        reg: v.reg, data: v.data, id: antigo.id, novo: false, nome: v.nome,
                        criadoPor: antigo.created_by || null,
                        criadoEm: antigo.created_at || null
                    });
                    existentes.push(v.nome);
                } else {
                    resultados.push({
                        reg: v.reg, data: v.data, id: idsNovos.get(k) || null,
                        novo: true, nome: v.nome
                    });
                    novos.push(v.nome);
                }
            }

            await transaction.commit();
            console.log(`✅ Batch concluído: ${novos.length} novos, ${existentes.length} existentes`
                      + ` (${1 + Math.ceil(paraInserir.length / BLOCO)} idas ao banco)`);

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