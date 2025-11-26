// ==========================================
// CONFIGURAÇÃO DA API SECULLUM
// Este arquivo deve ser carregado ANTES dos scripts principais
// ==========================================

// NOTA: Em produção, estas credenciais devem vir de variáveis de ambiente
// através de um endpoint do servidor que injeta os valores de forma segura

const SECULLUM_CONFIG = {
    // URLs da API
    authURL: 'https://autenticador.secullum.com.br/Token',
    baseURL: 'https://pontowebintegracaoexterna.secullum.com.br',
    
    // Credenciais (NÃO COMMITAR COM VALORES REAIS)
    // Em produção, buscar via endpoint do servidor: GET /api/config
    credentials: {
        grant_type: 'password',
        username: '', // Será preenchido via servidor
        password: '', // Será preenchido via servidor
        client_id: '3'
    },
    
    // Token (será preenchido dinamicamente)
    token: '',
    
    // Empresas (será preenchido dinamicamente)
    companies: [],
    selectedCompanies: ['all'],
    
    // Endpoints disponíveis
    endpoints: {
        auth: '/Token',
        batidas: '/Batidas',
        funcionarios: '/Funcionarios',
        justificativas: '/Justificativas',
        cartaoPontoManual: '/CartaoPonto/Manual',
        cartaoPontoJustificativa: '/CartaoPonto/Justificativa',
        calcular: '/Calcular',
        pendencias: '/Pendencias',
        fonteDados: '/FonteDados'
    }
};

// Função auxiliar para buscar configurações do servidor
async function loadSecullumConfig() {
    try {
        // Em produção, descomentar e implementar endpoint no servidor:
        // const response = await fetch('/api/secullum-config', {
        //     headers: {
        //         'Authorization': `Bearer ${localStorage.getItem('token')}`
        //     }
        // });
        // const config = await response.json();
        // SECULLUM_CONFIG.credentials.username = config.username;
        // SECULLUM_CONFIG.credentials.password = config.password;
        
        console.log('⚙️ Configuração Secullum carregada');
        return true;
    } catch (err) {
        console.error('❌ Erro ao carregar configuração:', err);
        return false;
    }
}
