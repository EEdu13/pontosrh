/* ==========================================================================
   session.js — Sessão compartilhada entre as páginas do sistema.

   Os tokens são obtidos UMA vez, no login (login.html → POST /api/auth/login),
   e guardados no localStorage. Nenhuma página carrega credenciais: se o token
   não existe ou expirou, o usuário volta para a tela de login.
   ========================================================================== */
(function (global) {
    'use strict';

    var SECULLUM_AUTH_BASE = 'https://autenticador.secullum.com.br';
    var SECULLUM_API_BASE = 'https://pontowebintegracaoexterna.secullum.com.br';

    var API_BASE_URL = global.location.hostname === 'localhost'
        ? 'http://localhost:3000'
        : global.location.origin;

    var redirecionando = false;

    function irParaLogin(motivo) {
        if (redirecionando) return;
        redirecionando = true;
        if (motivo) console.warn('🔒 ' + motivo);
        localStorage.clear();
        global.location.href = '/login.html';
    }

    /** Token da API Secullum salvo no login. Redireciona se ausente/expirado. */
    function getSecullumToken(opts) {
        var token = localStorage.getItem('secullum_token');
        var expiry = parseInt(localStorage.getItem('secullum_token_expiry') || '0', 10);

        if (!token || !expiry || Date.now() >= expiry) {
            if (!opts || opts.redirect !== false) {
                irParaLogin('Sessão expirada.');
            }
            return null;
        }
        return token;
    }

    /** JWT da aplicação (backend Node). */
    function getJwt() {
        return localStorage.getItem('token') || sessionStorage.getItem('token');
    }

    /** Exige sessão válida logo no carregamento da página. */
    function requireAuth() {
        return getSecullumToken() !== null;
    }

    /** Fetch para a API do backend, já com o JWT e tratamento de 401/403. */
    function apiFetch(path, options) {
        options = options || {};
        var jwt = getJwt();

        if (!jwt) {
            irParaLogin('Sem token de aplicação.');
            return Promise.reject(new Error('Não autenticado'));
        }

        var headers = Object.assign(
            { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
            options.headers || {}
        );

        var url = path.indexOf('http') === 0 ? path : API_BASE_URL + path;

        return fetch(url, Object.assign({}, options, { headers: headers }))
            .then(function (response) {
                if (response.status === 401 || response.status === 403) {
                    irParaLogin('Token da aplicação inválido ou expirado.');
                }
                return response;
            });
    }

    /** Fetch direto na API Secullum, com o token do usuário. */
    function secullumFetch(path, options) {
        options = options || {};
        var token = getSecullumToken();
        if (!token) return Promise.reject(new Error('Não autenticado'));

        var headers = Object.assign(
            { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            options.headers || {}
        );
        if (options.bancoId) headers.secullumidbancoselecionado = String(options.bancoId);

        var base = options.auth ? SECULLUM_AUTH_BASE : SECULLUM_API_BASE;
        var url = path.indexOf('http') === 0 ? path : base + path;

        return fetch(url, Object.assign({}, options, { headers: headers }));
    }

    /** Lista as empresas (bancos) que o usuário logado enxerga. */
    function loadCompanies() {
        return secullumFetch('/ContasSecullumExterno/ListarBancos', { auth: true })
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

    function logout() {
        localStorage.clear();
        sessionStorage.clear();
        global.location.href = '/login.html';
    }

    global.SESSION = {
        API_BASE_URL: API_BASE_URL,
        getSecullumToken: getSecullumToken,
        getJwt: getJwt,
        requireAuth: requireAuth,
        apiFetch: apiFetch,
        secullumFetch: secullumFetch,
        loadCompanies: loadCompanies,
        fillCompanySelect: fillCompanySelect,
        logout: logout
    };
})(window);
