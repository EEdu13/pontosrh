# Como um sistema novo consome a IAM Larsil

> **Regra de ouro:** todo sistema fala com a IAM pela **Auth API (HTTP)**. **Nunca** leia as
> tabelas `IAM_*` direto, nem crie tabela de login/usuário própria. A tabela é detalhe interno;
> a API é o contrato. É isso que impede a volta da bagunça de "uma tabela de usuário por sistema".

A IAM (Painel ADM Larsil) roda em:
- **Produção:** `https://painelgestor.up.railway.app`
- **Local:** `http://localhost:4000`

Aponte sempre por uma env `IAM_URL` — nunca cravar a URL no código.
Autenticação por **JWT** (HS256). O token traz identidade + papéis + permissões + escopo.
Console da TI (gerenciar quem vê o quê): `<IAM_URL>/admin`.

---

## 1. Login — `POST /api/auth/login`

**Request**
```json
{ "login": "camila.reis", "senha": "..." }
```

**Response 200**
```json
{
  "token": "<JWT>",
  "senha_provisoria": false,
  "usuario": {
    "id": 60,
    "login": "camila.reis",
    "nome": "CAMILA ROCHA DOS REIS",
    "cpf": "…",              // pode ser null (contas de TI/serviço)
    "admin": false,
    "email": "…",           // pode ser null
    "telefone": "…",        // pode ser null
    "papeis": ["PCP"],
    "permissoes": ["pcp.acesso", "tarefas.criar", "..."],
    "escopos": [{ "tipo": "PROJETO", "valor": "801" }, { "tipo": "PROJETO", "valor": "820" }],
    "global": false
  }
}
```

**Erros**
- `401 { "erro": "Login ou senha inválidos" }`
- `403 { "erro": "Sua conta está desativada. Entre em contato com a TI da empresa.", "motivo": "INATIVO" }`
  → mostre essa mensagem ao usuário; a conta existe mas a TI desativou.

Se `senha_provisoria === true`, force o fluxo de 1º acesso (ver seção 4) antes de liberar o sistema.

---

## 1.5. Registrar o acesso ao seu sistema (aparece no perfil da pessoa)

Depois do login bem-sucedido, o seu backend chama **uma vez** (fire-and-forget, com o Bearer do
usuário) pra registrar que a pessoa **entrou no seu sistema**:

```js
// no login, após pegar o token:
fetch(`${IAM_URL}/api/auth/acesso`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ sistema: "CONTROLERH" }),   // o CÓDIGO do seu sistema
}).catch(() => {});   // não bloqueia o login se falhar
```

O IAM grava isso central (em `IAM_AUDITORIA`) e mostra no perfil da pessoa: *"acessou Controle RH em
12/08 14:30"*. **Você não escreve em tabela nenhuma do IAM** — é isso que dá o "sem permissão" quando se
tenta gravar direto; o certo é este endpoint.

## 2. Como o seu backend valida o token

Toda requisição do seu front manda o header:
```
Authorization: Bearer <JWT>
```

Seu backend valida de um dos dois jeitos (escolha um):

**A) Local (mais rápido)** — verifica a assinatura com o segredo compartilhado:
```js
const jwt = require("jsonwebtoken");
const payload = jwt.verify(token, process.env.JWT_SECRET); // MESMO segredo do .env da IAM
// payload = { sub, login, nome, cpf, admin, papeis, permissoes, escopos, global, iat, exp }
```
> Peça o `JWT_SECRET` ao dono da IAM (não está aqui e nunca vai pro git).

**B) Remoto (sem compartilhar segredo)** — pergunta pra IAM:
```
GET /api/auth/resolve   (com o Bearer)
→ { usuario_id, papeis, permissoes, escopos, global }
```
Use este quando quiser refletir mudança de permissão sem esperar o token expirar.

**Nunca confie em papel/escopo que venha do corpo/query do cliente. Só do token.**

---

## 3. Como aplicar permissão e escopo

**Permissão (pode ou não fazer a ação):**
```js
if (!payload.permissoes.includes("tarefas.criar")) return res.status(403).json({ erro: "sem permissão" });
```

**Escopo (o que a pessoa ENXERGA):** o token traz `escopos: [{tipo, valor}]` e `global`.
Regra: `global === true` (ou algum escopo `GLOBAL`) → vê tudo. Senão, filtra pelos escopos.
Tipos: `GLOBAL | COORDENADOR | SUPERVISOR | EQUIPE | PROJETO`.
Aplique o MESMO padrão em toda query (não reinvente por tela):

```js
// mapa: quais colunas da SUA tabela representam cada tipo
const MAPA = { COORDENADOR: "COORDENADOR", SUPERVISOR: "SUPERVISOR", EQUIPE: "EQUIPE", PROJETO: "PROJETO" };

function filtroEscopo(escopos, mapa) {
  if (!escopos?.length) return { clause: "1=0", params: [] };           // sem escopo = não vê nada (fail-safe)
  if (escopos.some(e => e.tipo === "GLOBAL")) return { clause: "1=1", params: [] }; // vê tudo
  const ors = [], params = []; let i = 0; const porTipo = {};
  for (const e of escopos) if (e.valor) (porTipo[e.tipo] ||= []).push(e.valor);
  for (const [tipo, vals] of Object.entries(porTipo)) {
    const col = mapa[tipo]; if (!col) continue;
    const names = vals.map(v => { const n = `esc${i++}`; params.push({ name: n, value: v }); return `@${n}`; });
    ors.push(`LTRIM(RTRIM(${col})) IN (${names.join(",")})`);
  }
  return ors.length ? { clause: `(${ors.join(" OR ")})`, params } : { clause: "1=0", params: [] };
}
// SELECT ... WHERE <suas condições> AND ${clause}   (bind cada params[])
```
> Detalhe importante: o valor de COORDENADOR/SUPERVISOR é o **nome** da pessoa, e ele casa com a
> coluna `COORDENADOR`/`SUPERVISOR` que já vem gravada em cada linha dos dados. Para EQUIPE/PROJETO
> o valor é o código.

---

## 4. Primeiro acesso — `POST /api/auth/onboarding`  (com Bearer)

Quando `senha_provisoria` for true, colete e envie:
```json
{ "novaSenha": "…", "telefone": "…", "email": "…" }
```
→ `200 { "ok": true }`. Depois disso a senha provisória vira definitiva e o onboarding fica marcado.

---

## 5. Plugar o SEU sistema na IAM — auto-registro por API (o jeito recomendado)

O sistema consumidor **declara ele mesmo** o próprio sistema + telas/permissões, via API. Aparece
sozinho no console `/admin` da TI — **sem ninguém rodar SQL e sem tocar no schema**. Você (dev) chama
uma vez no deploy (ou sempre que mudar suas telas); a IAM faz o upsert.

**A TI configura UMA vez** (no Railway) a env `REGISTRY_KEYS` — um JSON `sistema → chave` — e te passa
a SUA chave. Ex.: `REGISTRY_KEYS={"TAREFAS":"<chave-secreta>"}`. Sua chave só mexe no SEU sistema.

### `POST /api/registry/sync`  (header `X-Registry-Key: <sua-chave>`)
```json
{
  "nome": "Gerador de Tarefas",
  "url_base": "https://tarefas.larsil.com.br",
  "modo": "sync",
  "permissoes": [
    { "codigo": "tarefas.acesso",          "descricao": "Entrar no sistema" },
    { "codigo": "tarefas.tela:/",          "descricao": "Painel",         "grupo": "Início" },
    { "codigo": "tarefas.tela:/tarefas",   "descricao": "Minhas tarefas", "grupo": "Tarefas" },
    { "codigo": "tarefas.tela:/relatorios","descricao": "Relatórios",     "grupo": "Relatórios" }
  ]
}
```
Regras (validadas pela IAM):
- Toda permissão precisa ser do **namespace do seu sistema**: `tarefas.…` (não dá pra criar `pcp.*`).
- **Telas** seguem `tarefas.tela:<rota>` + `grupo` (a aba do menu) → ficam agrupadas no console, iguais
  às do PCP, prontas pra TI liberar/negar por pessoa e definir escopo.
- `modo: "merge"` (padrão) só cria/atualiza. `modo: "sync"` também **remove** as suas permissões que
  não vierem no manifesto (o manifesto vira a fonte da verdade). Só afeta o SEU sistema.
- `PCP` e `IAM` são reservados: a API recusa.

**Resposta** `200 { ok, sistema, criadas, atualizadas, removidas, permissoes_totais }`.
Confira o estado atual com `GET /api/registry/me` (mesma chave).

Depois do sync, quem libera cada tela pra cada pessoa e define o escopo
(COORDENADOR/SUPERVISOR/EQUIPE/PROJETO) é a TI, na tela **Usuários & Acessos** do `/admin` — sem SQL.

<details><summary>Alternativa manual (SQL, feito pela TI) — se preferir não usar a API</summary>

Sistema novo = **1 linha em `IAM_SISTEMAS` + N linhas em `IAM_PERMISSOES`** — nunca tabela de login.
(Hoje só existem os sistemas `PCP` e `IAM`; os mocks de exemplo foram removidos. Cadastre o seu do zero.)

```sql
INSERT INTO iam.IAM_SISTEMAS (CODIGO, NOME, URL_BASE) VALUES ('TAREFAS', 'Gerador de Tarefas', 'https://…');

-- Permissões de AÇÃO (pode ou não fazer):
INSERT INTO iam.IAM_PERMISSOES (CODIGO, SISTEMA_CODIGO, DESCRICAO) VALUES
  ('tarefas.acesso', 'TAREFAS', 'Entrar no sistema'),
  ('tarefas.criar',  'TAREFAS', 'Criar tarefa');
```

### 5.1 Telas (a parte "igual ao PCP")
Cada **tela/rota** do seu front vira uma permissão no padrão **`<sistema>.tela:<rota>`**, com um
**`GRUPO`** (o nome da aba/menu). É isso que faz a tela aparecer **agrupada no console da TI**, onde
ela libera/nega por pessoa e define o escopo — exatamente como fizemos no PCP:
```sql
INSERT INTO iam.IAM_PERMISSOES (CODIGO, SISTEMA_CODIGO, DESCRICAO, GRUPO) VALUES
  ('tarefas.tela:/',         'TAREFAS', 'Painel',        'Início'),
  ('tarefas.tela:/tarefas',  'TAREFAS', 'Minhas tarefas','Tarefas'),
  ('tarefas.tela:/relatorios','TAREFAS','Relatórios',    'Relatórios');
```
No seu front, monte o menu a partir das `permissoes` que vêm no token: mostre a rota só se
`permissoes.includes("tarefas.tela:/rota")` (mesma regra do `temAba` do PCP). Negar no console → some
no próximo `resolve`/F5.

### 5.2 Ligar aos papéis (quem já ganha por padrão)
```sql
-- ex.: todo mundo do papel COORDENADOR já entra e vê as telas base
INSERT INTO iam.IAM_PAPEL_PERMISSOES (PAPEL_ID, PERMISSAO_CODIGO)
SELECT p.ID, v.cod FROM iam.IAM_PAPEIS p
CROSS APPLY (VALUES ('tarefas.acesso'),('tarefas.tela:/'),('tarefas.tela:/tarefas')) v(cod)
WHERE p.NOME IN ('GERENCIA','COORDENADOR','SUPERVISOR','TI');
```
A pessoa só "tem" a permissão quando o papel concede (ou por exceção individual). Ajuste fino
(liberar/negar tela por pessoa, definir escopo COORDENADOR/SUPERVISOR/EQUIPE/PROJETO) é tudo na tela
**Usuários & Acessos** do console `/admin` — sem tocar em SQL.

</details>

---

## 5.3 Foto de perfil (avatar) — padrão de toda a Larsil

A identidade (IAM) **não** guarda foto. A foto de perfil é resolvida pelo **PCP**, na ordem
**upload do usuário → Unico People (fallback)**, e exposta por um endpoint único por nome:

```
<img src="{PCP_URL}/api/foto/{nome}">     → devolve a imagem (upload ou People), CORS liberado
```

No seu sistema, use o `NOME` que vem no token e mostre `<img>` com fallback pra iniciais no `onerror`.
Mantenha o `NOME` igual ao do cadastro (senão o casamento por nome erra o upload). Detalhes,
segurança e a melhoria por CPF: ver **UNICO-PEOPLE-FOTOS.md** (§7).

## 6. Checklist do projeto novo
- [ ] Não criar tabela de login/usuário própria
- [ ] Login chama `POST /api/auth/login` (nunca compara senha na mão)
- [ ] Backend valida o **JWT** em toda rota (seção 2) — não confia no cliente
- [ ] Permissão checada por `permissoes.includes("sistema.acao")`
- [ ] Escopo aplicado pelo helper único (seção 3), lendo do token — nunca da query
- [ ] Sistema + telas auto-registrados via `POST /api/registry/sync` (seção 5)
- [ ] Trata `senha_provisoria` (onboarding) e o `403 INATIVO` (mensagem "procure a TI")

---

*Referência viva: este projeto (`iam_larsil`). O Painel PCP (`timbertrack-hq`) já consome exatamente
assim — o `POST /api/auth/login` dele é um proxy+adaptador pra esta API. Use-o como exemplo real.*
