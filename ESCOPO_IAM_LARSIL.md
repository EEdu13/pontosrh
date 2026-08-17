# Escopo — Ecossistema de Usuário Único (IAM Larsil)

> Documento de escopo para iniciar a construção do sistema de identidade e acesso unificado da Larsil.
> Gerado a partir de investigação real do banco de produção (Azure SQL `Tabela_teste`) e de um protótipo
> já validado com dados reais. Use este arquivo como ponto de partida em uma pasta/projeto novo.

---

## 1. Objetivo

Criar **um único usuário por colaborador**, que dá acesso a todos os sistemas da Larsil de acordo com o
papel e o escopo daquela pessoa — sem precisar de um cadastro por sistema, sem mexer direto no banco
pelo Devart, e sem tabela de login própria em cada app novo.

A visão final: um colaborador loga uma vez (SSO) e, dentro da intranet ("Larsil Conecta" / gerenciador de
tarefas estilo rede social interna), vê os sistemas que pode usar, o organograma, e as tarefas atribuídas
a ele. A criação de usuário e a concessão de acesso ficam num **console de TI separado** (não dentro do
app social), delegado por área.

---

## 2. O problema hoje (achado real no banco)

Banco: Azure SQL `alrflorestal.database.windows.net` / database `Tabela_teste` (253 tabelas).
Conexão já existe em `timbertrack-hq/.env` (DB_SERVER, DB_DATABASE, DB_USER, DB_PASSWORD) — **nunca**
copiar a senha para este documento ou para o repositório; sempre ler do `.env`.

- **26 tabelas de usuário fragmentadas**, uma por sistema: `USUARIOS` (existe em 3 schemas: dbo, inventario,
  Ges_Frota), `HELPDESK_USUARIOS`, `EPI_USUARIOS`, `FRETE_USUARIOS`, `MAQ_USUARIOS`, `MANUTENCAO_USUARIOS`,
  `TAREFA_USUARIOS`, `PEDIDOS_USUARIOS`, `OUVIDORIA_USUARIOS`, `CURRICULOS_USUARIOS`,
  `CADASTROS_USUARIOS`, `CONV_USUARIOS`, `CONVERSOR_USUARIOS`, `CONT_USUARIOS`, `tb_usuarios_bot`,
  `admin_users`, `DDS_ADMINS`, `SYS_PATRIMONIO_USERS`, `PAINEL_USUARIOS`, `UsuarioProjetos`, entre outras.
- **Senha em texto puro** na maioria delas (exceções: `FRETE_USUARIOS` usa `senha_hash`, `MAQ_USUARIOS`
  usa webauthn).
- **Login com SQL injection** em pelo menos um sistema (senha concatenada direto na query).
- Resultado prático: contratar ou trocar a função de alguém vira uma rodada de Devart em várias tabelas.

### As sementes do modelo certo (já existem, só espalhadas)

| Tabela existente | O que já faz de certo |
|---|---|
| `PAINEL_USUARIOS` | LOGIN, SENHA, PERFIL, COORDENADOR, SUPERVISOR, **PROJETOS** (JSON) |
| `PAINEL_PERFIS` | NOME do papel + **PERMISSOES** (JSON de rotas) + **ESCOPO_TIPO** (all/coordenador/supervisor) |
| `UsuarioProjetos` | vínculo N:N usuário↔projeto |
| `PROJETOS` | mestre dos projetos (código, cliente, coordenador, status) |
| `tb_usuarios_bot` | permissão por ação: `PODE_APONTAMENTO`, `PODE_REFEICAO`, `PODE_APROVAR`, `PODE_JUSTIFICAR` |
| `ORGANOGRAMA` | COORDENADOR → SUPERVISOR → LIDER → EQUIPE → PROJETO, já tem `TREINADO` e `DATA_COBRANCA` (por equipe) |
| `COLABORADORES` | mestre de RH: CPF, NOME, PROJETO, EQUIPE, COORDENADOR, SUPERVISOR, SETOR, SITUACAO |

A proposta abaixo **generaliza esse modelo do Painel PCP** para todos os sistemas — não é reinventar.

---

## 3. Arquitetura proposta — tabelas `IAM_*`

```
IAM_USUARIOS            -- 1 identidade por pessoa: login, senha_hash, nome, email, cpf (liga em COLABORADORES), ativo
IAM_SISTEMAS            -- catálogo dos apps: codigo, nome, url_base, ativo
IAM_PERMISSOES          -- permissão granular: codigo ("sistema.modulo.acao"), sistema_codigo, descricao
IAM_PAPEIS              -- papéis: nome (SUPERVISOR, COORDENADOR, LIDER, PCP, GERENCIA...), escopo_tipo
IAM_PAPEL_PERMISSOES    -- quais permissões cada papel concede por padrão
IAM_USUARIO_PAPEIS      -- quais papéis cada usuário tem
IAM_USUARIO_ESCOPO      -- usuario_id, tipo (GLOBAL/COORDENADOR/SUPERVISOR/EQUIPE/PROJETO), valor (a âncora)
IAM_USUARIO_PERMISSOES  -- exceções por usuário: tipo (CONCEDER | NEGAR), permissao_codigo
IAM_USUARIO_TREINAMENTOS-- usuario_id, sistema_codigo, treinado (bit), data_treinamento, treinado_por
IAM_AUDITORIA           -- quem criou/alterou qual acesso, quando
```

### 3.1 O motor de escopo (a peça central)

Em vez de manter uma lista de "o que essa pessoa vê", cada usuário guarda **um tipo de filtro + uma
âncora**, e toda query usa o mesmo padrão genérico — nunca um `if (papel === X)` espalhado pelo código:

```sql
SELECT * FROM COLABORADORES
WHERE
  (@escopo_tipo = 'GLOBAL')
  OR (@escopo_tipo = 'COORDENADOR' AND COORDENADOR = @escopo_valor)
  OR (@escopo_tipo = 'SUPERVISOR'  AND SUPERVISOR  = @escopo_valor)
  OR (@escopo_tipo = 'EQUIPE'      AND EQUIPE       = @escopo_valor)
  OR (@escopo_tipo = 'PROJETO'     AND PROJETO      = @escopo_valor)
```

| Cargo | tipo | valor (âncora) | Resolve |
|---|---|---|---|
| Gerente / donos | `GLOBAL` | (nenhum) | vê tudo |
| Coordenador | `COORDENADOR` | nome dele | puxa todos supervisores/líderes/equipes abaixo, em quantos projetos for |
| Supervisor (ope/adm) | `SUPERVISOR` | nome dele | puxa todos os líderes dele — resolve sozinho o caso de supervisor com vários projetos |
| Líder | `EQUIPE` | código da equipe | visão mais fechada, só a equipe dele |
| Analista de PCP | `PROJETO` | código do projeto | vê tudo do projeto, não importa quem é supervisor/líder |

**Segunda dimensão (opcional, combinável):** setor/área (ADM vs operação) para casos como "supervisor ADM
vê sistemas + estagiários dele" — soma-se ao filtro de escopo, não é um tipo novo.

**Exceção negativa:** "supervisor XXX não tem acesso ao RH" é resolvido por uma linha em
`IAM_USUARIO_PERMISSOES` com `tipo = 'NEGAR'` — sem isso, só dá pra conceder, nunca revogar um caso pontual.

---

## 4. Login único (SSO) — fluxo

1. Usuário digita login e senha **uma vez**, em qualquer app ou na intranet.
2. Auth API confere contra `IAM_USUARIOS` (senha com hash).
3. Gera um **token JWT** com `{ papeis, permissoes[], projetos/escopo }`.
4. Token fica em cookie compartilhado entre os domínios `*.larsil`.
5. Cada app só **valida o token** e libera conforme `permissoes[]` e escopo — nenhum app faz login próprio.

---

## 5. Criação de usuário — quem faz o quê (administração delegada)

**TI cria só a casca (identidade).** Chega uma OS ("contratou fulano, CPF tal") → TI cria
`IAM_USUARIOS` com estado `PENDENTE_CONFIGURACAO`. Trabalho de cartório, sem julgamento de negócio.

**O setor (PCP, ou quem for dono da área) atribui o acesso de verdade.** O usuário pendente cai numa fila
(aba "Usuários pendentes" dentro do próprio Painel PCP) e lá alguém:
- escolhe o **papel** (Supervisor, Líder, Coordenador...)
- atribui **escopo** (projeto(s) ou equipe)
- ajusta **exceções** (negar um módulo específico)
- confirma o **treinamento** (ver seção 6)

Por quê: TI não tem — e não deve ter — o conhecimento operacional de quem responde por qual projeto/equipe.
Centralizar isso em TI vira gargalo. Quem sabe é o setor.

### 5.1 Onde mora a tela de administração

**Separado do app social/gerenciador de tarefas** ("Larsil Conecta" / o "Facebook" da empresa), mesmo que
viva no mesmo domínio. Motivo: o app social é usado por 100% da empresa o dia todo — colocar concessão de
permissão sensível ali aumenta a superfície de risco e amarra a IAM ao ciclo de vida de um produto só.

- **Console de Usuários & Acessos**: pode viver dentro do timbertrack/Painel PCP (que já tem
  `PAINEL_USUARIOS`/`PAINEL_PERFIS`), visível só a papel ADM/TI. É quem **escreve** na IAM.
- **App social / gerenciador de tarefas**: só **lê** da IAM (perfil, organograma, quem é subordinado de
  quem). Nunca grava permissão. No máximo, um botão "solicitar acesso" que abre um pedido de aprovação.

---

## 6. Treinamento / certificação por sistema

Não é um flag único no perfil — é **por sistema** (`IAM_USUARIO_TREINAMENTOS`). A mesma pessoa pode estar
treinada no App de Campo e não no Painel PCP.

- `treinado_por` = quem certificou (o mesmo supervisor/PCP que atribui papel/escopo).
- `data_treinamento` = a partir de quando vale.
- Em sistemas que **geram cobrança/faturamento**, o treinamento funciona como um segundo portão, além da
  permissão: `IAM_SISTEMAS.exige_treinamento_para_valer` decide se, sem treinamento, a ação é bloqueada,
  aceita-mas-marcada-para-revisão, ou só registrada para auditoria.
- **Futuro**: tutoriais dentro dos apps com "aceitar termos / concluí o treinamento" marcando
  `treinado = true` automaticamente, sem depender de alguém preencher isso manualmente.
- Já existe uma versão embrionária disso: `ORGANOGRAMA.TREINADO` e `DATA_COBRANCA` (mas por equipe, não
  por pessoa+sistema) — este design generaliza o que vocês já sentiram falta.

---

## 7. Como todo sistema novo deve nascer

**Regra de ouro: sistema novo = 1 linha em `IAM_SISTEMAS` + N linhas em `IAM_PERMISSOES`. Nunca uma
tabela de usuário nova.**

```sql
-- 1) registrar o sistema
INSERT INTO IAM_SISTEMAS (codigo, nome, url_base, ativo)
VALUES ('DDS', 'DDS Digital', 'https://dds.larsil.app', 1);

-- 2) declarar as permissões dele
INSERT INTO IAM_PERMISSOES (codigo, sistema_codigo, descricao) VALUES
('dds.registro.criar',   'DDS', 'Aplicar um DDS para a equipe'),
('dds.registro.assinar', 'DDS', 'Assinar presença no DDS'),
('dds.tema.gerenciar',   'DDS', 'Cadastrar/editar temas de DDS'),
('dds.relatorio.ver',    'DDS', 'Ver relatório de aplicação de DDS');

-- 3) opcional: todo LÍDER já ganha as duas primeiras, sem cadastrar ninguém de novo
INSERT INTO IAM_PAPEL_PERMISSOES (papel_id, permissao_codigo)
SELECT (SELECT ID FROM IAM_PAPEIS WHERE NOME='LIDER'), 'dds.registro.criar'
UNION ALL
SELECT (SELECT ID FROM IAM_PAPEIS WHERE NOME='LIDER'), 'dds.registro.assinar';
```

```js
// no backend do app — nunca senha própria
const user = await authApi.login(username, password);
if (!user.permissoes.includes('dds.registro.criar')) return res.status(403)...;
db.query('SELECT * FROM DDS_REGISTROS WHERE PROJETO IN (@projetos)', user.projetos);
```

### Checklist para o README de todo projeto novo
- [ ] Não criar tabela de login/usuário própria
- [ ] Registrar o sistema em `IAM_SISTEMAS`
- [ ] Listar as permissões com prefixo do sistema (`dds.*`, `epi.*`...)
- [ ] Decidir quais papéis já ganham quais permissões por padrão
- [ ] Backend valida o token da Auth API — nunca senha própria
- [ ] Toda query de escopo usa `user.projetos`/`user.escopo`, nunca reimplementa

---

## 8. Migração dos sistemas que já existem (strangler fig)

Sistema por sistema, sem parar nada:

| Etapa | O que faz |
|---|---|
| A | Importar usuários da tabela antiga para `IAM_USUARIOS`, casando por CPF. Nada é apagado. |
| B | Mapear o `PERFIL` antigo para os papéis novos (`IAM_PAPEIS`). |
| C | Trocar só a rota de login do app para chamar a Auth API. |
| D | Rodar em paralelo 1–2 semanas — login antigo como fallback. |
| E | Renomear a tabela antiga para `_OLD` e, depois, aposentar de vez. |

**Ordem de prioridade (não é alfabética):**
1. Senha exposta + acesso externo primeiro (Frotas, EPI, HelpDesk) — risco de segurança real.
2. Sistemas mais usados depois (Painel PCP, App de Campo) — maior ganho de "1 login só".
3. Ferramentas de baixo uso por último, ou nem migrar — só reduzir o acesso.

---

## 9. Governança (pra não virar bagunça de novo)

- **Template de projeto obrigatório**: todo sistema novo nasce de um template que já vem com o middleware
  da Auth API pronto — sem rota de login própria disponível.
- **Revisão antes de ir ao ar**: nenhum `CREATE TABLE` com SENHA/LOGIN; login chamando a Auth API;
  permissões novas declaradas em `IAM_PERMISSOES`.
- **Só um dono mexe na IAM central**: devs não criam papel/permissão livremente no banco — pedem, o dono
  aprova e insere.
- **README de uma página**: "Este projeto usa a IAM central. Não crie tabela de usuário. Para pedir
  permissão nova, abra um chamado."

---

## 10. Protótipo já validado (prova de conceito com dado real)

Local: `APRESENTACAO/prototipo-escopo/` (server.cjs + index.html + `.env` local, não versionar).

- 3 personas reais extraídas do `ORGANOGRAMA`: **Coordenador** Toniel Rodrigues (9 projetos, 20 equipes),
  **Supervisor** Mauricio Serpe (3 projetos: 702/704/708), **Líder** Rodrigo Jose Passos (equipe 841AA).
- Tela 1 lê `HISTORICO_BDO` (145 mil linhas reais) aplicando o filtro genérico de escopo — dado 100% real.
- Tela 2 grava um apontamento de teste em `APONTAMENTOS_CAMPO` (marcado `empresa='TESTE-PROTOTIPO'`, fácil
  de limpar depois) e lê de volta com o mesmo filtro.
- **Provado**: o apontamento enviado pelo líder apareceu na visão dele e na do coordenador acima (hierarquia
  se propaga corretamente) e **não apareceu** na visão de um supervisor de outra cadeia (isolamento correto).
- Uma 3ª aba comparou a ordenação real de atividades (`SERVICO` vs `CODIGO_DE_APONTAMENTO` concatenado) —
  achado à parte, não bloqueia este projeto, mas mostra o valor de validar sempre com dado real.

---

## 11. Próximos passos sugeridos (para o novo chat/projeto)

1. Criar as tabelas `IAM_*` no banco (schema acima) num ambiente de teste primeiro.
2. Escrever a Auth API central (Node/Express, reaproveitando o padrão de conexão do `timbertrack-hq`).
3. Escolher o primeiro sistema a migrar (sugestão: um dos com senha exposta — HelpDesk, EPI ou Frotas).
4. Construir a tela "Usuários & Acessos" dentro do Painel PCP (fila de pendentes + atribuição de
   papel/escopo/treinamento).
5. Escrever o template de projeto novo (middleware de Auth API pronto) para os próximos sistemas.

---

*Documento gerado em julho/2026 a partir de discussão e investigação real do banco `Tabela_teste`
(Azure SQL, alrflorestal.database.windows.net). Não contém segredos — a senha do banco vive apenas em
arquivos `.env` locais, nunca neste documento.*
