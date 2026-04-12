# EMAIL_AUTH.md — OAuth Setup Wizard for Multi-User IMAP Proxy

> Levantamento de requisitos para substituir `/curve/config` por um wizard
> passo-a-passo que configura automaticamente o `email-oauth2-proxy` por
> cada utilizador, eliminando a necessidade de acesso ao terminal.

---

## 1. Contexto e Problema

### O que mudou nos providers de email

A Microsoft desactivou basic authentication (login com password directa) para
IMAP/POP em Outubro 2022 para tenants empresariais e em Setembro 2024 para
contas pessoais (outlook.com, hotmail.com, live.com). A Google fez o mesmo
para contas sem 2FA. O único mecanismo suportado é **OAuth 2.0 (XOAUTH2)**,
que exige um application registration, um consent flow interactivo, e gestão
contínua de access/refresh tokens.

### Como o Embers resolvia

O pipeline original usava `offlineimap` (cliente IMAP) ligado a
`email-oauth2-proxy` (bridge local), que traduzia plain IMAP LOGIN em
XOAUTH2 contra os servidores Microsoft. O setup era inteiramente por
terminal: editar `emailproxy.config`, correr o proxy interactivamente para
obter o consent, depois instalar como serviço systemd. Funcionou para um
user, mas:

- Quando o refresh token expirava, o proxy retornava zero emails
  **silenciosamente** — sem erros no log
- Re-autorização exigia SSH ao servidor + interacção com prompt interactivo
- Adicionar um segundo user significava editar ficheiros de configuração à mão

### O que o Curve Sync precisa

Um onboarding **web-only** onde o utilizador:

1. Nunca toca num terminal
2. Nunca vê as palavras "IMAP", "OAuth", ou "config file"
3. Autoriza o acesso ao email num wizard guiado com linguagem simples
4. Pode re-autorizar se os tokens expirarem, pela mesma via

O backend gere o `emailproxy.config` automaticamente, reinicia o proxy
quando necessário, e monitoriza o estado dos tokens por conta.

---

## 2. Arquitectura Geral

### 2.1 Topologia actual (single-user, terminal)

```
Curve Sync → 127.0.0.1:1993 → email-oauth2-proxy → XOAUTH2 → outlook.com
                                  emailproxy.config (1 conta, tokens encriptados)
```

### 2.2 Topologia alvo (multi-user, web wizard)

```
User A ─┐
User B ─┼→ Curve Sync → 127.0.0.1:1993 → email-oauth2-proxy → XOAUTH2 → outlook.com
User C ─┘                                  emailproxy.config (N contas, mesma porta)
```

### 2.3 Porta partilhada — sem porta por user

- Proxy diferencia contas pelo username no IMAP LOGIN
- Todos os Outlook partilham `[IMAP-1993]`, todos os Gmail partilham `[IMAP-2993]`
- Secção server define-se uma vez; secções account multiplicam-se

### 2.4 Componentes envolvidos

- Frontend: wizard React (nova página ou sub-rota de `/curve/config`)
- Backend Express: novos endpoints `/api/curve/proxy/*`
- emailproxy.config: INI file gerido pelo backend (ConfigParser-compatible)
- systemd unit: `email-oauth2-proxy.service` (restart após config change)
- Azure AD App Registration: um app partilhado por todos os users

---

## 3. Fluxos OAuth Suportados

### 3.1 Device Authorization Grant (DAG) — recomendado para Outlook

O fluxo mais simples para o utilizador. Não envolve redirect URIs nem
copy-paste de URLs longas.

**Sequência técnica:**

1. Backend faz POST ao device authorization endpoint:
   ```
   POST https://login.microsoftonline.com/common/oauth2/v2.0/devicecode
   Content-Type: application/x-www-form-urlencoded

   client_id=<AZURE_CLIENT_ID>&scope=https://outlook.office.com/IMAP.AccessAsUser.All offline_access
   ```

2. Resposta contém:
   ```json
   {
     "device_code": "GAB...long-opaque-string",
     "user_code": "A1B2C3D4",
     "verification_uri": "https://microsoft.com/devicelogin",
     "expires_in": 900,
     "interval": 5
   }
   ```

3. Frontend exibe `user_code` em destaque + link para `verification_uri`.

4. User abre `microsoft.com/devicelogin` (em qualquer dispositivo — telefone,
   tablet, outro PC), insere o código, faz login, e autoriza a app.
   A app aparece como o nome registado no Azure AD (e.g. "Thunderbird" ou
   "Curve Sync" conforme o app registration usado).

5. Backend faz polling ao token endpoint a cada `interval` segundos:
   ```
   POST https://login.microsoftonline.com/common/oauth2/v2.0/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=urn:ietf:params:oauth:grant-type:device_code
   &client_id=<AZURE_CLIENT_ID>
   &device_code=<device_code>
   ```

6. Enquanto o user não autorizar, a resposta é `{ "error": "authorization_pending" }`.
   Após autorizar: `{ "access_token": "...", "refresh_token": "...", "expires_in": 3600 }`.

7. Backend escreve os tokens encriptados no `emailproxy.config` (ver secção 4).

**Vantagens:** zero copy-paste, funciona cross-device, timeout generoso (15 min).
**Limitação:** só funciona com Microsoft (Azure AD). Google não suporta DAG
para IMAP scopes em apps não-verificadas.

### 3.2 External Auth (paste-back) — fallback universal

Fluxo standard OAuth 2.0 authorization_code adaptado para headless. O proxy
já suporta nativamente com a flag `--external-auth`.

**Sequência técnica:**

1. Backend constrói a permission URL:
   ```
   https://login.microsoftonline.com/common/oauth2/v2.0/authorize
     ?client_id=<AZURE_CLIENT_ID>
     &redirect_uri=http://localhost
     &scope=https://outlook.office.com/IMAP.AccessAsUser.All offline_access
     &response_type=code
     &login_hint=user@example.com
   ```

2. Frontend mostra URL clicável. User abre no browser, faz login, autoriza.

3. Browser tenta redirigir para `http://localhost?code=ABC123&state=XYZ`.
   Como não há nada a escutar no localhost do user, a página mostra
   "localhost refused to connect" — **isto é esperado e normal**.

4. O user copia o URL completo da barra de endereço do browser
   (incluindo o `?code=...`).

5. User cola o URL no campo de input do wizard.

6. Backend extrai o `code`, troca-o por tokens via POST ao token endpoint,
   encripta-os, e escreve no `emailproxy.config`.

**Alternativa subprocess:** em vez de o backend fazer o token exchange
directamente, pode spawnar o proxy com `--external-auth --no-gui` e
alimentar o redirect URL via stdin. Isto garante que a encriptação dos
tokens usa exactamente o algoritmo do proxy (PBKDF2-HMAC-SHA256 → Fernet).
Tradeoff: mais complexo, mas zero risco de incompatibilidade cripto.

**Vantagens:** funciona com qualquer provider OAuth 2.0.
**Desvantagem:** exige copy-paste de URL (passo extra manual).

### 3.3 Quando usar qual

| Domínio do email | Fluxo | Motivo |
|------------------|-------|--------|
| `@outlook.*`, `@hotmail.*`, `@live.*`, `@microsoft.com` | DAG | UX superior, suportado nativamente |
| `@gmail.com`, `@googlemail.com` | External Auth | Google não suporta DAG para IMAP |
| Outros (`@empresa.com` com O365) | DAG (tentar) → External Auth (fallback) | Depende do tenant |

O wizard auto-detecta pelo domínio e pré-selecciona o fluxo, com opção
de override manual (link "Usar método alternativo" discreto).

---

## 4. Gestão do `emailproxy.config`

### 4.1 Formato do ficheiro (INI / ConfigParser)

O `emailproxy.config` usa formato INI standard (Python `configparser`,
`interpolation=None`). Três tipos de secção:

**Secções server** — definem o listener local e o servidor remoto:
```ini
[IMAP-1993]
server_address = outlook.office365.com
server_port = 993
local_address = 127.0.0.1
```

**Secções account** — uma por email, com OAuth params e tokens cached:
```ini
[user@outlook.com]
permission_url = https://login.microsoftonline.com/common/oauth2/v2.0/authorize
token_url = https://login.microsoftonline.com/common/oauth2/v2.0/token
oauth2_scope = https://outlook.office.com/IMAP.AccessAsUser.All offline_access
redirect_uri = http://localhost
client_id = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
client_secret = xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

; --- campos auto-geridos pelo proxy (nunca editar manualmente) ---
token_salt = <base64>
token_iterations = 1200000
access_token = <fernet-encrypted>
access_token_expiry = 1712345678
refresh_token = <fernet-encrypted>
last_activity = 1712345678
```

Para DAG, adicionar: `oauth2_flow = device`

**Secção global** (opcional):
```ini
[emailproxy]
delete_account_token_on_password_error = True
allow_catch_all_accounts = False
```

### 4.2 Templates pré-preenchidos

O backend mantém templates por provider. Ao adicionar uma conta, preenche
tudo excepto os tokens (que vêm do fluxo OAuth).

**Outlook (O365 + personal):**
```ini
permission_url = https://login.microsoftonline.com/common/oauth2/v2.0/authorize
token_url = https://login.microsoftonline.com/common/oauth2/v2.0/token
oauth2_scope = https://outlook.office.com/IMAP.AccessAsUser.All offline_access
redirect_uri = http://localhost
client_id = ${AZURE_CLIENT_ID}
client_secret = ${AZURE_CLIENT_SECRET}
oauth2_flow = device
```

**Gmail:**
```ini
permission_url = https://accounts.google.com/o/oauth2/auth
token_url = https://oauth2.googleapis.com/token
oauth2_scope = https://mail.google.com/
redirect_uri = http://localhost
client_id = ${GOOGLE_CLIENT_ID}
client_secret = ${GOOGLE_CLIENT_SECRET}
```

Os valores `${...}` são substituídos por env vars na escrita do ficheiro —
nunca ficam literalmente no config.

### 4.3 Operações CRUD sobre o config

O backend implementa um serviço `ProxyConfigManager` que encapsula:

| Operação | Detalhes |
|----------|----------|
| **Read** | Parse INI com `ini` npm package (ou regex simples — não precisa de full parser). Listar secções `[email@]`, verificar se email existe, ler `last_activity` para health check. |
| **Create** | Adicionar secção `[email@...]` com template do provider. Se secção server (`[IMAP-1993]`) não existir, criá-la também. |
| **Update** | Reescrever campos de uma secção (e.g. mudar `oauth2_flow`). Nunca tocar nos campos `token_*` / `access_token` / `refresh_token`. |
| **Delete** | Remover secção `[email@...]` inteira (incluindo tokens). Útil para cleanup ou re-setup. |
| **Locking** | `flock()` no file descriptor durante read-modify-write para evitar race conditions com o proxy (que também escreve tokens) e com outros wizards concorrentes. |

**Implementação recomendada:** ler ficheiro → parse com regex por secção →
manipular como Map de secções → serializar → escrever atómicamente (write
to temp + rename). O proxy usa `configparser` que tolera BOM, comentários
`#` e `;`, e linhas em branco entre secções.

### 4.4 Localização e permissões

| Aspecto | Valor |
|---------|-------|
| Path | `EMAIL_PROXY_CONFIG_PATH` env var, default `/home/pi/email-oauth2-proxy/emailproxy.config` |
| Permissions | `0600` (owner read+write only) |
| Owner | Mesmo user que corre o proxy (e.g. `pi`) |
| Backend access | Leitura e escrita directa (o Express corre como `pi` ou tem permissão) |
| Proxy access | Leitura e escrita (guarda tokens após auth e refresh) |
| Symlink | Suportado — o path pode ser um symlink para outro directório |

**Se o backend correr como user diferente do proxy:** usar um grupo
partilhado (e.g. `curve-sync`) com permissions `0660` e garantir que
ambos os processos pertencem ao grupo.

---

## 5. Wizard — Passos do Frontend

### 5.0 Boas-vindas / Splash

**Objectivo:** Explicar porquê, o quê, como — sem jargão técnico.
Transformar um processo intimidante ("OAuth IMAP proxy config") numa
narrativa simples.

**Conteúdo sugerido (3 blocos):**

> **Porquê** — "Os serviços de email como Outlook e Gmail deixaram de
> aceitar passwords directas por questões de segurança."
>
> **O quê** — "O Curve Sync precisa de ler os teus recibos do Curve Pay.
> Para isso, vais autorizar o acesso como se estivesses a configurar o
> Thunderbird — é um processo standard e seguro."
>
> **Como** — "O setup demora menos de 2 minutos. Vais inserir o teu email,
> autorizar o acesso uma vez, e o Curve Sync trata do resto automaticamente."

**Acção:** botão "Começar" → passo 1.

**Design:**
- Card centrado, max-width `32rem`, `animate-fade-in-up`
- Ícone de envelope com escudo (segurança + email) no topo — SVG inline,
  `text-curve-700`, `h-16 w-16`, centrado
- Texto: `text-sm text-sand-700`, parágrafos com `space-y-3`
- Botão: `btn-primary` full-width, texto "Começar"
- Fundo: sem card border, floating no `sand-50` global
- Step indicator (0/4) discreto no topo — pills ou dots em `sand-300`,
  activo em `curve-700`

---

### 5.1 Email do Curve Pay

**Objectivo:** Recolher o email que recebe os recibos Curve e auto-detectar
o provider para escolher o fluxo OAuth certo.

**Input:** campo email com validação em tempo real:
- Formato email (regex básico, não over-engineer)
- Trim whitespace, lowercase
- Debounce 500ms antes de chamar backend

**Backend check:** `GET /api/curve/proxy/accounts/:email/exists`
- Se email já existe no `emailproxy.config`:
  - Para o **mesmo** user_id → "Esta conta já está configurada. Queres
    re-autorizar?" com opção de avançar (re-auth) ou cancelar
  - Para **outro** user_id → "Este email já está associado a outra conta
    do Curve Sync." Bloqueio. Link para contactar admin.
- Se email não existe → proceed

**Auto-detect de provider:**
```
@outlook.com, @outlook.pt, @hotmail.com, @hotmail.pt,
@live.com, @live.pt, @msn.com             → Microsoft (DAG)
@gmail.com, @googlemail.com               → Google (external-auth)
Outros                                     → Unknown (pedir escolha manual)
```

**Pitfalls:**
- Emails `@empresa.com` podem ser O365 — o wizard não sabe. Oferecer
  toggle manual "A minha empresa usa Microsoft 365" → activa DAG.
- Email typo → o user só descobre no passo 2 quando o login falha.
  Confirmar email visualmente antes de avançar.

**Design:**
- Input centrado, `text-lg`, com ícone de envelope à esquerda (input group)
- Após validação: badge de provider aparece com `animate-fade-in`:
  - Microsoft: ícone Outlook (ou genérico MS) + "Microsoft" em `text-xs`
  - Google: ícone Gmail + "Google"
  - Unknown: ícone `?` + "Provider desconhecido — vamos tentar"
- Helper text abaixo: "O email da conta que recebe os recibos do Curve Pay.
  Não é necessariamente a tua conta Embers."
- Botão: "Continuar" (disabled até email válido + check backend OK)
- Step indicator: 1/4 activo

---

### 5.2 Autorização OAuth

**Objectivo:** Obter o consent do user junto do provider e capturar os
tokens OAuth. Este é o passo mais complexo e o que mais beneficia de UX
cuidado.

#### 5.2.A — Variante DAG (Microsoft)

**Sequência no frontend:**

1. User chega ao passo → frontend faz `POST /api/curve/proxy/auth/start`
   com `{ email, flow: "device" }`.

2. Backend responde com `{ user_code: "A1B2C3D4", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900 }`.

3. Frontend mostra:
   - Código em destaque (fonte mono, `text-3xl font-bold text-curve-700`,
     `tracking-[0.3em]`, fundo `curve-50 rounded-xl px-6 py-4`)
   - Botão "Copiar código" (clipboard API) com feedback visual (ícone
     check durante 2s)
   - Link/botão "Abrir microsoft.com/devicelogin" (`target="_blank"`)
   - Instruções numeradas:
     1. "Clica no botão abaixo para abrir a página da Microsoft"
     2. "Cola o código quando pedido"
     3. "Faz login com a tua conta de email"
     4. "Autoriza o acesso — vai aparecer 'Thunderbird' (ou o nome da app),
        é normal"
     5. "Volta a esta página — o Curve Sync detecta automaticamente quando
        terminas"

4. Frontend inicia polling: `GET /api/curve/proxy/auth/poll` a cada 5s.
   - `{ status: "pending" }` → manter spinner
   - `{ status: "authorized" }` → avançar para passo 3
   - `{ status: "expired" }` → mostrar "O código expirou. Tentar de novo?"
   - `{ status: "declined" }` → mostrar "A autorização foi recusada.
     Tentar de novo?"

5. Countdown timer visual: barra de progresso ou texto "Expira em X:XX"
   decrementando. Ao expirar sem autorização, oferecer retry.

**Explainer "Thunderbird":** banner `amber-50` discreto:
> "Na página da Microsoft vai aparecer uma app chamada 'Thunderbird'
> (ou similar) a pedir permissão para ler o teu email. É esperado —
> o Curve Sync usa a mesma identificação que clientes de email como o
> Thunderbird para aceder aos teus recibos. Nenhum email é partilhado
> com terceiros."

#### 5.2.B — Variante External Auth (Google / outros)

**Sequência no frontend:**

1. User chega ao passo → frontend faz `POST /api/curve/proxy/auth/start`
   com `{ email, flow: "authorization_code" }`.

2. Backend responde com `{ permission_url: "https://accounts.google.com/o/oauth2/auth?client_id=...&scope=...&redirect_uri=http://localhost&..." }`.

3. Frontend mostra:
   - Botão "Abrir página de autorização" (link para `permission_url`,
     `target="_blank"`)
   - Instruções numeradas com mini-ilustrações (screenshots estilizados):
     1. "Clica no botão para abrir a página do Google"
     2. "Faz login e autoriza o acesso"
     3. "O browser vai mostrar uma página de erro — é normal!"
     4. "Copia o endereço **completo** da barra do browser"
     5. "Cola aqui em baixo"
   - Input `textarea` com placeholder: "Cola aqui o URL da barra de
     endereço (começa por http://localhost?code=...)"
   - Botão "Validar" (disabled até input não-vazio)

4. User cola o URL → frontend faz `POST /api/curve/proxy/auth/complete`
   com `{ email, redirect_url: "..." }`.

5. Backend extrai `code` do URL, faz token exchange, guarda tokens.
   - Sucesso → `{ status: "authorized" }` → avançar para passo 3
   - Erro → `{ error: "invalid_code" }` → "O URL não contém um código
     válido. Confirma que copiaste o endereço completo."

**Pitfalls:**
- User copia só parte do URL (sem `?code=`) → validação frontend antes
  de enviar (regex: contém `code=`)
- User demora > 10 min → código expira → mensagem clara + retry
- User nega permissão → redirect URL contém `error=access_denied` →
  mensagem amigável
- Popup blocker → instruções para permitir popups ou copiar URL manualmente

**Design (ambas variantes):**
- Card centrado, duas áreas: esquerda = instruções, direita = acção
  (ou stacked em mobile)
- Progress states com ícone:
  - `⏳ A aguardar autorização...` (spinner `curve-300`)
  - `✓ Autorizado com sucesso!` (`emerald-700`, `animate-fade-in`)
  - `✗ Expirado / Recusado` (`red-50`, retry button)
- Transição entre estados: `animate-fade-in`, opacity swap
- Step indicator: 2/4 activo

---

### 5.3 Verificação e Pasta

**Objectivo:** Confirmar que a cadeia inteira funciona (proxy → IMAP →
servidor) e deixar o user escolher a pasta IMAP.

**Sequência:**

1. Chegada ao passo → backend automaticamente:
   a. Gera encryption password (random 24 chars, base64url) → guarda no
      `CurveConfig.imap_password` (encriptado AES-256-GCM)
   b. Escreve/actualiza secção no `emailproxy.config`
   c. Restart do proxy (`systemctl restart email-oauth2-proxy`)
   d. Espera 2s para o proxy arrancar
   e. Testa ligação IMAP (`POST /api/curve/test-connection` internamente)
   f. Se OK → lista de pastas

2. Frontend mostra checklist sequencial (cada item aparece após o anterior):
   ```
   ⏳ A preparar proxy...        → ✓ Proxy configurado
   ⏳ A reiniciar serviço...     → ✓ Serviço activo
   ⏳ A testar ligação IMAP...   → ✓ Ligação OK
   ⏳ A obter pastas...          → ✓ X pastas encontradas
   ```

3. Após sucesso → dropdown de pasta IMAP aparece com `animate-fade-in`.
   - Se "Curve Receipts" existe → pré-seleccionada com destaque
   - Se não existe → INBOX seleccionada, com hint "Não encontrámos
     'Curve Receipts'. Confirma que a pasta existe na tua conta de email."

4. Selecção de pasta auto-salva (debounce 300ms, como a config actual).

**Pitfalls:**
- Proxy não arranca → checar `journalctl` output, mostrar "O serviço de
  proxy não conseguiu arrancar. Contacta o administrador." com detalhes
  técnicos colapsáveis.
- Auth failed → tokens inválidos (password errada ou tokens corrompidos).
  Oferecer "Voltar ao passo anterior" para re-autorizar.
- Timeout no restart → retry com backoff (2s, 4s, 8s). Se 3 falhas →
  mensagem de erro com contexto.
- Pasta "Curve Receipts" não existe → não bloquear, mas avisar. O user
  pode querer usar outra pasta ou criar a regra no email primeiro.

**Design:**
- Checklist vertical com ícones: spinner SVG (`curve-300`) → checkmark
  SVG (`emerald-600`) → cross SVG (`red-500`)
- Cada item: `flex items-center gap-3`, texto `text-sm text-sand-700`
- Spacing entre items: `space-y-3`
- Dropdown de pasta: aparece só após checklist completa, com
  `animate-fade-in-up` e border `emerald-200` (sucesso visual)
- Erro: item falha com `text-red-600`, detalhes em `<details>` colapsável
  com `text-xs text-sand-500 font-mono`
- Step indicator: 3/4 activo

---

### 5.4 Activar Sincronização

**Objectivo:** Confirmar tudo, configurar schedule, e activar a
sincronização automática.

**Conteúdo:**

1. **Card resumo** (read-only):
   | Campo | Valor |
   |-------|-------|
   | Email | user@outlook.com |
   | Provider | Microsoft (ícone) |
   | Pasta | Curve Receipts |
   | Proxy | 127.0.0.1:1993 (activo) |
   | Último teste | há 30 segundos ✓ |

2. **Inputs editáveis:**
   - Intervalo sync: number input, default 5 min, range 1–60
   - Toggle: "Sincronização automática activa" (default on)

3. **Botão:** "Activar Curve Sync" (`btn-primary`, full-width, `text-base`)

4. **On submit:**
   - `PUT /api/curve/config` com todos os campos
     (imap_server=127.0.0.1, imap_port=1993, imap_tls=false,
     imap_username=email, imap_folder, sync_enabled, sync_interval_minutes,
     confirm_folder=true)
   - Se sync_enabled → scheduler.start()
   - Redirige para `/` (dashboard) ou mostra inline:
     "Curve Sync activo! A primeira sincronização vai correr dentro de
     X minutos." com link para Logs.

**Pós-activação (primeira visita ao dashboard):**
- Badge na sidebar: "Sync activo" em `emerald-100 text-emerald-700`
- Se primeira sync já correu: stat card com contagem de despesas importadas

**Design:**
- Card com border `sand-200`, padding generoso
- Resumo: grid de 2 colunas, labels `text-xs text-sand-400 uppercase`,
  valores `text-sm font-medium text-sand-900`
- Inputs no fundo do card com separator `border-t border-sand-100 pt-4`
- Botão: full-width, `py-3`, com micro-animação no hover (scale 1.01)
- Sucesso: background do card transiciona brevemente para `emerald-50`
  (300ms) antes de redirigir
- Step indicator: 4/4 activo (cheio)

---

## 6. Backend — Novos Endpoints

### 6.1 Proxy Management

#### `GET /api/curve/proxy/status`

Verifica se o proxy está instalado e a correr. Usado no arranque do wizard
para mostrar erros antes de o user começar.

```
Response 200:
{
  "installed": true,
  "running": true,
  "config_path": "/home/pi/email-oauth2-proxy/emailproxy.config",
  "config_writable": true,
  "accounts_count": 3
}

Response 200 (not installed):
{
  "installed": false,
  "running": false,
  "error": "emailproxy.py not found at /home/pi/email-oauth2-proxy"
}
```

Implementação: `fs.existsSync(VENV_PATH)`, `child_process.exec('systemctl is-active email-oauth2-proxy')`, `fs.accessSync(CONFIG_PATH, fs.constants.W_OK)`.

#### `GET /api/curve/proxy/accounts/:email/exists`

Verifica se um email já tem secção no `emailproxy.config`. Usado no
passo 5.1 para prevenir duplicados.

```
Response 200:
{ "exists": true, "has_tokens": true, "owner_user_id": "665a..." }

Response 200:
{ "exists": false }
```

Implementação: parse INI, procurar secção `[email]`, verificar se
`access_token` existe (→ `has_tokens`). Cross-reference com
`CurveConfig.findOne({ imap_username: email })` para saber o owner.

#### `POST /api/curve/proxy/accounts`

Adiciona uma nova conta ao `emailproxy.config` com template do provider.

```
Request:
{
  "email": "user@outlook.com",
  "provider": "microsoft"
}

Response 201:
{ "message": "Account added", "server_section": "IMAP-1993" }

Response 409:
{ "error": "Account user@outlook.com already exists in proxy config" }
```

Implementação: ler config → flock → verificar duplicado → adicionar secção
server (se necessário) + secção account → escrever atomicamente → unlock.

#### `DELETE /api/curve/proxy/accounts/:email`

Remove conta do `emailproxy.config`. Requer confirmação — apaga tokens.

```
Response 200:
{ "message": "Account removed", "proxy_restart_needed": true }
```

Implementação: ler config → flock → remover secção → escrever → unlock.
Não remove secção server (pode ter outras contas). Não faz restart
automático — deixa para o caller.

#### `POST /api/curve/proxy/restart`

Reinicia o serviço systemd. Rate-limited: max 1 por minuto global.

```
Response 200:
{ "message": "Proxy restarted", "status": "active" }

Response 429:
{ "error": "Proxy was restarted recently. Try again in 45 seconds." }

Response 500:
{ "error": "Proxy failed to start", "journal": "..." }
```

Implementação: `child_process.exec('sudo systemctl restart email-oauth2-proxy')`.
Esperar 2s, depois `systemctl is-active` para confirmar. Se falhar, capturar
últimas 20 linhas de `journalctl -u email-oauth2-proxy --no-pager -n 20`.

**Nota sobre sudo:** o Express corre como user `pi` que precisa de
sudoers entry para restart do serviço sem password:
```
pi ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart email-oauth2-proxy
pi ALL=(ALL) NOPASSWD: /usr/bin/systemctl is-active email-oauth2-proxy
```

### 6.2 OAuth Flow

#### `POST /api/curve/proxy/auth/start`

Inicia o fluxo OAuth para uma conta. Comportamento depende do `flow`.

```
Request:
{
  "email": "user@outlook.com",
  "flow": "device"           // ou "authorization_code"
}
```

**Para `flow: "device"` (DAG):**

Backend faz POST directamente ao device code endpoint da Microsoft
(não precisa do proxy para isto — é puro HTTP).

```
Response 200:
{
  "flow": "device",
  "user_code": "A1B2C3D4",
  "verification_uri": "https://microsoft.com/devicelogin",
  "expires_in": 900,
  "poll_id": "abc123"        // ID interno para o frontend fazer poll
}
```

O backend guarda o `device_code` em memória (Map keyed by `poll_id`)
para polling posterior. TTL = `expires_in` + 30s margin.

**Para `flow: "authorization_code"` (external-auth):**

Backend constrói o permission URL com os params OAuth.

```
Response 200:
{
  "flow": "authorization_code",
  "permission_url": "https://accounts.google.com/o/oauth2/auth?...",
  "expires_in": 600
}
```

#### `GET /api/curve/proxy/auth/poll?poll_id=abc123`

Polling para o fluxo DAG. Frontend chama a cada 5 segundos.

```
Response 200 (pending):
{ "status": "pending", "expires_in": 845 }

Response 200 (authorized):
{
  "status": "authorized",
  "email": "user@outlook.com"
}

Response 200 (expired):
{ "status": "expired" }

Response 200 (declined):
{ "status": "declined", "error": "The user denied the authorization request" }
```

Implementação: backend faz POST ao token endpoint com o `device_code`
armazenado. Se `error: "authorization_pending"` → retorna pending. Se
tokens recebidos → encripta com PBKDF2/Fernet (replicando o algoritmo
do proxy) e escreve no `emailproxy.config` → retorna authorized.

**Alternativa mais simples (subprocess):** em vez de replicar a crypto
do proxy, o backend pode:
1. Guardar os tokens raw num ficheiro temporário
2. Spawnar o proxy uma vez para que ele os encripte
3. Ou aceitar que, no primeiro IMAP LOGIN, o proxy faz o PBKDF2 ele próprio

Esta decisão está em aberto (secção 12).

#### `POST /api/curve/proxy/auth/complete`

Completa o fluxo external-auth (paste-back do redirect URL).

```
Request:
{
  "email": "user@outlook.com",
  "redirect_url": "http://localhost?code=M.C507_BL2...&state=..."
}

Response 200:
{ "status": "authorized" }

Response 400:
{ "error": "No authorization code found in URL" }

Response 400:
{ "error": "Authorization was denied: access_denied" }
```

Implementação: parse URL → extrair `code` → POST ao token endpoint com
`grant_type=authorization_code` → receber tokens → encriptar → escrever
no config.

### 6.3 Integração com endpoints existentes

Os endpoints actuais mantêm-se inalterados:

| Endpoint | Usado no wizard | Passo |
|----------|----------------|-------|
| `PUT /api/curve/config` | Sim — salva imap_server, port, TLS, folder, schedule | 5.3, 5.4 |
| `POST /api/curve/test-connection` | Sim — verifica ligação IMAP pós-auth | 5.3 |
| `GET /api/curve/config` | Sim — detecta se user já tem config (redirect setup vs config) | Router |
| `POST /api/curve/sync` | Não directamente — mas pode ser trigger pós-wizard para primeira sync | 5.4 (opcional) |

O wizard é um **orquestrador** que chama estes endpoints na sequência
certa — não os substitui.

---

## 7. Pitfalls e Rastreabilidade

### 7.1 Duplicação de contas

**Cenário:** Mesmo email configurado para dois users do Curve Sync.
O `emailproxy.config` tem UMA secção por email — não suporta duplicados.
Se User A e User B ambos usam `joao@outlook.com`, partilham a mesma
secção de tokens, e uma mudança de password por um invalida os tokens
do outro.

**Regra:** um email → um user. Enforced em dois pontos:
- `POST /api/curve/proxy/accounts` rejeita se email existe e pertence
  a outro `user_id` (cross-ref com `CurveConfig`)
- Frontend mostra erro claro no passo 5.1

**Edge case — re-setup:** User faz wizard, abandona a meio, tenta de novo.
O email já existe no config mas sem tokens (ou com tokens parciais).
→ Upsert: sobrepor a secção existente, não duplicar.

### 7.2 Concorrência no config file

**Cenário:** User A e User B fazem wizard ao mesmo tempo. Ambos lêem o
config, adicionam a sua secção, e escrevem. O segundo a escrever
sobrepõe as alterações do primeiro.

**Solução:**
```javascript
import { open } from 'node:fs/promises';
import { flock } from 'fs-ext'; // ou implementação manual com lockfile

async function withConfigLock(fn) {
  const fd = await open(CONFIG_PATH, 'r+');
  await flock(fd.fd, 'ex');        // exclusive lock
  try {
    return await fn(fd);
  } finally {
    await flock(fd.fd, 'un');
    await fd.close();
  }
}
```

Alternativa mais simples: mutex in-memory (funciona porque o Express é
single-instance no Pi):
```javascript
let configMutex = Promise.resolve();
function withConfigMutex(fn) {
  configMutex = configMutex.then(fn, fn);
  return configMutex;
}
```

Preferir `flock` se o proxy também escreve no config concorrentemente
(o que acontece quando faz token refresh).

### 7.3 Restart do proxy

**Cenário:** restart durante um sync activo de outro user → a ligação
IMAP activa é cortada → sync falha com connection error.

**Mitigação:**
- Só reiniciar quando estritamente necessário (nova conta adicionada).
  O proxy relê o config com `SIGHUP` — testar se `SIGHUP` é suficiente
  para novas contas (se sim, evitar restart completo).
- Se restart necessário: verificar `isSyncing()` de todos os users.
  Se algum sync em curso → esperar até 30s, depois forçar (com log).
- Scheduler retry: o sync seguinte apanha as mensagens perdidas.
- Cooldown global: max 1 restart por 60s (HTTP 429 para pedidos dentro
  do cooldown).

**Nota sobre SIGHUP:** o proxy suporta `kill -HUP <pid>` para reload
do config sem restart. Investigar se isto é suficiente para activar
novas contas sem cortar sessões existentes. Se sim, preferir SIGHUP
a restart. Comando: `sudo kill -HUP $(pgrep -f emailproxy.py)`.

### 7.4 Encryption password

O proxy encripta tokens com Fernet, key derivada via PBKDF2 da password
que o IMAP client envia no `LOGIN`. Implicações:

- **Password = chave.** Se mudar, os tokens ficam ilegíveis → o proxy
  rejeita auth → re-consent necessário.
- **Todos os clients da mesma conta usam a mesma password.** No nosso
  caso há um só client (Curve Sync), portanto sem conflito.
- **`delete_account_token_on_password_error = True` (default do proxy):**
  se o Curve Sync enviar a password errada, o proxy apaga os tokens
  em vez de simplesmente rejeitar auth. Para ambientes multi-user
  considerar `False` para prevenir DoS acidental.
- **Recomendação:** o wizard gera password aleatória (24 chars, base64url),
  guarda-a no `CurveConfig.imap_password` (encriptada AES-256-GCM at rest),
  e o user nunca a vê nem digita. Risco de perda zero (vive na DB).

### 7.5 Token lifecycle

| Token | TTL | Refresh | Consequência de expiração |
|-------|-----|---------|--------------------------|
| Access | ~1h | Automático pelo proxy (transparente) | Nenhuma visível |
| Refresh | 90 dias de inactividade (MS) | N/A — é o refresh que gera novos access | Re-consent necessário |

**Detecção de expiração:** o campo `last_activity` no `emailproxy.config`
tem o timestamp do último uso. Se `now - last_activity > 80 dias` →
alerta no dashboard: "A autorização do teu email vai expirar em breve.
Re-autoriza para evitar interrupções." Link directo para re-auth wizard.

**Detecção reactiva:** quando o sync falha com `535 AUTHENTICATIONFAILED`
+ `last_sync_status = 'error'` + anteriormente funcionava → banner no
dashboard: "A autorização expirou. Clica aqui para re-autorizar."

### 7.6 Azure AD App Registration

Setup único (feito pelo admin, não pelos users):

1. Ir a [Entra Admin Centre](https://entra.microsoft.com/) → App registrations → New registration
2. Nome: "Curve Sync" (ou "Thunderbird" para reusar um existente)
3. Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"** (tenant `common`)
4. Redirect URI: **"Mobile and desktop applications"** → `http://localhost`
5. API permissions → Add:
   - `IMAP.AccessAsUser.All` (delegated)
   - `offline_access` (delegated)
6. Certificates & secrets → New client secret → guardar valor
7. Copiar `client_id` (Application ID) e `client_secret`
8. Adicionar ao `.env` do backend:
   ```
   AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   AZURE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

**Para Device Authorization Grant:** na mesma app registration →
Authentication → Advanced settings → "Allow public client flows" = **Yes**.

**Contas pessoais (outlook.com/hotmail.com):** a Microsoft restringe
novas app registrations para scopes de email em contas consumer.
Se bloquear, usar o client_id de uma app open-source conhecida
(e.g. Thunderbird) ou registar via Microsoft 365 Developer Programme.
Documentar a limitação claramente no wizard.

### 7.7 Proxy não instalado

O backend verifica no boot e antes de cada operação proxy:

```javascript
function isProxyInstalled() {
  return fs.existsSync(path.join(VENV_PATH, 'bin/python3'))
      && fs.existsSync(path.join(path.dirname(CONFIG_PATH), 'emailproxy.py'));
}
```

Se não instalado:
- Wizard mostra erro amigável: "O serviço de proxy de email não está
  instalado neste servidor. Contacta o administrador."
- Detalhes colapsáveis com instruções de instalação (link para
  docs/EMAIL.md secção "Installing email-oauth2-proxy")
- **Nunca tentar instalar automaticamente** — security + permissões

### 7.8 Subprocess cleanup

Se usarmos subprocesses para auth (alternativa ao token exchange directo):

- **Timeout:** 600s (alinhado com `AUTHENTICATION_TIMEOUT` do proxy)
- **Kill on abandon:** se o frontend não fizer poll durante 60s →
  backend mata o subprocess (TTL no `poll_id`)
- **PID tracking:** Map in-memory `{ poll_id → { pid, email, started_at } }`
- **Server restart cleanup:** `process.on('SIGTERM', killAllAuthSubprocesses)`
- **Max concorrentes:** 3 subprocesses simultâneos (prevenir resource exhaustion)

### 7.9 Contas pessoais vs organizacionais

| Tipo | App registration | DAG | Nota |
|------|-----------------|-----|------|
| Organizacional (O365) | Criar própria ou usar existente | ✓ | Funciona sem restrições |
| Personal (outlook.com) | Restrições para novas apps | ✓ (se app registered) | Pode exigir Developer Programme |
| Personal (hotmail/live) | Mesmas restrições | ✓ (se app registered) | Domínios legacy, mesma infra |
| Gmail | Google Cloud app registration | ✗ (external-auth only) | Requer OAuth consent screen, pode exigir billing |

O wizard deve mostrar um aviso contextual se o domínio detectado for
pessoal e o app registration não estiver configurado para consumer:
"Se a autorização falhar, pede ao administrador para configurar o
acesso para contas pessoais."

---

## 8. Segurança

### 8.1 Config file

- Permissions: `600` (owner read+write only)
- Nunca expor conteúdo do config ao frontend (tokens encriptados, mas client_secret visível)
- Backend lê/escreve; frontend só vê status booleanos

### 8.2 Client credentials

- `AZURE_CLIENT_ID` e `AZURE_CLIENT_SECRET` em `.env`, nunca hardcoded
- Nunca enviados ao frontend
- Se `encrypt_client_secret_on_first_use = True` no config, proxy encripta na primeira utilização

### 8.3 Audit trail

- Cada operação no config (add/remove account, restart proxy, auth start/complete) → CurveLog com action + user_id + IP
- Tentativas de auth falhadas logadas com motivo

### 8.4 Rate limiting

- Auth endpoints: max 3 tentativas / 15 min por user
- Proxy restart: max 1 / min global
- Account creation: max 5 / hora por user

---

## 9. Variáveis de Ambiente (novas)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `EMAIL_PROXY_CONFIG_PATH` | `/home/pi/email-oauth2-proxy/emailproxy.config` | Path absoluto do config file |
| `EMAIL_PROXY_VENV_PATH` | `/home/pi/email-oauth2-proxy/.venv` | Path do venv do proxy (para subprocess) |
| `EMAIL_PROXY_SERVICE_NAME` | `email-oauth2-proxy` | Nome do systemd unit |
| `AZURE_CLIENT_ID` | — | Client ID do Azure AD app registration |
| `AZURE_CLIENT_SECRET` | — | Client secret do Azure AD app registration |

---

## 10. Migração da CurveConfigPage Actual

### 10.1 O que mantém

- `CurveConfig` model (schema inalterado)
- `PUT /api/curve/config` (schedule, folder, sync toggle)
- `POST /api/curve/test-connection`
- Password encryption at rest (AES-256-GCM)
- Folder confirmation state machine

### 10.2 O que muda

- `/curve/config` deixa de ser um formulário monolítico → wizard multi-passo
- IMAP server/port/TLS são auto-preenchidos pelo wizard (não editáveis manualmente)
- Password IMAP é gerada pelo wizard (não digitada pelo user)
- Info banner sobre Caminho A/B desaparece (wizard subsume essa explicação)

### 10.3 Routing

- `/curve/setup` — wizard completo (para users sem config)
- `/curve/config` — settings simplificados (para users já configurados: pasta, intervalo, toggle)
- `/curve/config` redirige para `/curve/setup` se user não tem config

---

## 11. Design Tips por Passo

> Referência: paleta Curve (terracotta `curve-700`) + Sand (warm grey),
> animações `fade-in` / `fade-in-up`, tipografia Inter.
> Ver `docs/UIX_DESIGN.md` para especificação completa.

### Layout geral do wizard

```
┌──────────────────────────────────────────────────┐
│  ● ● ● ○    Step indicator (dots)                │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │                                            │  │
│  │         [Ícone SVG — 48-64px]              │  │
│  │                                            │  │
│  │         Título do passo                    │  │
│  │         text-xl font-semibold              │  │
│  │                                            │  │
│  │         Descrição / inputs                 │  │
│  │         text-sm text-sand-700              │  │
│  │                                            │  │
│  │         ┌──────────────────────────────┐   │  │
│  │         │   Acção principal (botão)    │   │  │
│  │         └──────────────────────────────┘   │  │
│  │                                            │  │
│  │         [Voltar]          [Continuar]       │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘
```

- Container: `max-w-lg mx-auto`, sem sidebar (full-focus wizard)
- Card: `bg-white rounded-2xl shadow-sm border border-sand-200 p-8`
- Step indicator: dots `h-2 w-2 rounded-full` em `sand-300`, activo
  em `curve-700`, transição `transition-colors duration-300`
- Navegação: "Voltar" como `btn-secondary` (esquerda), "Continuar"
  como `btn-primary` (direita). Passo 0 só tem "Começar". Passo 4
  só tem "Activar".
- Transição entre passos: conteúdo faz `animate-fade-in` (0.4s).
  Direcção da animação pode variar: avançar = slide-left,
  recuar = slide-right (opcional, subtil).

### Passo 0 — Boas-vindas

- **Ícone:** envelope com escudo ou cadeado — SVG inline, `text-curve-700`
- **Tom:** tranquilizador, não técnico. Evitar palavras: OAuth, proxy,
  token, IMAP, config. Usar: "email", "acesso", "autorização", "recibos".
- **Copy sugerido:**
  - Título: "Configurar acesso ao email"
  - Corpo: 3 parágrafos curtos (porquê / o quê / como), ver secção 5.0
- **Detalhe visual:** ícones pequenos (16px) ao lado de cada parágrafo:
  🛡️ → segurança, 📧 → email, ⚡ → automático (usar SVG, não emoji)
- **Animação:** card inteiro `animate-fade-in-up` on mount

### Passo 1 — Email

- **Ícone:** envelope aberto ou `@` estilizado
- **Input group:** ícone envelope à esquerda do input, `pl-10`
- **Validação visual:**
  - Default: border `sand-300`
  - Focus: ring `curve-500`
  - Valid: border `emerald-400`, ícone check à direita
  - Invalid: border `red-400`, mensagem `text-red-600 text-xs`
  - Checking backend: spinner pequeno à direita (substituí check/cross)
- **Provider badge:** aparece abaixo do input com `animate-fade-in`:
  ```
  ┌─────────────────────────┐
  │  [MS icon]  Microsoft   │  ← bg-blue-50 text-blue-700 rounded-lg
  └─────────────────────────┘
  ```
  Cores por provider: Microsoft `blue-50/blue-700`, Google `red-50/red-700`,
  Unknown `sand-100/sand-600`
- **Nota:** "Este é o email que recebe os recibos do Curve Pay, não a
  tua conta Embers." em `text-xs text-sand-500` abaixo do input

### Passo 2 — Autorização

O passo com mais complexidade visual. Dois layouts conforme o fluxo:

**DAG (Microsoft):**
```
┌────────────────────────────────────────────┐
│  [Shield icon]                             │
│  Autorizar acesso ao email                 │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │         A 1 B 2 C 3 D 4              │  │  ← código em destaque
│  │         [Copiar código]               │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  1. Clica no botão abaixo                  │
│  2. Cola o código quando pedido            │
│  3. Faz login com a tua conta              │
│  4. Autoriza o acesso                      │
│  5. Volta aqui — detectamos automaticamente│
│                                            │
│  [Abrir microsoft.com/devicelogin] →       │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  ⏳ A aguardar autorização... 12:34  │  │  ← polling status
│  └──────────────────────────────────────┘  │
│                                            │
│  ℹ️ Vai aparecer "Thunderbird"...          │  ← explainer colapsável
└────────────────────────────────────────────┘
```

- Código: `font-mono text-3xl font-bold text-curve-700 tracking-[0.3em]`
  em card `bg-curve-50 rounded-xl px-6 py-4 text-center`
- Copiar: botão `btn-secondary` pequeno abaixo do código. Após copiar:
  texto muda para "Copiado!" + ícone check durante 2s
- Lista de passos: `list-decimal`, com ícones numerados `curve-700`
- Link: `btn-primary` abre em nova tab (`target="_blank"`)
- Polling status: card `bg-sand-50 rounded-lg px-4 py-3`, spinner
  animado + countdown. Transiciona para `bg-emerald-50` on success
- Explainer Thunderbird: `<details>` ou banner `amber-50` colapsável
  com `cursor-pointer`

**External Auth (Google):**
```
┌────────────────────────────────────────────┐
│  [Key icon]                                │
│  Autorizar acesso ao email                 │
│                                            │
│  1. Clica no botão para abrir o Google     │
│  2. Faz login e autoriza o acesso          │
│  3. O browser vai mostrar um erro —        │
│     É NORMAL!                              │
│  4. Copia o endereço da barra do browser   │
│  5. Cola aqui em baixo                     │
│                                            │
│  [Abrir página de autorização] →           │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  Cola aqui o URL...                  │  │  ← textarea
│  └──────────────────────────────────────┘  │
│  [Validar]                                 │
│                                            │
│  ⚠️ O passo 3 vai mostrar "localhost      │
│     refused to connect" — copia o URL      │
│     ANTES de fechar essa página            │
└────────────────────────────────────────────┘
```

- Passo 3 com destaque visual: `font-semibold text-amber-700` no
  "É NORMAL!" para que o user não entre em pânico
- Screenshot estilizado (opcional): mock da barra de endereço do browser
  com highlight na zona do URL
- Textarea: `font-mono text-xs`, 3 rows, resize-none
- Aviso: banner `amber-50` com ícone warning

### Passo 3 — Verificação

- **Ícone:** checkmark em escudo ou lista de verificação
- **Checklist:** items verticais com estado animado:
  ```
  ✓ Proxy configurado          ← emerald-600 + animate-fade-in
  ✓ Serviço reiniciado         ← emerald-600 + animate-fade-in (delay 0.3s)
  ⏳ A testar ligação IMAP...  ← spinner curve-300 + text-sand-600
  ○ Pasta IMAP                 ← sand-300 (pending)
  ```
  Cada item: `flex items-center gap-3`, ícone `h-5 w-5`, texto `text-sm`
- Spinners: SVG inline animado com `animate-spin`, cor `curve-300`
- Checkmarks: SVG com `stroke-dasharray` animation (draw-in effect)
- Erro: item falha → ícone `✗` em `red-500`, texto muda para mensagem
  de erro, link "Ver detalhes" abre `<details>` com output técnico
  em `font-mono text-xs text-sand-500 bg-sand-50 rounded p-3`
- Dropdown pasta: aparece com `animate-fade-in-up` após checklist
  completa. Pre-select "Curve Receipts" se disponível, com hint
  verde: "Pasta recomendada detectada"

### Passo 4 — Activar

- **Ícone:** rocket ou play button
- **Card resumo:** grid 2 colunas:
  ```
  Email        user@outlook.com
  Provider     Microsoft ✓
  Pasta        Curve Receipts
  Proxy        127.0.0.1:1993 activo
  ```
  Labels: `text-xs text-sand-400 uppercase tracking-wide`
  Valores: `text-sm font-medium text-sand-900`
- **Separator:** `border-t border-sand-100 my-4`
- **Inputs:** intervalo (number, min 1, max 60, default 5) + toggle sync
  auto (switch component ou checkbox estilizado)
- **Botão final:** `btn-primary w-full py-3 text-base font-semibold`,
  texto "Activar Curve Sync"
- **Loading:** botão muda para "A activar..." com spinner inline
- **Sucesso:** card faz transição de border para `emerald-200`,
  ícone checkmark grande aparece centrado com `animate-fade-in-up`,
  texto "Curve Sync activo!" em `text-emerald-700 text-lg font-semibold`,
  auto-redirect para dashboard após 3 segundos (com progress bar subtil)

---

## 12. Decisões em Aberto

- [ ] DAG vs external-auth: confirmar que o app registration suporta device flow para contas pessoais
- [ ] Encryption password: auto-gerar sempre, ou dar opção ao user?
- [ ] Gmail: validar se é possível registar app com IMAP scope sem Google Cloud billing
- [ ] Proxy restart strategy: restart imediato vs graceful drain
- [ ] Wizard re-entry: se user já tem config, pode re-fazer wizard? Reset tokens?
