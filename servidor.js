// Função para obter lista de empresas (mostrar todas as empresas disponíveis)
async function getEmpresas() {
    try {
        console.log('Buscando todas as empresas pelos bancos...');
        const bancos = await getBancosDisponiveis();
        
        const empresas = [];
        
        for (const banco of bancos) {
            console.log(`Verificando banco: ${banco.nome} (ID: ${banco.id})`);
            
            // Tentar contar funcionários, mas não filtrar se não conseguir acessar
            let numFuncionarios = 0;
            try {
                const funcionarios = await getFuncionariosPorBanco(banco.id);
                numFuncionarios = funcionarios.length;
                console.log(`✅ Banco ${banco.nome} (${banco.id}): ${numFuncionarios} funcionários`);
            } catch (error) {
                console.log(`❌ Sem acesso aos funcionários do banco ${banco.nome}, mas incluindo na lista`);
                numFuncionarios = 0; // Mostrar como 0 funcionários se não tiver acesso
            }
            
            // Adicionar TODOS os bancos, independente de ter funcionários acessíveis
            // Usar o nome real do banco em vez da razaoSocial para evitar duplicatas
            const nomeExibicao = banco.nome || banco.razaoSocial || `Banco ${banco.id}`;
            
            empresas.push({
                id: banco.id,
                nome: nomeExibicao,
                bancoId: banco.id,
                tipo: 'banco',
                funcionarios: numFuncionarios
            });
        }
        
        if (empresas.length > 0) {
            console.log(`Encontradas ${empresas.length} empresas (todos os bancos):`, empresas.map(e => `${e.nome} (${e.funcionarios})`));
            return empresas.sort((a, b) => a.nome.localeCompare(b.nome));
        }
        
        // Fallback final
        return [{
            id: CONFIG.bancoId,
            nome: 'LARSIL SERVICOS FLORESTAIS LTDA',
            bancoId: CONFIG.bancoId,
            funcionarios: 0
        }];
        
    } catch (error) {
        console.error('Erro ao obter empresas:', error);
        return [{
            id: CONFIG.bancoId,
            nome: 'LARSIL SERVICOS FLORESTAIS LTDA',
            bancoId: CONFIG.bancoId,
            funcionarios: 0
        }];
    }
}const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3000;

// Configurações da API Secullum
const CONFIG = {
    authUrl: 'https://autenticador.secullum.com.br/Token',
    apiBase: 'https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna',
    username: 'ga.adm@larsil.com.br',
    password: 'larsil1234',
    clientId: '3',
    bancoId: '73561'  // ALR EMPREENDIMENTOS
};

// Cache para token, bancos e funcionários
let tokenCache = null;
let funcionariosCache = null; // SEMPRE buscar novo ao iniciar
let bancosCache = null;
let lastUpdate = null; // SEMPRE buscar novo ao iniciar
let bancosCacheTime = null;

// Função para formatar data para a API Secullum (formato esperado: dd/MM/yyyy)
function formatDateForAPI(dateString) {
    if (!dateString) return '';
    
    try {
        // Se já está no formato brasileiro, retorna direto
        if (dateString.includes('/')) {
            return dateString;
        }
        
        // Se é uma string de data ISO (YYYY-MM-DD), processa corretamente
        if (dateString.includes('-')) {
            const [year, month, day] = dateString.split('-');
            return `${day}/${month}/${year}`;
        }
        
        // Se é um objeto Date ou outro formato
        const date = new Date(dateString + 'T00:00:00'); // Força horário local
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        
        return `${day}/${month}/${year}`;
    } catch (error) {
        console.error('Erro ao formatar data:', error);
        return dateString; // Retorna original se der erro
    }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Função para obter token (renova a cada 30 minutos)
async function getToken() {
    // Cache de 30 minutos (1800000 ms) - token expira rápido
    if (tokenCache && Date.now() - lastUpdate < 1800000) {
        return tokenCache;
    }

    console.log('🔑 Gerando novo token de autenticação...');
    
    try {
        const response = await fetch(CONFIG.authUrl, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
            },
            body: `grant_type=password&username=${CONFIG.username}&password=${CONFIG.password}&client_id=${CONFIG.clientId}`
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Erro ao obter token - Status: ${response.status}`);
            console.error(`Resposta: ${errorText}`);
            throw new Error(`Erro de autenticação: ${response.status}`);
        }

        const data = await response.json();
        tokenCache = data.access_token;
        lastUpdate = Date.now();
        
        console.log('✅ Token gerado com sucesso!');
        console.log(`⏰ Token válido por 30 minutos (expira às ${new Date(Date.now() + 1800000).toLocaleTimeString('pt-BR')})`);
        
        return tokenCache;
    } catch (error) {
        console.error('❌ Erro ao obter token:', error.message);
        throw error;
    }
}

// Função para buscar bancos disponíveis para o usuário
async function getBancosDisponiveis() {
    if (bancosCache && Date.now() - bancosCacheTime < 3600000) { // Cache por 1 hora
        return bancosCache;
    }

    const token = await getToken();
    
    try {
        const response = await fetch('https://autenticador.secullum.com.br/ContasSecullumExterno/ListarBancos', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Erro ao buscar bancos - Status: ${response.status} - ${response.statusText}`);
            console.error(`Resposta da API: ${errorText}`);
            throw new Error(`Erro ao buscar bancos: ${response.status}`);
        }

        const bancos = await response.json();
        console.log(`✅ Bancos encontrados: ${bancos.length}`);
        
        bancosCache = bancos.map(banco => ({
            id: banco.id,
            nome: banco.nome || `Banco ${banco.id}`,
            documento: banco.documento,
            razaoSocial: banco.razaoSocial
        }));
        
        bancosCacheTime = Date.now();
        return bancosCache;
        
    } catch (error) {
        console.error('Erro ao buscar bancos:', error);
        // Fallback para o banco atual
        return [{
            id: CONFIG.bancoId,
            nome: 'LARSIL SERVICOS FLORESTAIS LTDA',
            documento: '',
            razaoSocial: 'LARSIL SERVICOS FLORESTAIS LTDA'
        }];
    }
}

// Função para buscar funcionários de um banco específico
async function getFuncionariosPorBanco(bancoId) {
    const token = await getToken();
    
    try {
        const response = await fetch(`${CONFIG.apiBase}/Funcionarios`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'secullumidbancoselecionado': bancoId.toString()
            }
        });

        if (!response.ok) {
            console.log(`Acesso a /Funcionarios bloqueado para banco ${bancoId}`);
            return [];
        }

        const funcionarios = await response.json();
        
        // Filtrar apenas funcionários ativos e adicionar bancoId
        return funcionarios
            .filter(f => !f.Demissao)
            .map(f => ({ ...f, BancoId: bancoId }));
            
    } catch (error) {
        console.error(`Erro ao buscar funcionários do banco ${bancoId}:`, error);
        return [];
    }
}

// Função para buscar todos os funcionários de todos os bancos
async function getTodosFuncionarios() {
    // Cache de 5 minutos (300000 ms) - atualização mais frequente
    if (funcionariosCache && Date.now() - lastUpdate < 300000) {
        console.log(`⚡ Usando cache de funcionários (${funcionariosCache.length} total)`);
        return funcionariosCache;
    }

    const bancos = await getBancosDisponiveis();
    console.log(`🔍 Buscando funcionários de TODOS os ${bancos.length} bancos...`);
    
    const todosFuncionarios = [];
    
    for (const banco of bancos) {
        console.log(`📊 Buscando funcionários do banco: ${banco.nome} (ID: ${banco.id})`);
        const funcionarios = await getFuncionariosPorBanco(banco.id);
        console.log(`✅ Encontrados ${funcionarios.length} funcionários no banco ${banco.nome}`);
        
        // Adicionar informações do banco aos funcionários
        const funcionariosComBanco = funcionarios.map(f => ({
            ...f,
            BancoId: banco.id,
            BancoNome: banco.nome,
            EmpresaCompleta: banco.razaoSocial || banco.nome
        }));
        
        todosFuncionarios.push(...funcionariosComBanco);
    }
    
    funcionariosCache = todosFuncionarios;
    lastUpdate = Date.now();
    
    console.log(`Total de funcionários encontrados: ${todosFuncionarios.length}`);
    return todosFuncionarios;
}

// Função para calcular horas trabalhadas e extras baseado no registro diário (formato correto da API Secullum)
function calcularHorasExtras(registroDia, jornadaPadrao = 8) {
    if (!registroDia) {
        return {
            horasTrabalhadas: 0,
            horasExtras: 0,
            detalhes: 'Sem registro encontrado'
        };
    }

    // Para batidas da API Secullum, cada registro tem DataHora
    if (registroDia.DataHora) {
        // Este é um formato de batida simples, não de registro diário completo
        // Vamos retornar dados básicos
        const data = registroDia.DataHora.split('T')[0];
        return {
            horasTrabalhadas: 0,
            horasExtras: 0,
            detalhes: `Batida: ${registroDia.DataHora}`,
            data: data
        };
    }

    const data = registroDia.Data ? new Date(registroDia.Data) : new Date();
    const dataStr = data.toISOString().split('T')[0];
    
    let totalMinutosTrabalhados = 0;
    let periodos = [];
    
    // Processar até 5 períodos (Entrada1/Saida1, Entrada2/Saida2, etc.)
    for (let i = 1; i <= 5; i++) {
        const entrada = registroDia[`Entrada${i}`];
        const saida = registroDia[`Saida${i}`];
        
        if (entrada && saida) {
            try {
                // Converter horários para Date completo
                const [horaE, minE] = entrada.split(':').map(Number);
                const [horaS, minS] = saida.split(':').map(Number);
                
                const inicioTrabalho = new Date(data);
                inicioTrabalho.setHours(horaE, minE, 0, 0);
                
                const fimTrabalho = new Date(data);
                fimTrabalho.setHours(horaS, minS, 0, 0);
                
                // Se saída é menor que entrada, assumir que é no dia seguinte
                if (fimTrabalho < inicioTrabalho) {
                    fimTrabalho.setDate(fimTrabalho.getDate() + 1);
                }
                
                const minutosPeriodo = (fimTrabalho - inicioTrabalho) / (1000 * 60);
                
                if (minutosPeriodo > 0) {
                    totalMinutosTrabalhados += minutosPeriodo;
                    periodos.push({
                        entrada: entrada,
                        saida: saida,
                        minutos: Math.round(minutosPeriodo),
                        periodo: i
                    });
                }
            } catch (error) {
                console.warn(`Erro ao calcular período ${i}:`, error);
            }
        }
    }
    
    const horasTrabalhadas = totalMinutosTrabalhados / 60;
    const horasExtras = Math.max(0, horasTrabalhadas - jornadaPadrao);
    
    return {
        horasTrabalhadas: Math.round(horasTrabalhadas * 100) / 100,
        horasExtras: Math.round(horasExtras * 100) / 100,
        detalhes: periodos.map(p => `${p.entrada} - ${p.saida} (${Math.round(p.minutos/60*100)/100}h)`).join(', '),
        periodos: periodos,
        data: dataStr
    };
}

// Função para obter marcações de um período (para cálculo de horas extras)
async function getMarcacoesPeriodo(cpf, dataInicio, dataFim, bancoId) {
    const token = await getToken();
    
    try {
        // Converter datas para formato da API Secullum
        const dataInicioFormatada = formatDateForAPI(dataInicio);
        const dataFimFormatada = formatDateForAPI(dataFim);
        
        const url = `${CONFIG.apiBase}/Batidas?dataInicio=${dataInicioFormatada}&dataFim=${dataFimFormatada}&funcionarioCpf=${cpf}`;
        
        console.log(`Buscando marcações para CPF ${cpf} no período ${dataInicioFormatada} a ${dataFimFormatada}`);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'secullumidbancoselecionado': bancoId.toString()
            }
        });

        if (!response.ok) {
            console.log(`Erro na API para CPF ${cpf}: ${response.status} - ${response.statusText}`);
            return [];
        }

        const batidas = await response.json();
        console.log(`Encontradas ${batidas.length} batidas para CPF ${cpf}`);
        return batidas;
    } catch (error) {
        console.error(`Erro ao buscar marcações para CPF ${cpf}:`, error);
        return [];
    }
}

// Função para calcular horas extras por funcionário em um período (corrigida para API Secullum)
async function calcularHorasExtrasFuncionario(funcionario, dataInicio, dataFim) {
    const registros = await getMarcacoesPeriodo(funcionario.Cpf, dataInicio, dataFim, funcionario.BancoId);
    
    const diasTrabalhados = [];
    let totalHorasExtras = 0;
    
    // Verificar se registros é um array
    if (!Array.isArray(registros)) {
        console.warn(`Registros não é um array para funcionário ${funcionario.Nome}`);
        return {
            funcionario: {
                nome: funcionario.Nome,
                cpf: funcionario.Cpf,
                banco: funcionario.BancoNome || funcionario.EmpresaCompleta || 'N/A'
            },
            totalHorasExtras: 0,
            diasTrabalhados: 0,
            detalheDias: []
        };
    }
    
    // Usar a função calcularHorasExtras corrigida
    try {
        const horasExtrasCalculadas = calcularHorasExtras(registros, funcionario.Cpf, funcionario.BancoId);
        
        horasExtrasCalculadas.forEach(he => {
            totalHorasExtras += he.horas;
            diasTrabalhados.push({
                data: he.data,
                horasTrabalhadas: he.horas + 8, // horas extras + jornada normal
                horasExtras: he.horas,
                detalhes: `${he.entrada} - ${he.saida} (${he.totalBatidas} batidas)`
            });
        });
        
    } catch (error) {
        console.warn(`Erro ao calcular horas para funcionário ${funcionario.Nome}:`, error);
    }
    
    return {
        funcionario: {
            nome: funcionario.Nome,
            cpf: funcionario.Cpf,
            banco: funcionario.BancoNome || funcionario.EmpresaCompleta || 'N/A'
        },
        totalHorasExtras: Math.round(totalHorasExtras * 100) / 100,
        diasTrabalhados: diasTrabalhados.length,
        detalheDias: diasTrabalhados
    };
}

// Função para buscar horas extras por CPF
async function getHorasExtrasPorCPF(cpf, dataInicio, dataFim, bancoId) {
    const token = await getToken();
    
    try {
        // Converter datas para formato da API Secullum
        const dataInicioFormatada = formatDateForAPI(dataInicio);
        const dataFimFormatada = formatDateForAPI(dataFim);
        
        // Primeiro tentar endpoint específico de horas extras se existir
        let url = `${CONFIG.apiBase}/HorasExtras?dataInicio=${dataInicioFormatada}&dataFim=${dataFimFormatada}&funcionarioCpf=${cpf}`;
        
        console.log(`Tentando buscar horas extras para CPF ${cpf} no período ${dataInicioFormatada} a ${dataFimFormatada}`);
        
        let response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'secullumidbancoselecionado': bancoId.toString()
            }
        });

        if (response.ok) {
            const horasExtras = await response.json();
            return horasExtras.map(he => ({
                ...he,
                tipo: 'horasExtras',
                data: he.Data || he.DataHora,
                horas: he.Horas || he.QuantidadeHoras,
                funcionarioCpf: cpf,
                bancoId: bancoId
            }));
        }
        
        // Se não funcionar, tentar buscar através das batidas e calcular horas extras
        console.log(`Endpoint HorasExtras não disponível para banco ${bancoId}, calculando através das batidas...`);
        
        const batidas = await getBatidasPorCPF(cpf, dataInicio, dataFim, bancoId);
        const horasExtrasCalculadas = calcularHorasExtras(batidas, cpf, bancoId);
        
        return horasExtrasCalculadas;
        
    } catch (error) {
        console.error(`Erro ao buscar horas extras para CPF ${cpf} no banco ${bancoId}:`, error);
        return [];
    }
}

// Função para calcular horas extras baseado nas batidas
function calcularHorasExtras(batidas, cpf, bancoId) {
    if (!batidas || batidas.length === 0) return [];
    
    const horasExtras = [];
    
    // Agrupar batidas por data
    const batidasPorData = {};
    batidas.forEach(batida => {
        const data = batida.DataHora ? batida.DataHora.split('T')[0] : batida.Data;
        if (!batidasPorData[data]) {
            batidasPorData[data] = [];
        }
        batidasPorData[data].push(batida);
    });
    
    // Processar cada dia
    Object.keys(batidasPorData).forEach(data => {
        const batidasDia = batidasPorData[data].sort((a, b) => {
            const horaA = a.DataHora || a.Hora;
            const horaB = b.DataHora || b.Hora;
            return horaA.localeCompare(horaB);
        });
        
        if (batidasDia.length >= 2) {
            const entrada = batidasDia[0];
            const saida = batidasDia[batidasDia.length - 1];
            
            const horaEntrada = new Date(`${data}T${entrada.DataHora ? entrada.DataHora.split('T')[1] : entrada.Hora}`);
            const horaSaida = new Date(`${data}T${saida.DataHora ? saida.DataHora.split('T')[1] : saida.Hora}`);
            
            const horasTrabalhadas = (horaSaida - horaEntrada) / (1000 * 60 * 60); // em horas
            const horasNormais = 8; // Jornada padrão de 8 horas
            
            if (horasTrabalhadas > horasNormais) {
                const horasExtrasCalculadas = horasTrabalhadas - horasNormais;
                
                horasExtras.push({
                    data: data,
                    horas: Number(horasExtrasCalculadas.toFixed(2)),
                    tipo: 'calculado',
                    entrada: entrada.DataHora || entrada.Hora,
                    saida: saida.DataHora || saida.Hora,
                    totalBatidas: batidasDia.length,
                    funcionarioCpf: cpf,
                    bancoId: bancoId
                });
            }
        }
    });
    
    return horasExtras;
}

// Função para buscar batidas por CPF (atualizada para usar o banco correto)
async function getBatidasPorCPF(cpf, dataInicio, dataFim, bancoId) {
    const token = await getToken();
    
    try {
        // Converter datas para formato da API Secullum
        const dataInicioFormatada = formatDateForAPI(dataInicio);
        const dataFimFormatada = formatDateForAPI(dataFim);
        
        const url = `${CONFIG.apiBase}/Batidas?dataInicio=${dataInicioFormatada}&dataFim=${dataFimFormatada}&funcionarioCpf=${cpf}`;
        
        console.log(`Buscando batidas para CPF ${cpf} no período ${dataInicioFormatada} a ${dataFimFormatada}`);
        
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'secullumidbancoselecionado': bancoId.toString()
            }
        });

        if (!response.ok) {
            console.log(`Erro na API para CPF ${cpf}: ${response.status} - ${response.statusText}`);
            return [];
        }

        const batidas = await response.json();
        console.log(`Encontradas ${batidas.length} batidas para CPF ${cpf}`);
        return batidas;
    } catch (error) {
        console.error(`Erro ao buscar batidas para CPF ${cpf} no banco ${bancoId}:`, error);
        return [];
    }
}

// Função para buscar departamentos de um banco
async function getDepartamentosPorBanco(bancoId) {
    const token = await getToken();
    
    try {
        const response = await fetch(`${CONFIG.apiBase}/Departamentos`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'secullumidbancoselecionado': bancoId.toString()
            }
        });

        if (!response.ok) {
            console.log(`Acesso a /Departamentos bloqueado para banco ${bancoId}`);
            return [];
        }

        const departamentos = await response.json();
        console.log(`Encontrados ${departamentos.length} departamentos no banco ${bancoId}`);
        
        return departamentos.map(dep => ({
            ...dep,
            BancoId: bancoId
        }));
        
    } catch (error) {
        console.error(`Erro ao buscar departamentos do banco ${bancoId}:`, error);
        return [];
    }
}

// Função para obter empresas baseada em departamentos
async function getEmpresasViaDepartamentos() {
    try {
        const bancos = await getBancosDisponiveis();
        const todasEmpresas = [];
        
        for (const banco of bancos) {
            console.log(`Buscando departamentos do banco: ${banco.nome} (ID: ${banco.id})`);
            const departamentos = await getDepartamentosPorBanco(banco.id);
            
            if (departamentos.length > 0) {
                // Criar "empresas" baseadas nos departamentos
                departamentos.forEach(dep => {
                    todasEmpresas.push({
                        id: `${banco.id}_${dep.Id}`,
                        nome: dep.Descricao || dep.Nome || `Departamento ${dep.Id}`,
                        bancoId: banco.id,
                        departamentoId: dep.Id,
                        tipo: 'departamento',
                        funcionarios: 0
                    });
                });
            } else {
                // Se não tem departamentos, usar o banco como empresa
                todasEmpresas.push({
                    id: banco.id,
                    nome: banco.razaoSocial || banco.nome,
                    bancoId: banco.id,
                    departamentoId: null,
                    tipo: 'banco',
                    funcionarios: 0
                });
            }
        }
        
        // Contar funcionários por empresa/departamento
        try {
            const todosFuncionarios = await getTodosFuncionarios();
            
            todasEmpresas.forEach(empresa => {
                if (empresa.tipo === 'departamento') {
                    // Filtrar funcionários por banco e departamento
                    empresa.funcionarios = todosFuncionarios.filter(f => 
                        f.BancoId == empresa.bancoId && 
                        (f.DepartamentoId == empresa.departamentoId || 
                         (typeof f.Departamento === 'object' && f.Departamento?.Id == empresa.departamentoId) ||
                         f.DepartamentoDescricao === empresa.nome ||
                         f.Departamento === empresa.nome)
                    ).length;
                } else {
                    // Filtrar funcionários apenas por banco
                    empresa.funcionarios = todosFuncionarios.filter(f => f.BancoId == empresa.bancoId).length;
                }
            });
        } catch (error) {
            console.log('Erro ao contar funcionários por empresa/departamento:', error.message);
        }
        
        return todasEmpresas.filter(e => e.funcionarios > 0).sort((a, b) => a.nome.localeCompare(b.nome));
        
    } catch (error) {
        console.error('Erro ao buscar empresas via departamentos:', error);
        return [];
    }
}

// Função para processar dados do dashboard (simplificada para bancos apenas)
async function processarDadosDashboard(empresaId = null) {
    // Obter data local no formato YYYY-MM-DD (03 outubro 2025)
    const hoje = new Date(2025, 9, 3); // Mês 9 = outubro (0-indexado) - 03/10/2025
    const ano = hoje.getFullYear();
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const dia = String(hoje.getDate()).padStart(2, '0');
    const dataHoje = `${ano}-${mes}-${dia}`;
    
    let funcionarios = await getTodosFuncionarios();
    
    // Filtrar por banco se especificado
    if (empresaId) {
        funcionarios = funcionarios.filter(f => f.BancoId == empresaId);
    }
    
    console.log(`Processando ${funcionarios.length} funcionários para o dashboard`);
    
    const dadosCompletos = await Promise.all(
        funcionarios.map(async (funcionario) => {
            const batidas = await getBatidasPorCPF(funcionario.Cpf, dataHoje, dataHoje, funcionario.BancoId);
            
            // Extrair dados corretamente
            const empresa = funcionario.BancoNome || funcionario.EmpresaCompleta || 'N/A';
            
            return {
                nome: funcionario.Nome || 'Nome não disponível',
                cpf: funcionario.Cpf || 'N/A',
                empresa: empresa,
                empresaId: funcionario.BancoId,
                batidas: batidas.length,
                detalheBatidas: batidas,
                bateuPonto: batidas.length > 0
            };
        })
    );

    const totalFuncionarios = dadosCompletos.length;
    const funcionariosBateramPonto = dadosCompletos.filter(f => f.bateuPonto).length;
    const funcionariosNaoBateram = dadosCompletos.filter(f => !f.bateuPonto);
    
    return {
        resumo: {
            total: totalFuncionarios,
            bateramPonto: funcionariosBateramPonto,
            naoBateram: totalFuncionarios - funcionariosBateramPonto,
            percentual: totalFuncionarios > 0 ? Math.round((funcionariosBateramPonto / totalFuncionarios) * 100) : 0
        },
        funcionarios: dadosCompletos,
        funcionariosNaoBateram
    };
}

// Rotas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/bancos', async (req, res) => {
    try {
        console.log('Buscando bancos disponíveis...');
        const bancos = await getBancosDisponiveis();
        console.log(`Encontrados ${bancos.length} bancos:`, bancos.map(b => b.nome));
        res.json(bancos);
    } catch (error) {
        console.error('Erro ao buscar bancos:', error);
        res.status(500).json({ error: 'Erro ao buscar bancos', details: error.message });
    }
});

app.get('/api/empresas', async (req, res) => {
    try {
        console.log('Buscando empresas...');
        const empresas = await getEmpresas();
        console.log(`Encontradas ${empresas.length} empresas:`, empresas.map(e => `${e.nome} (${e.funcionarios})`));
        res.json(empresas);
    } catch (error) {
        console.error('Erro ao buscar empresas:', error);
        res.status(500).json({ error: 'Erro ao buscar empresas', details: error.message });
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const empresaId = req.query.empresa;
        console.log(`Processando dashboard para empresa: ${empresaId || 'Todas'}`);
        
        const dados = await processarDadosDashboard(empresaId);
        console.log(`Dashboard processado: ${dados.resumo.total} funcionários, ${dados.resumo.bateramPonto} bateram ponto`);
        
        res.json(dados);
    } catch (error) {
        console.error('Erro no dashboard:', error);
        res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
    }
});

// Endpoint para buscar todos os funcionários
app.get('/api/funcionarios', async (req, res) => {
    try {
        const bancoId = req.query.bancoId;
        const departamentoId = req.query.departamentoId;
        const ativo = req.query.ativo !== 'false'; // Por padrão, buscar apenas ativos
        
        console.log(`Buscando funcionários - Banco: ${bancoId || 'Todos'}, Departamento: ${departamentoId || 'Todos'}, Ativos: ${ativo}`);
        
        let funcionarios;
        
        if (bancoId) {
            // Buscar funcionários de um banco específico
            funcionarios = await getFuncionariosPorBanco(bancoId);
        } else {
            // Buscar todos os funcionários de todos os bancos
            funcionarios = await getTodosFuncionarios();
        }
        
        // Filtrar por departamento se especificado
        if (departamentoId) {
            funcionarios = funcionarios.filter(f => {
                return f.DepartamentoId == departamentoId ||
                       (typeof f.Departamento === 'object' && f.Departamento?.Id == departamentoId) ||
                       f.Departamento == departamentoId;
            });
        }
        
        // Filtrar por status ativo se solicitado
        if (ativo) {
            funcionarios = funcionarios.filter(f => !f.Demissao);
        }
        
        // Formatar dados para resposta
        const funcionariosFormatados = funcionarios.map(f => ({
            id: f.Id,
            nome: f.Nome,
            cpf: f.Cpf,
            email: f.Email,
            telefone: f.Telefone,
            departamento: typeof f.Departamento === 'object' 
                ? (f.Departamento?.Descricao || f.Departamento?.Nome || 'N/A')
                : (f.Departamento || f.DepartamentoDescricao || 'N/A'),
            departamentoId: f.DepartamentoId || (typeof f.Departamento === 'object' ? f.Departamento?.Id : null),
            bancoId: f.BancoId,
            bancoNome: f.BancoNome || f.EmpresaCompleta,
            dataAdmissao: f.Admissao,
            dataDemissao: f.Demissao,
            ativo: !f.Demissao,
            pis: f.Pis,
            funcao: f.Funcao || f.Cargo,
            salario: f.Salario
        }));
        
        console.log(`Encontrados ${funcionariosFormatados.length} funcionários`);
        res.json(funcionariosFormatados);
        
    } catch (error) {
        console.error('Erro ao buscar funcionários:', error);
        res.status(500).json({ error: 'Erro ao buscar funcionários', details: error.message });
    }
});

// Endpoint para buscar horas extras
app.get('/api/horas-extras', async (req, res) => {
    try {
        const bancoId = req.query.bancoId;
        const funcionarioId = req.query.funcionarioId;
        const cpf = req.query.cpf;
        const dataInicio = req.query.dataInicio || (() => {
            const hoje = new Date(2025, 9, 3); // Mês 9 = outubro (0-indexado) - 03/10/2025
            const ano = hoje.getFullYear();
            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
            const dia = String(hoje.getDate()).padStart(2, '0');
            return `${ano}-${mes}-${dia}`;
        })();
        const dataFim = req.query.dataFim || dataInicio;
        
        console.log(`Buscando horas extras - Banco: ${bancoId || 'Todos'}, Funcionário: ${funcionarioId || cpf || 'Todos'}, Período: ${dataInicio} a ${dataFim}`);
        
        const horasExtras = [];
        
        if (cpf && bancoId) {
            // Buscar horas extras de um funcionário específico
            const extras = await getHorasExtrasPorCPF(cpf, dataInicio, dataFim, bancoId);
            horasExtras.push(...extras);
        } else if (funcionarioId && bancoId) {
            // Buscar por ID do funcionário
            const funcionarios = await getFuncionariosPorBanco(bancoId);
            const funcionario = funcionarios.find(f => f.Id == funcionarioId);
            
            if (funcionario) {
                const extras = await getHorasExtrasPorCPF(funcionario.Cpf, dataInicio, dataFim, bancoId);
                horasExtras.push(...extras);
            }
        } else {
            // Buscar horas extras de todos os funcionários
            const todosFuncionarios = bancoId 
                ? await getFuncionariosPorBanco(bancoId)
                : await getTodosFuncionarios();
            
            for (const funcionario of todosFuncionarios) {
                try {
                    const extras = await getHorasExtrasPorCPF(funcionario.Cpf, dataInicio, dataFim, funcionario.BancoId);
                    horasExtras.push(...extras.map(extra => ({
                        ...extra,
                        funcionarioNome: funcionario.Nome,
                        funcionarioCpf: funcionario.Cpf,
                        bancoId: funcionario.BancoId,
                        bancoNome: funcionario.BancoNome
                    })));
                } catch (error) {
                    console.log(`Erro ao buscar horas extras para ${funcionario.Nome}: ${error.message}`);
                }
            }
        }
        
        console.log(`Encontradas ${horasExtras.length} registros de horas extras`);
        res.json(horasExtras);
        
    } catch (error) {
        console.error('Erro ao buscar horas extras:', error);
        res.status(500).json({ error: 'Erro ao buscar horas extras', details: error.message });
    }
});

// Endpoint para buscar departamentos
app.get('/api/departamentos', async (req, res) => {
    try {
        const bancoId = req.query.bancoId;
        
        console.log(`Buscando departamentos - Banco: ${bancoId || 'Todos'}`);
        
        let departamentos = [];
        
        if (bancoId) {
            // Buscar departamentos de um banco específico
            departamentos = await getDepartamentosPorBanco(bancoId);
        } else {
            // Buscar departamentos de todos os bancos
            const bancos = await getBancosDisponiveis();
            
            for (const banco of bancos) {
                const depsBanco = await getDepartamentosPorBanco(banco.id);
                departamentos.push(...depsBanco.map(dep => ({
                    ...dep,
                    BancoNome: banco.nome
                })));
            }
        }
        
        // Formatar dados para resposta
        const departamentosFormatados = departamentos.map(dep => ({
            id: dep.Id,
            descricao: dep.Descricao || dep.Nome,
            nome: dep.Nome || dep.Descricao,
            bancoId: dep.BancoId,
            bancoNome: dep.BancoNome,
            ativo: dep.Ativo !== false
        }));
        
        console.log(`Encontrados ${departamentosFormatados.length} departamentos`);
        res.json(departamentosFormatados);
        
    } catch (error) {
        console.error('Erro ao buscar departamentos:', error);
        res.status(500).json({ error: 'Erro ao buscar departamentos', details: error.message });
    }
});

// Endpoint para buscar batidas de ponto
app.get('/api/batidas', async (req, res) => {
    try {
        const bancoId = req.query.bancoId;
        const funcionarioId = req.query.funcionarioId;
        const cpf = req.query.cpf;
        const dataInicio = req.query.dataInicio || (() => {
            const hoje = new Date(2025, 9, 3); // 03/10/2025 - Mês 9 = outubro (0-indexado)
            const ano = hoje.getFullYear();
            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
            const dia = String(hoje.getDate()).padStart(2, '0');
            return `${ano}-${mes}-${dia}`;
        })();
        const dataFim = req.query.dataFim || dataInicio;
        
        console.log(`Buscando batidas - Banco: ${bancoId || 'Todos'}, Funcionário: ${funcionarioId || cpf || 'Todos'}, Período: ${dataInicio} a ${dataFim}`);
        
        const batidas = [];
        
        if (cpf && bancoId) {
            // Buscar batidas de um funcionário específico
            const batidasFuncionario = await getBatidasPorCPF(cpf, dataInicio, dataFim, bancoId);
            batidas.push(...batidasFuncionario.map(batida => ({
                ...batida,
                funcionarioCpf: cpf,
                bancoId: bancoId
            })));
        } else if (funcionarioId && bancoId) {
            // Buscar por ID do funcionário
            const funcionarios = await getFuncionariosPorBanco(bancoId);
            const funcionario = funcionarios.find(f => f.Id == funcionarioId);
            
            if (funcionario) {
                const batidasFuncionario = await getBatidasPorCPF(funcionario.Cpf, dataInicio, dataFim, bancoId);
                batidas.push(...batidasFuncionario.map(batida => ({
                    ...batida,
                    funcionarioNome: funcionario.Nome,
                    funcionarioCpf: funcionario.Cpf,
                    bancoId: bancoId
                })));
            }
        } else {
            // Buscar batidas de TODOS os funcionários de TODOS os bancos
            const funcionarios = bancoId 
                ? await getFuncionariosPorBanco(bancoId)
                : await getTodosFuncionarios();
            
            console.log(`Buscando batidas para TODOS os ${funcionarios.length} funcionários...`);
            
            // Processar todos os funcionários (sem limitação)
            let contador = 0;
            for (const funcionario of funcionarios) {
                try {
                    const batidasFuncionario = await getBatidasPorCPF(funcionario.Cpf, dataInicio, dataFim, funcionario.BancoId);
                    batidas.push(...batidasFuncionario.map(batida => ({
                        ...batida,
                        funcionarioNome: funcionario.Nome,
                        funcionarioCpf: funcionario.Cpf,
                        bancoId: funcionario.BancoId,
                        bancoNome: funcionario.BancoNome
                    })));
                    
                    contador++;
                    if (contador % 50 === 0) {
                        console.log(`Processados ${contador}/${funcionarios.length} funcionários...`);
                    }
                } catch (error) {
                    console.log(`Erro ao buscar batidas para ${funcionario.Nome}: ${error.message}`);
                }
            }
            
            console.log(`✅ Busca completa: ${contador} funcionários processados de ${funcionarios.length} total`);
        }
        
        // Ordenar batidas por data/hora
        batidas.sort((a, b) => {
            const dataA = a.DataHora || a.Data;
            const dataB = b.DataHora || b.Data;
            return dataB.localeCompare(dataA); // Mais recentes primeiro
        });
        
        console.log(`Encontradas ${batidas.length} batidas de ponto`);
        res.json(batidas);
        
    } catch (error) {
        console.error('Erro ao buscar batidas:', error);
        res.status(500).json({ error: 'Erro ao buscar batidas', details: error.message });
    }
});

// Endpoint para estatísticas gerais
app.get('/api/estatisticas', async (req, res) => {
    try {
        const bancoId = req.query.bancoId;
        const dataInicio = req.query.dataInicio || (() => {
            const hoje = new Date(2025, 9, 3); // 03/10/2025 - Mês 9 = outubro (0-indexado)
            const ano = hoje.getFullYear();
            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
            const dia = String(hoje.getDate()).padStart(2, '0');
            return `${ano}-${mes}-${dia}`;
        })();
        const dataFim = req.query.dataFim || dataInicio;
        
        console.log(`Gerando estatísticas - Banco: ${bancoId || 'Todos'}, Período: ${dataInicio} a ${dataFim}`);
        
        const bancos = bancoId ? [{ id: bancoId }] : await getBancosDisponiveis();
        const estatisticas = {
            totalBancos: bancos.length,
            totalFuncionarios: 0,
            totalDepartamentos: 0,
            funcionariosPorBanco: [],
            departamentosPorBanco: [],
            resumoPonto: {
                totalBatidas: 0,
                funcionariosComPonto: 0,
                funcionariosSemPonto: 0,
                percentualPresenca: 0
            }
        };
        
        for (const banco of bancos) {
            const funcionarios = await getFuncionariosPorBanco(banco.id);
            const departamentos = await getDepartamentosPorBanco(banco.id);
            
            const funcionariosAtivos = funcionarios.filter(f => !f.Demissao);
            
            estatisticas.totalFuncionarios += funcionariosAtivos.length;
            estatisticas.totalDepartamentos += departamentos.length;
            
            estatisticas.funcionariosPorBanco.push({
                bancoId: banco.id,
                bancoNome: banco.nome || banco.razaoSocial,
                totalFuncionarios: funcionariosAtivos.length,
                funcionariosInativos: funcionarios.length - funcionariosAtivos.length
            });
            
            estatisticas.departamentosPorBanco.push({
                bancoId: banco.id,
                bancoNome: banco.nome || banco.razaoSocial,
                totalDepartamentos: departamentos.length,
                departamentos: departamentos.map(d => ({
                    id: d.Id,
                    nome: d.Descricao || d.Nome
                }))
            });
            
            // Contabilizar pontos para TODOS os funcionários
            if (dataInicio === dataFim) {
                let funcionariosComPonto = 0;
                let totalBatidas = 0;
                
                console.log(`Contabilizando batidas para ${funcionariosAtivos.length} funcionários do banco ${banco.nome}...`);
                
                // Processar TODOS os funcionários ativos (sem limitação)
                for (const funcionario of funcionariosAtivos) {
                    const batidas = await getBatidasPorCPF(funcionario.Cpf, dataInicio, dataFim, banco.id);
                    totalBatidas += batidas.length;
                    if (batidas.length > 0) funcionariosComPonto++;
                }
                
                estatisticas.resumoPonto.totalBatidas += totalBatidas;
                estatisticas.resumoPonto.funcionariosComPonto += funcionariosComPonto;
                estatisticas.resumoPonto.funcionariosSemPonto += (funcionariosAtivos.length - funcionariosComPonto);
            }
        }
        
        // Calcular percentual de presença
        const totalVerificados = estatisticas.resumoPonto.funcionariosComPonto + estatisticas.resumoPonto.funcionariosSemPonto;
        if (totalVerificados > 0) {
            estatisticas.resumoPonto.percentualPresenca = Math.round(
                (estatisticas.resumoPonto.funcionariosComPonto / totalVerificados) * 100
            );
        }
        
        console.log(`Estatísticas geradas: ${estatisticas.totalFuncionarios} funcionários, ${estatisticas.totalDepartamentos} departamentos`);
        res.json(estatisticas);
        
    } catch (error) {
        console.error('Erro ao gerar estatísticas:', error);
        res.status(500).json({ error: 'Erro ao gerar estatísticas', details: error.message });
    }
});

// Endpoint para horas extras por banco
app.get('/api/horas-extras/banco', async (req, res) => {
    try {
        const { dataInicio, dataFim, empresaId } = req.query;
        
        if (!dataInicio || !dataFim) {
            return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios' });
        }
        
        console.log(`Calculando horas extras por banco de ${dataInicio} a ${dataFim}`);
        
        let funcionarios = await getTodosFuncionarios();
        
        // Filtrar por banco se especificado
        if (empresaId) {
            funcionarios = funcionarios.filter(f => f.BancoId == empresaId);
        }
        
        // Agrupar funcionários por banco
        const bancos = {};
        
        for (const funcionario of funcionarios) {
            const bancoNome = funcionario.BancoNome || funcionario.EmpresaCompleta || 'Banco Desconhecido';
            
            if (!bancos[bancoNome]) {
                bancos[bancoNome] = {
                    nome: bancoNome,
                    funcionarios: [],
                    totalHorasExtras: 0,
                    totalFuncionarios: 0
                };
            }
            
            const horasExtras = await calcularHorasExtrasFuncionario(funcionario, dataInicio, dataFim);
            bancos[bancoNome].funcionarios.push(horasExtras);
            bancos[bancoNome].totalHorasExtras += horasExtras.totalHorasExtras;
            bancos[bancoNome].totalFuncionarios++;
        }
        
        // Converter para array e ordenar
        const resultado = Object.values(bancos)
            .map(banco => ({
                ...banco,
                totalHorasExtras: Math.round(banco.totalHorasExtras * 100) / 100,
                mediaHorasExtras: Math.round((banco.totalHorasExtras / banco.totalFuncionarios) * 100) / 100
            }))
            .sort((a, b) => b.totalHorasExtras - a.totalHorasExtras);
        
        res.json(resultado);
    } catch (error) {
        console.error('Erro ao calcular horas extras por banco:', error);
        res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
    }
});

// Endpoint para horas extras por pessoa
app.get('/api/horas-extras/pessoa', async (req, res) => {
    try {
        const { dataInicio, dataFim, empresaId } = req.query;
        
        if (!dataInicio || !dataFim) {
            return res.status(400).json({ error: 'dataInicio e dataFim são obrigatórios' });
        }
        
        console.log(`Calculando horas extras por pessoa de ${dataInicio} a ${dataFim}`);
        
        let funcionarios = await getTodosFuncionarios();
        
        // Filtrar por banco se especificado
        if (empresaId) {
            funcionarios = funcionarios.filter(f => f.BancoId == empresaId);
        }
        
        const resultados = [];
        
        for (const funcionario of funcionarios) {
            const horasExtras = await calcularHorasExtrasFuncionario(funcionario, dataInicio, dataFim);
            resultados.push(horasExtras);
        }
        
        // Ordenar por horas extras (maior primeiro)
        resultados.sort((a, b) => b.totalHorasExtras - a.totalHorasExtras);
        
        res.json(resultados);
    } catch (error) {
        console.error('Erro ao calcular horas extras por pessoa:', error);
        res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log('Dashboard de Ponto Secullum iniciado!');
});

module.exports = app;