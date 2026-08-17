/* ==========================================================================
   session.js — Sessão compartilhada entre as páginas do sistema.

   A identidade vem da IAM Larsil (INTEGRACAO.md): o login acontece uma vez em
   login.html, que fala com o nosso backend, que por sua vez delega à IAM. O
   token da IAM fica no localStorage e acompanha toda chamada /api.

   Nenhuma página carrega credencial. As chamadas à Secullum passam pelo nosso
   proxy (/api/secullum/*), que usa a conta de serviço no servidor.

   A foto de perfil NÃO vem da IAM — quem resolve é o Painel PCP, por nome
   (INTEGRACAO.md §5.3 e UNICO-PEOPLE-FOTOS.md §7).
   ========================================================================== */
(function (global) {
    'use strict';

    var API_BASE_URL = global.location.hostname === 'localhost'
        ? 'http://localhost:3000'
        : global.location.origin;

    var TOKEN_KEY = 'token';           // JWT da IAM
    var USER_KEY = 'larsil_user';      // identidade + permissões (cache local)
    var FOTO_KEY = 'larsil_foto_base'; // URL do resolvedor de fotos (PCP)

    var redirecionando = false;

    function irParaLogin(motivo) {
        if (redirecionando) return;
        redirecionando = true;
        if (motivo) console.warn('🔒 ' + motivo);
        limpar();
        global.location.href = '/login.html';
    }

    function limpar() {
        try {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
        } catch (e) { /* noop */ }
    }

    /** JWT da IAM. */
    function getJwt() {
        return localStorage.getItem(TOKEN_KEY);
    }

    /** Usuário logado (login, nome, papéis, permissões, escopos). */
    function getUsuario() {
        try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
        catch (e) { return null; }
    }

    /** Lê o `exp` do JWT sem validar assinatura — só para não usar token vencido. */
    function expiraEm() {
        var t = getJwt();
        if (!t) return 0;
        try {
            var payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return (payload.exp || 0) * 1000;
        } catch (e) { return 0; }
    }

    function sessaoValida() {
        var exp = expiraEm();
        return !!getJwt() && (exp === 0 || Date.now() < exp);
    }

    /** Guarda o resultado do login. */
    function salvarSessao(dados) {
        try {
            localStorage.setItem(TOKEN_KEY, dados.token);
            localStorage.setItem(USER_KEY, JSON.stringify(dados.user || {}));
        } catch (e) { /* noop */ }
    }

    /** Exige sessão válida no carregamento da página. */
    function requireAuth() {
        if (!sessaoValida()) { irParaLogin('Sessão expirada.'); return false; }
        return true;
    }

    /** true se o usuário pode ver a rota (permissão de tela vinda da IAM). */
    function temTela(rota) {
        var u = getUsuario();
        if (!u) return false;
        return (u.permissoes || []).indexOf('pontorh.tela:' + rota) !== -1;
    }

    /** Fetch para a nossa API, já com o token e tratamento de sessão expirada. */
    function apiFetch(path, options) {
        options = options || {};
        var jwt = getJwt();

        if (!jwt) {
            irParaLogin('Sem token.');
            return Promise.reject(new Error('Não autenticado'));
        }

        var headers = Object.assign(
            { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
            options.headers || {}
        );

        var url = path.indexOf('http') === 0 ? path : API_BASE_URL + path;

        return fetch(url, Object.assign({}, options, { headers: headers }))
            .then(function (response) {
                if (response.status === 401) irParaLogin('Sessão expirada.');
                if (response.status === 403) {
                    // 403 de SESSÃO (conta desativada) derruba; 403 de AÇÃO não.
                    response.clone().json().then(function (b) {
                        if (b && b.motivo === 'INATIVO') {
                            alert(b.error || 'Sua conta está desativada. Entre em contato com a TI.');
                            irParaLogin('Conta desativada.');
                        }
                    }).catch(function () { /* noop */ });
                }
                return response;
            });
    }

    /** Chamada à API Secullum através do nosso proxy (nunca direto). */
    function secullumFetch(path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        if (options.bancoId) headers.secullumidbancoselecionado = String(options.bancoId);
        return apiFetch('/api/secullum' + path, Object.assign({}, options, { headers: headers }));
    }

    /** Lista as empresas (bancos) disponíveis. */
    function loadCompanies() {
        return apiFetch('/api/secullum/bancos')
            .then(function (response) {
                if (!response.ok) throw new Error('Erro ao buscar empresas: ' + response.status);
                return response.json();
            })
            .catch(function (err) {
                console.error('❌ Erro ao buscar empresas:', err);
                return [];
            });
    }

    /** Preenche um <select> com as empresas. Devolve a lista carregada. */
    function fillCompanySelect(selectEl, placeholder) {
        return loadCompanies().then(function (bancos) {
            if (!selectEl) return bancos;

            selectEl.replaceChildren();
            var vazio = document.createElement('option');
            vazio.value = '';
            vazio.textContent = placeholder || 'Selecione uma empresa...';
            selectEl.appendChild(vazio);

            bancos.forEach(function (banco) {
                var option = document.createElement('option');
                option.value = banco.id;
                option.textContent = banco.nome || banco.razaoSocial || ('Empresa ' + banco.id);
                selectEl.appendChild(option);
            });
            return bancos;
        });
    }

    // ==========================================
    // FOTOS (resolvidas pelo Painel PCP, por nome)
    // ==========================================
    var fotoBase = localStorage.getItem(FOTO_KEY) || '';

    /** Busca a URL do resolvedor de fotos uma vez e memoriza. */
    function carregarConfig() {
        return fetch(API_BASE_URL + '/api/config')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (c) {
                if (c && c.fotoBaseUrl) {
                    fotoBase = c.fotoBaseUrl;
                    try { localStorage.setItem(FOTO_KEY, fotoBase); } catch (e) { /* noop */ }
                }
                return fotoBase;
            })
            .catch(function () { return fotoBase; });
    }

    /** URL da foto de uma pessoa pelo nome. '' se ainda não sabemos a base. */
    function fotoUrl(nome) {
        if (!fotoBase || !nome) return '';
        return fotoBase + '/' + encodeURIComponent(String(nome).trim());
    }

    /** Iniciais para quando não há foto. */
    function iniciais(nome) {
        return String(nome || '').trim().split(/\s+/)
            .map(function (s) { return s[0]; }).slice(0, 2).join('').toUpperCase();
    }

    /**
     * Monta um avatar (<img> com fallback para iniciais).
     * `lazy` deixa o navegador só baixar quando a linha entra na tela — importante
     * na tabela, que tem centenas de pessoas.
     */
    function avatar(nome, opts) {
        opts = opts || {};
        var tamanho = opts.size || 32;

        var box = document.createElement('div');
        box.className = 'avatar-foto' + (opts.className ? ' ' + opts.className : '');
        box.style.width = tamanho + 'px';
        box.style.height = tamanho + 'px';
        box.title = nome || '';

        var url = fotoUrl(nome);
        if (!url) {
            box.textContent = iniciais(nome);
            return box;
        }

        var img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        if (opts.lazy !== false) img.loading = 'lazy';
        img.src = url;
        img.onerror = function () {
            box.replaceChildren();
            box.textContent = iniciais(nome);
        };
        box.appendChild(img);

        if (opts.clicavel !== false) {
            box.classList.add('avatar-clicavel');
            box.addEventListener('click', function (e) {
                e.stopPropagation();
                abrirLightbox(nome);
            });
        }

        return box;
    }

    /** Abre a foto em tamanho grande. */
    function abrirLightbox(nome) {
        var url = fotoUrl(nome);
        if (!url) return;

        var fundo = document.createElement('div');
        fundo.className = 'foto-lightbox';

        var caixa = document.createElement('div');
        caixa.className = 'foto-lightbox-caixa';

        var img = document.createElement('img');
        img.src = url;
        img.alt = nome;
        img.referrerPolicy = 'no-referrer';

        var legenda = document.createElement('p');
        legenda.className = 'foto-lightbox-nome';
        legenda.textContent = nome;

        caixa.append(img, legenda);
        fundo.appendChild(caixa);

        function fechar() {
            fundo.remove();
            document.removeEventListener('keydown', aoTeclar);
        }
        function aoTeclar(e) { if (e.key === 'Escape') fechar(); }

        fundo.addEventListener('click', fechar);
        document.addEventListener('keydown', aoTeclar);
        document.body.appendChild(fundo);
    }

    function logout() {
        limpar();
        try { sessionStorage.clear(); } catch (e) { /* noop */ }
        global.location.href = '/login.html';
    }

    global.SESSION = {
        API_BASE_URL: API_BASE_URL,
        getJwt: getJwt,
        getUsuario: getUsuario,
        sessaoValida: sessaoValida,
        salvarSessao: salvarSessao,
        requireAuth: requireAuth,
        temTela: temTela,
        apiFetch: apiFetch,
        secullumFetch: secullumFetch,
        loadCompanies: loadCompanies,
        fillCompanySelect: fillCompanySelect,
        carregarConfig: carregarConfig,
        fotoUrl: fotoUrl,
        iniciais: iniciais,
        avatar: avatar,
        abrirLightbox: abrirLightbox,
        logout: logout
    };
})(window);
