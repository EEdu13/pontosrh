# 📋 Funcionalidade de Justificativas Implementada

## 🎯 Resumo
Adicionados dropdowns de justificativas no modal de OCR, buscando dados da API Secullum e permitindo seleção de justificativas de Folha.

---

## ✅ Mudanças Implementadas

### 1. **Frontend (index.html)**

#### Variáveis Globais
```javascript
let justificativasSecullum = [];
let justificativasFolha = [];
```

#### Função de Busca da API Secullum
```javascript
async function fetchJustificativas()
```
- **Endpoint**: `GET /IntegracaoExterna/Justificativas`
- **Headers**: Authorization (Bearer token) + secullumidbancoselecionado
- **Retorno**: Array com `NomeAbreviado`, `NomeCompleto`, `ValorDia`, etc.
- **Chamada**: Após autenticação bem-sucedida

#### Função de Popular Dropdowns
```javascript
function populateJustificativasDropdowns()
```
- Popula `#selectJustificativaSecullum` com dados da API
- Popula `#selectJustificativaFolha` com dados hardcoded:
  - Atestado Médico
  - Falta Justificada
  - Férias
  - Licença
  - Compensação
  - Trabalho Remoto
  - Ajuste de Ponto

#### HTML do Modal
```html
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
    <div>
        <label>📋 Justificativa Secullum</label>
        <select id="selectJustificativaSecullum">...</select>
    </div>
    <div>
        <label>📋 Justificativa Folha</label>
        <select id="selectJustificativaFolha">...</select>
    </div>
</div>
```

#### CSS Adicionado
- Hover effects para os dropdowns
- Focus effects com borda azul e shadow

#### Atualização no `confirmarAnexo()`
```javascript
const justificativaSecullum = document.getElementById('selectJustificativaSecullum')?.value || null;
const justificativaFolha = document.getElementById('selectJustificativaFolha')?.value || null;

// Adicionado ao payload:
payload.justificativa_secullum = justificativaSecullum;
payload.justificativa_folha = justificativaFolha;
```

---

### 2. **Backend (server.js)**

#### Novos Parâmetros no Upload Endpoint
```javascript
let { ..., justificativa_secullum, justificativa_folha } = req.body;
```

#### SQL Atualizado
```sql
-- INSERT
INSERT INTO ANEXOS (..., justificativa_secullum, justificativa_folha)
VALUES (..., @justificativa_secullum, @justificativa_folha)

-- UPDATE
UPDATE ANEXOS SET 
    ...,
    justificativa_secullum = @justificativa_secullum,
    justificativa_folha = @justificativa_folha
```

---

### 3. **Banco de Dados (Azure SQL)**

#### Script de Migração: `add_justificativas_columns.sql`
```sql
ALTER TABLE ANEXOS ADD justificativa_secullum VARCHAR(255) NULL;
ALTER TABLE ANEXOS ADD justificativa_folha VARCHAR(255) NULL;
```

**❗ IMPORTANTE**: Execute este script no Azure SQL Database antes de fazer upload de anexos.

---

## 🚀 Como Usar

1. **Execute o script SQL** no Azure SQL:
   ```bash
   # Conecte ao Azure SQL e execute:
   add_justificativas_columns.sql
   ```

2. **Deploy do backend** (Railway):
   ```bash
   git add server.js
   git commit -m "Add justificativas support"
   git push
   ```

3. **Abra o sistema** e faça login:
   - O sistema automaticamente busca as justificativas da Secullum
   - Ao abrir o modal de OCR, os dropdowns estarão populados

4. **Selecione as justificativas** ao enviar anexo:
   - Escolha uma justificativa Secullum (opcional)
   - Escolha uma justificativa Folha (opcional)
   - Confirme o envio

---

## 📊 Fluxo de Dados

```
1. Login → Autenticação Secullum
              ↓
2. fetchJustificativas() → GET /IntegracaoExterna/Justificativas
              ↓
3. Armazena em justificativasSecullum[]
              ↓
4. populateJustificativasDropdowns()
              ↓
5. Usuário abre modal de OCR → Dropdowns preenchidos
              ↓
6. Usuário seleciona justificativas
              ↓
7. confirmarAnexo() → Envia para backend
              ↓
8. Backend salva no Azure SQL (ANEXOS table)
```

---

## 🎨 Aparência

- **Dropdowns lado a lado** (grid 1fr 1fr)
- **Labels com emoji** 📋
- **Cores escuras** (rgba(15, 23, 42, 0.8))
- **Hover azul** (#3b82f6)
- **Focus com shadow** (glow effect)
- **Integrado com estilo do modal** (dark theme)

---

## 🔍 Verificação

Para verificar se está funcionando:

1. Abra o console do navegador (F12)
2. Faça login
3. Procure por:
   ```
   📋 Buscando justificativas...
   ✅ X justificativas Secullum carregadas
   ✅ 7 justificativas Folha carregadas
   ✅ Dropdowns de justificativas populados
   ```

4. Abra modal de OCR em qualquer registro
5. Veja os dropdowns preenchidos
6. Selecione e confirme
7. No console:
   ```
   📋 Justificativas selecionadas: { secullum: "...", folha: "..." }
   ```

---

## 📝 Próximos Passos (Opcional)

- [ ] Exibir justificativas na tabela principal
- [ ] Filtrar registros por justificativa
- [ ] Adicionar justificativas no PDF gerado
- [ ] Relatório de justificativas mais usadas
- [ ] Buscar justificativas Folha do banco (dinâmico)

---

## 🐛 Troubleshooting

### Dropdowns vazios?
- Verifique autenticação Secullum (token válido)
- Confira secullumidbancoselecionado no header
- Veja console para erros 403/500

### Erro ao salvar?
- Execute o script SQL primeiro
- Verifique se as colunas foram criadas:
  ```sql
  SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ANEXOS'
  ```

### Justificativas não aparecem no banco?
- Confirme que os valores não são `null` no payload
- Veja logs do backend (Railway)
- Teste query manualmente no Azure SQL

---

**✅ Implementação Completa!**
