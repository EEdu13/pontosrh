#!/usr/bin/env node
/**
 * Registra este sistema e suas telas na IAM Larsil (INTEGRACAO.md §5).
 *
 * O manifesto abaixo é a fonte da verdade: com modo "sync", permissões nossas que
 * não estiverem aqui são REMOVIDAS da IAM. Depois de rodar, a TI libera cada tela
 * por pessoa no console /admin — sem SQL.
 *
 *   npm run iam:sync
 */
require('dotenv').config();

const IAM_URL = process.env.IAM_URL || 'https://painelgestor.up.railway.app';
const CHAVE = process.env.IAM_REGISTRY_KEY;
const SISTEMA = process.env.IAM_SISTEMA || 'PONTORH';
const URL_BASE = process.env.APP_URL || 'https://justificativas.up.railway.app';

// Uma permissão por tela do sistema, no padrão <sistema>.tela:<rota> + grupo (a aba
// no console da TI). O front mostra a tela só se o token trouxer a permissão.
const MANIFESTO = {
    nome: 'Controle de Ponto e Justificativas',
    url_base: URL_BASE,
    modo: 'sync',
    permissoes: [
        { codigo: 'pontorh.acesso', descricao: 'Entrar no sistema' },

        { codigo: 'pontorh.tela:/index.html',     descricao: 'Justificativas',        grupo: 'Ponto' },
        { codigo: 'pontorh.tela:/presenca.html',  descricao: 'Painel de Presença',    grupo: 'Ponto' },
        { codigo: 'pontorh.tela:/monitor.html',   descricao: 'Monitor de Relógios',   grupo: 'Equipamentos' },
        { codigo: 'pontorh.tela:/coletas.html',   descricao: 'Coletas',               grupo: 'Equipamentos' },
        { codigo: 'pontorh.tela:/relatorio.html', descricao: 'Relatórios',            grupo: 'Relatórios' },

        { codigo: 'pontorh.anexo.enviar',   descricao: 'Enviar anexo de justificativa' },
        { codigo: 'pontorh.anexo.remover',  descricao: 'Remover anexo' },
        { codigo: 'pontorh.ponto.editar',   descricao: 'Editar horário no Secullum' },
        { codigo: 'pontorh.ponto.apagar',   descricao: 'Apagar batida no Secullum' }
    ]
};

async function main() {
    if (!CHAVE) {
        console.error('❌ IAM_REGISTRY_KEY não configurada no .env');
        process.exit(1);
    }

    console.log(`Sincronizando "${SISTEMA}" com ${IAM_URL} ...`);

    const response = await fetch(`${IAM_URL}/api/registry/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Registry-Key': CHAVE },
        body: JSON.stringify({ sistema: SISTEMA, ...MANIFESTO })
    });

    const corpo = await response.text();
    let dados;
    try { dados = JSON.parse(corpo); } catch { dados = corpo; }

    if (!response.ok) {
        console.error(`❌ HTTP ${response.status}:`, dados);
        process.exit(1);
    }

    console.log('✅ Sincronizado:', JSON.stringify(dados, null, 2));
    console.log('\nAgora a TI libera as telas por pessoa em ' + IAM_URL + '/admin');
}

main().catch(err => {
    console.error('❌ Falha:', err.message);
    process.exit(1);
});
