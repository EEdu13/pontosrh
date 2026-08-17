# Unico People — como buscar a foto do colaborador

Guia para exibir a **foto de perfil** de um colaborador em outro sistema (ex.: o de pontos).
Duas fontes, nesta prioridade: **1)** a foto que o usuário enviou (upload → Blob, tabela
`FOTO_PERFIL`, §7) e **2)** a foto da **Unico People** como fallback (§1–§6). Cobre
autenticação, as rotas, o casamento por nome, o upload seguro e as armadilhas medidas em
produção (ago/2026).

Implementação de referência já rodando:
[timbertrack-hq/server/lib/unico-people.cjs](timbertrack-hq/server/lib/unico-people.cjs)
(People) e as rotas `/api/foto-perfil` em `server/index.cjs` (upload/Blob).

---

## 1. O essencial em 30 segundos

```
1. token   = JWT-bearer (RS256) na service account  → identity.acesso.io/oauth2/token
2. id      = nome do colaborador → id da "position"  (índice montado da lista, ver §5)
3. detalhe = GET /v1/positions/{id}                  → profile.photo.path
4. foto    = GET /v1/r/{photo.path}  (Authorization: Bearer)  → os bytes da imagem (jpeg)
```

A foto **não** vem por CPF — a People não expõe CPF. O casamento é por **nome normalizado**
contra o seu cadastro (§4).

**Host certo:** `https://api.acessorh.com.br` (API pública). **Não** use
`https://admin.acessorh.com.br/svc2` — aquele é o backend interno do painel e só aceita a
sessão de navegador (cookie), devolve 401 pra token de serviço.

---

## 2. Autenticação (a mesma do Sign)

OAuth2 **JWT-bearer**. A mesma service account atende Sign e People — muda só o host da API.

1. Monte um JWT RS256 assinado com a chave privada PEM da service account:
   ```json
   header: { "alg": "RS256", "typ": "JWT" }
   claims: {
     "iss":   "<conta>@<tenantId>.iam.acesso.io",
     "aud":   "https://identity.acesso.io",
     "scope": "*",
     "iat":   <agora>,
     "exp":   <agora + 3600>
   }
   ```
   `aud` é o host de identidade **sem** `/oauth2/token`.
2. `POST` form-urlencoded para `https://identity.acesso.io/oauth2/token`:
   ```
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>
   ```
3. Use `Authorization: Bearer <access_token>` em toda chamada. Vale ~1h — cacheie e renove
   ~1 min antes de expirar.

```js
// Node — geração do token
const jwt = require("jsonwebtoken");
const key = fs.readFileSync(process.env.UNICO_PRIVATE_KEY_PATH, "utf8");
const now = Math.floor(Date.now() / 1000);
const assertion = jwt.sign(
  { iss: process.env.UNICO_ISSUER, aud: "https://identity.acesso.io", scope: "*", iat: now, exp: now + 3600 },
  key, { algorithm: "RS256" },
);
const body = new URLSearchParams();
body.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
body.append("assertion", assertion);
const r = await fetch("https://identity.acesso.io/oauth2/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
});
const { access_token } = await r.json();
```

```bash
# teste rápido de que a esteira está de pé
curl -s -X POST https://identity.acesso.io/oauth2/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer -d assertion="$JWT"
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.acessorh.com.br/v1/positions/$POSITION_ID" | head -c 300
```

Sem chave/issuer, degrade para "não conectado" em vez de estourar.

### Credenciais — o que vem de fora (não é código)

| Item | Vira |
|---|---|
| Service account `<conta>@<tenantId>.iam.acesso.io` | `UNICO_ISSUER` |
| Chave privada RSA (PEM PKCS#8/PKCS#1) — par da pública que sobe pra service account | `UNICO_PRIVATE_KEY_PATH` (**fora do git**) |
| Escopo de leitura da People habilitado nessa conta | sem isso, `/v1/positions` responde 401/403 |

Valores em uso na Larsil (produção):

```
UNICO_ISSUER=larsil@56fcfe56-3bbe-4c11-b35a-54e313982064.iam.acesso.io
UNICO_AUTH_URL=https://identity.acesso.io/oauth2/token
UNICO_PEOPLE_API_URL=https://api.acessorh.com.br
UNICO_PRIVATE_KEY_PATH=<caminho da .pem no servidor>
```

A `.pem` é a mesma do projeto `unicosign`. Copie para o novo servidor e **mantenha fora do git.**

---

## 3. As três rotas

Todas em `https://api.acessorh.com.br`, com `Authorization: Bearer <token>`.

### `GET /v1/positions/{id}` — detalhe (é aqui que está o caminho da foto)

100% confiável. Devolve, entre outros campos:

```jsonc
{
  "id": "f483a8e9-…",
  "status": { "name": "active" },
  "profile": {
    "name":  "RAFAEL DA SILVA",
    "email": "rs…@gmail.com",
    "photo": { "path": "individual/18bd3609-…/person/brazil/6c5d6565-….jpeg" }
  }
}
```

- `profile.photo.path` é o que interessa. Pode vir **ausente** (pessoa sem foto) — trate como
  "sem foto", não como erro.
- **Não vem CPF** neste payload. Por isso o casamento é por nome (§4).

### `GET /v1/r/{path}` — os bytes da foto

`path` é o `profile.photo.path` cru. Devolve a imagem (`content-type: image/jpeg`), com o
mesmo Bearer. Exemplo real: `individual/18bd3609-…/person/brazil/6c5d6565-….jpeg`.

> **Valide o caminho antes de montar a URL** (vem da API, mas trate como não confiável):
> sem esquema `http://`, sem `..`, e casando `^(individual|organization)/[\w./-]+$`.

### `GET /v1/positions?{query}` — lista (só para DESCOBERTA)

Instável de propósito: devolve um **subconjunto aleatório** do cadastro, com 200-vazio e 500
no meio, e **não pagina**. Serve só para descobrir que ids existem e montar o índice nome→id
(§5). **Nenhuma tela de usuário deve depender dela** — a entrega usa sempre o detalhe por id.

---

## 4. Casamento por nome (não há CPF)

Normalize dos dois lados com a **mesma** função e case por igualdade exata:

```js
const norm = (s) => String(s || "")
  .toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "") // sem acento
  .replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
```

Índice derivado `nomeNormalizado -> id`:

- Entre posições da **mesma** pessoa (readmissão gera outra position), prefira a `active`.
- Nome que o **seu cadastro** não distingue (2+ CPFs com o mesmo nome normalizado) → **não
  case**, foto nenhuma. Quem sabe quais nomes são ambíguos é o dono do banco: levante a lista
  (uma linha por pessoa → agrupe por nome normalizado → nome com 2+ CPFs é ambíguo) e injete.

Não afrouxe o casamento em si: casar por primeiro+último token colide de verdade — descarte.
Cobertura medida na Larsil: **406 de 445 ativos (91%)** já no índice inicial, subindo com as
varreduras.

---

## 5. O índice (descoberta em background)

Como a lista é instável, monte um índice que **só cresce** e sobrevive a restart. Cada
varredura acumula ids diferentes; a cobertura sobe com o tempo, não com a sorte de uma chamada.

```jsonc
// arquivo em disco (~350 KB)
{
  "atualizado": 1785334414403,
  "posicoes": {
    "f483a8e9-…": { "n": "RAFAEL DA SILVA", "e": "rs…@gmail.com", "s": "dismissal" }
  }
}
```

**Parâmetros reais da lista** (o resto é ignorado):
- `status` — `400`=ativos, `500`=desligados, `501`=recusados. Filtra de verdade.
- `limit` — teto **1000**.
- `sort=admission_date` com `order=asc|desc`.

**Variantes** (alterne a cada chamada; não corte as de inativos — metade do cadastro é
`dismissal`, e histórico costuma cair aí):

```js
const VARIANTES = [
  "?sort=admission_date&order=asc&limit=1000",
  "?status=500&limit=1000",
  "?sort=admission_date&order=desc&limit=1000",
  "?status=501&limit=1000",
  "?limit=1000",
  "?status=400&sort=admission_date&order=desc&limit=1000",
];
```

**Cadência (contraintuitiva):** varredura **curta**, intervalo **longo**. Insistir numa
varredura satura rápido (a API seca); repetir espaçado rende muito. Parâmetros usados:

```
MAX_CHAMADAS 24 · SEM_NOVIDADE 12 · PAUSA_MS 700 · BUDGET_MS 300000 · REDESCOBRIR 30 min
```

Dispare por **timer**, não só por demanda — senão num dia sem acesso o índice congela.
Coalesça varreduras concorrentes (uma em voo por vez). **Escrita atômica**: grave num temp no
mesmo diretório → `fsync` → `rename` (escrever direto trunca o arquivo; um restart no meio
zerava o índice e reconstruir custa dias).

> Se você só precisa **mostrar foto de quem já apareceu**, pode até começar com um índice
> semente (copie o `unico-people-index.json` existente) e ligar a varredura por cima.

---

## 6. Entrega + rota-proxy (não vaze o token pro front)

O token é segredo do servidor. O front pede `/api/people-foto/{positionId}` e o **seu**
servidor faz stream da imagem. Três camadas de segurança: a rota exige UUID, o host é fixo
(sem SSRF), o caminho da foto casa a allowlist.

```js
// resolve nome -> id -> caminho -> stream
async function baixarFoto(id) {
  const d = await apiGet(`/v1/positions/${id}`);          // detalhe (cache ~5 min)
  const caminho = d?.profile?.photo?.path;
  if (!caminho || /^[a-z]+:\/\//i.test(caminho) || caminho.includes("..") ||
      !/^(individual|organization)\/[\w./-]+$/.test(caminho)) return null;
  return apiGet(`/v1/r/${caminho}`);                       // Response do fetch (stream)
}

// rota-proxy — o front nunca vê o token
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get("/api/people-foto/:pos", async (req, res) => {
  const pos = String(req.params.pos || "").trim();
  if (!UUID_RE.test(pos)) return res.status(404).end();     // id validado na rota
  const up = await baixarFoto(pos);
  if (!up || !up.ok) return res.status(404).end();
  res.set("Content-Type", up.headers.get("content-type") || "image/jpeg");
  res.set("Cache-Control", "private, max-age=3600");        // PRIVADO: é PII
  res.send(Buffer.from(await up.arrayBuffer()));            // ou stream, se preferir
});
```

No front, é só um `<img src="/api/people-foto/{positionId}">`. Como `<img>` não manda
`Authorization`, deixe **essa rota isenta de auth** — o id é UUID e a foto já é servida com
`Cache-Control: private`.

O que o front precisa saber é o **positionId** de cada pessoa. Duas formas:
- o backend já anexa `foto: "/api/people-foto/{id}"` ao montar a lista (recomendado — o front
  não sabe de id nenhum); ou
- expõe `GET /api/people/id?nome=...` que devolve o id por nome, e o front monta a URL.

---

## 7. Foto de preferência do usuário (upload → Blob) e a ordem de prioridade

A foto do People é o **fallback**. Por cima dela existe a foto que a pessoa (ou um admin)
**envia** — essa vira a foto de perfil dela em todo o sistema. É a tabela que o painel de
usuários usa como fonte da foto.

### Ordem de prioridade (o resolvedor de foto)

Para um nome, resolva nesta ordem e pare no primeiro que existir:

```
1. FOTO_PERFIL (upload do usuário)   → /api/foto-perfil/{nomeNorm}
2. foto manual legada (se houver)    → /api/foto-supervisor/{nome}
3. Unico People (por nome)           → /api/people-foto/{positionId}
4. nada → iniciais no front
```

Chave de casamento em todos: **nome normalizado** (mesma `norm` da §4). A `FOTO_PERFIL`
também guarda CPF, pra o painel de usuários poder juntar por CPF.

### Endpoint único `GET /api/foto/:nome` (o que OUTROS sistemas consomem)

Dentro do PCP a ordem acima é resolvida no helper `fotoDe()` ao montar as listas. Para **outros
sistemas** (o Painel ADM Larsil/IAM, o gerador de tarefas, etc.) existe **um endpoint por nome** que
faz a mesma resolução e **stream** dos bytes (não redirect), com **CORS liberado**:

```
GET https://<pcp>/api/foto/<nome>     →  upload (FOTO_PERFIL) senão Unico People, como image/*
   Access-Control-Allow-Origin: *     →  consumível de qualquer origem, via <img> ou fetch
```

No consumidor é só `<img src="{PCP_URL}/api/foto/{nome}">` (ex.: o IAM lê `FOTO_BASE_URL` = URL do PCP).
Onde não houver foto → 404 → o front mostra as iniciais.

> ⚠️ **Casamento é por NOME** (normalizado). Se o nome que o sistema consumidor tem for **diferente**
> do nome com que a foto foi enviada, ele **erra o upload e cai no People**. Medido em produção:
> conta cujo `NOME` estava encurtado ("EDUARDO FERREIRA") não achava o upload salvo como
> "EDUARDO FERREIRA DA SILVA". **Regra:** mantenha o `NOME` do consumidor igual ao do cadastro
> (COLABORADORES). **Melhoria recomendada:** o upload passar a gravar **CPF** em `FOTO_PERFIL` e o
> resolvedor aceitar `?cpf=` — casar por CPF elimina o problema de nome de vez.

> ⚠️ **Cache × troca de foto.** O `/api/foto` responde com `Cache-Control` (upload curto, People
> mais longo). Depois de uma troca, o consumidor pode ver a foto antiga até o cache expirar — um
> **hard-refresh** (Ctrl+Shift+R) mostra na hora. Se precisar refletir mais rápido, baixe o
> `max-age` do fallback do People (hoje 3600s) pra ~60–120s.

### A tabela `FOTO_PERFIL`

A imagem **não** fica no banco — vai pro Blob e o banco guarda só a **URL**. (Guardar
varbinary funciona, mas incha o backup; o Blob é o certo pra imagem.)

```sql
CREATE TABLE dbo.FOTO_PERFIL (
  ID            INT IDENTITY(1,1) PRIMARY KEY,
  NOME_NORM     VARCHAR(200) NOT NULL UNIQUE,  -- chave: nome normalizado
  NOME          VARCHAR(200) NULL,             -- nome original (exibição)
  CPF           VARCHAR(11)  NULL,             -- pro painel de usuários juntar por CPF
  IMAGEM        VARBINARY(MAX) NULL,           -- legado (bytes); hoje fica NULL
  URL           VARCHAR(500) NULL,             -- URL pública no Blob (o que se usa)
  MIME          VARCHAR(50)  NULL,
  ATUALIZADO_EM DATETIME     NOT NULL DEFAULT GETDATE()
);
```

`MERGE` por `NOME_NORM` (upsert): um registro por pessoa; re-upload troca a URL.

### Blob de imagens (mesmo storage do resto)

- Conta: `checklistfilesferre` · container `boletim` · subpasta `perfil/`.
- Credencial: um **SAS de escrita** (`sp=racwdli`, inclui create+write), guardado em
  `FOTO_BLOB_SAS_URL` (a URL completa do container **com** o `?sas`). **Fora do git.**
- Nome do blob: `perfil/{slug-do-nome}_{timestamp}.{ext}` — o timestamp evita cache velho e
  colisão no re-upload.
- Upload é um `PUT` simples (sem SDK):

```js
async function subirFotoBlob(buf, mime, slug) {
  const sasUrl = process.env.FOTO_BLOB_SAS_URL;                 // https://conta.blob.../boletim?sp=...&sig=...
  const ext = { "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif" }[mime] || "jpg";
  const blobName = `perfil/${slug.replace(/[^a-z0-9]+/gi,"-").slice(0,60)}_${Date.now()}.${ext}`;
  const [base, qs] = sasUrl.split("?");
  const up = await fetch(`${base}/${blobName}?${qs}`, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": mime },
    body: buf,
  });
  if (!up.ok) throw new Error("falha upload blob " + up.status);
  return `${base}/${blobName}`;   // URL pública, SEM o sas
}
```

### As rotas

```js
// POST /api/foto-perfil  { nome, cpf?, imagemBase64 }
//   - AUTORIZAÇÃO (IDOR): admin altera qualquer um; usuário comum só a própria foto
//     (norm(nome) === norm(req.usuario.nome)).
//   - VALIDA A IMAGEM PELOS BYTES MÁGICOS, não pelo MIME que o cliente mandou — recusa SVG
//     (SVG carrega script e, servido same-origin, vira XSS armazenado).
app.post("/api/foto-perfil", async (req, res) => {
  const nome = String(req.body?.nome || "").trim();
  if (!nome) return res.status(400).json({ error: "nome é obrigatório" });
  const ehAdmin = !!(req.usuario && (req.usuario.admin || req.usuario.global));
  const proprio = norm(nome) === norm(req.usuario?.nome || "");
  if (!ehAdmin && !proprio) return res.status(403).json({ error: "sem permissão" });

  const m = String(req.body?.imagemBase64 || "").match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
  if (!m) return res.status(400).json({ error: "imagemBase64 inválida" });
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 100 || buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: "tamanho inválido" });
  const mime = sniffImagem(buf);                 // ← só JPG/PNG/WEBP/GIF, por magic bytes
  if (!mime) return res.status(400).json({ error: "formato não suportado" });

  const url = await subirFotoBlob(buf, mime, norm(nome));
  // MERGE dbo.FOTO_PERFIL por NOME_NORM: grava URL, zera IMAGEM, guarda NOME/CPF/MIME
  res.json({ ok: true, url: "/api/foto-perfil/" + encodeURIComponent(norm(nome)) });
});

// GET /api/foto-perfil/:nome  → proxia o Blob pela NOSSA origem (same-origin p/ html2canvas
//   e p/ os headers de segurança). Só sai pra *.blob.core.windows.net, sem seguir redirect.
//   Isenta de auth (entra via <img>).
app.get("/api/foto-perfil/:nome", async (req, res) => {
  // SELECT URL, IMAGEM, MIME ... WHERE NOME_NORM=@nn
  const mime = MIME_IMG_OK.has(row.MIME) ? row.MIME : "image/jpeg";  // allowlist raster
  res.set("Content-Type", mime);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", "inline; filename=\"foto\"");
  res.set("Content-Security-Policy", "default-src 'none'; sandbox");
  res.set("Cache-Control", "private, max-age=60");
  // se row.URL: valida host blob.core.windows.net + fetch(redirect:"manual") → stream
  // senão: serve row.IMAGEM (legado)
});

// DELETE /api/foto-perfil/:nome → mesma trava do POST (admin ou dono). Volta pra foto padrão.
```

```js
// magic bytes: recusa SVG/HTML; aceita só raster
function sniffImagem(buf) {
  if (buf.length < 12) return null;
  if (buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) return "image/jpeg";
  if (buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4e && buf[3]===0x47) return "image/png";
  if (buf[0]===0x47 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x38) return "image/gif";
  if (buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 &&
      buf[8]===0x57 && buf[9]===0x45 && buf[10]===0x42 && buf[11]===0x50) return "image/webp";
  return null;
}
const MIME_IMG_OK = new Set(["image/jpeg","image/png","image/gif","image/webp"]);
```

### Front

Clicar na foto abre um lightbox com **Enviar/Trocar foto** e **Remover**. Depois do upload,
mostra a nova (cache-bust com `?t=Date.now()`) e recarrega as telas que exibem foto. Serve
por `<img src="/api/foto-perfil/{nomeNorm}">`, então o GET fica **isento de auth** (o POST/DELETE
exigem login).

### Variáveis novas

```
FOTO_BLOB_SAS_URL=https://checklistfilesferre.blob.core.windows.net/boletim?sp=racwdli&st=...&se=2030-...&sig=...
```

> O SAS tem validade (`se=`). Renove antes de vencer — sem ele o upload responde 500
> "SAS não configurada"/403. O de leitura pública do container não precisa de SAS.

---

## 8. Checklist de porte

- [ ] Auth JWT-bearer RS256 com cache de token (~1h). Chave `.pem` **fora do git**.
- [ ] Host `https://api.acessorh.com.br` (não o `/svc2`).
- [ ] Índice persistente (disco/volume, não container efêmero) com escrita atômica.
- [ ] Varredura em background: round-robin de variantes, teto de chamadas, corte por
      saturação, timer ~30 min, coalescing.
- [ ] Casamento por **nome normalizado** (mesma `norm` dos dois lados), com descarte de
      ambíguos do lado do seu cadastro.
- [ ] Entrega **sempre** por `/v1/positions/{id}`; a foto por `/v1/r/{path}` com o Bearer.
- [ ] Rota-proxy `/api/people-foto/:id` — UUID validado, caminho na allowlist, `Cache-Control:
      private`, isenta de auth (é servida a `<img>`).
- [ ] **Foto de preferência**: tabela `FOTO_PERFIL`, upload pro Blob (guarda só a URL),
      resolvedor na ordem upload → manual → People.
- [ ] **Upload seguro**: autorização admin-ou-dono (anti-IDOR), validação por **magic bytes**
      (recusa SVG), serve com `nosniff` + `Content-Disposition: inline` + CSP sandbox.
- [ ] `FOTO_BLOB_SAS_URL` configurada em cada ambiente (inclusive produção).
- [ ] Degradação graciosa sem credenciais — nunca exceção.

---

## 9. Armadilhas já pagas

- **Host errado.** `admin.acessorh.com.br/svc2` é o painel; exige sessão de navegador e tem
  reCAPTCHA no login — não dá pra automatizar. A API de serviço é `api.acessorh.com.br`.
- **Sem CPF na People.** Todo o casamento é por nome. Se seu sistema tem CPF e quer conferir,
  o CPF vem de **outra** fonte (o cadastro de RH / o Unico **Sign**, que traz CPF+nome), nunca
  da People.
- **A lista mente sobre paginação.** `offset`/`skip` são ecoados mas não deslocam; `count` é
  parcial, não o total. Trate a lista como amostragem, não como página.
- **Escrever o índice direto trunca.** Um restart no meio da escrita zerava tudo. Temp →
  fsync → rename.
- **Foto é PII.** `Cache-Control: private`, nunca `public`. E não exponha o token ao front —
  sempre pela rota-proxy.
- **Upload de imagem é vetor de XSS.** Aceitar `image/svg+xml` e servir same-origin deixa
  rodar script. Valide pelos **bytes**, não pelo MIME do cliente, e nunca ecoe o MIME dele.
- **IDOR no upload.** Sem checar identidade, qualquer logado troca a foto de qualquer um.
  Admin-ou-dono no POST **e** no DELETE.
- **Dois SAS no mesmo storage, um vencido.** O container `boletim` tem SAS até 2030
  (`sp=racwdli`); o `fotos-checklist` venceu. Confira `sp=` (precisa de `c`+`w`) e `se=`
  (validade) antes de usar um SAS.
- **Blob deu 403 "AuthenticationFailed"?** SAS vencido, sem permissão de escrita, ou o `sig`
  veio URL-encoded (`%3D`) quando devia estar cru — copie o SAS exatamente como está no `.env`.

*Números e comportamentos medidos contra a API de produção em ago/2026. A API não é documentada
nesses pontos — se algo mudar, re-meça antes de mexer.*
