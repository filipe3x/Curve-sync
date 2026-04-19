# AUTH.md — Estratégia de Autenticação

Os utilizadores registam-se e fazem login na plataforma **Embers** (Ruby on Rails). O Curve Sync não gere utilizadores — apenas precisa de **identificar quem está a fazer o pedido** para fazer scoping por `user_id`.

---

## Como funciona a autenticação no Embers

### Hash de passwords

O Embers usa uma implementação custom (não bcrypt, não Devise):

```ruby
# models/user.rb

def encrypt_password
  self.salt = make_salt if salt.blank?
  self.encrypted_password = encrypt(self.password) if self.password
end

def encrypt(string)
  secure_hash("#{string}--#{self.salt}")
end

def make_salt
  secure_hash("#{Time.now.utc}--#{self.password}")
end

def secure_hash(string)
  Digest::SHA2.hexdigest(string)
end

def authenticate(password)
  self.encrypted_password == encrypt(password)
end
```

**Resumo:** `encrypted_password = SHA256("password--salt")`, onde o `salt` é `SHA256("timestamp--password")` gerado uma única vez no registo.

### Campos do User relevantes

```
_id                 ObjectId
email               String (lowercase — ver nota sobre unicidade)
encrypted_password  String (SHA-256 hex)
salt                String (SHA-256 hex)
role                String ("admin" | "user")
```

> **Nota sobre unicidade do `email`:** apesar do Mongoid declarar
> `validates :email, uniqueness: { case_sensitive: false }` no Embers,
> **não existe um índice único em `users.email` ao nível da base de dados**
> (confirmado inspeccionando o `users.metadata.json` no dump em
> `dev/db/embers-dump.tar.gz` — só o `_id_` está presente). Tanto o Embers
> como o Curve Sync dependem de validação ao nível da aplicação. Ver a
> secção "Race-condition" no `POST /api/auth/register` em baixo.

### Sessões

O User tem `has_many :sessions` — sessões guardadas na collection `sessions` do MongoDB. O Embers expõe dois conjuntos de endpoints:

| Endpoint | Uso |
|----------|-----|
| `POST /admin/sessions` | Login (web admin) |
| `GET /admin/sessions/check` | Validar sessão activa |
| `DELETE /admin/sessions` | Logout |
| `POST /api/v1/sessions` | Login (API, token) |
| `GET /api/v1/sessions/check` | Validar token |
| `POST /api/v1/sessions/update_token` | Refresh token |

O middleware `authenticate_user` (before_action nos controllers) valida o token e define `current_user`.

> **Nota:** O modelo `Session` não está nos ficheiros de referência. A estrutura provável é: `{ _id, user_id, token, created_at, updated_at }`. Confirmar inspeccionando a collection `sessions` no MongoDB.

---

## Opções de autenticação para o Curve Sync

### Opção 1 — Validar sessões do Embers directamente (ESCOLHIDA)

O Curve Sync lê a collection `sessions` do MongoDB (read-only) para validar tokens emitidos pelo Embers. Opcionalmente, implementa o seu próprio endpoint de login replicando a lógica de hash.

**Fluxo com login próprio:**
```
1. POST /api/auth/login  { email, password }
2. Server lê User da collection 'users' (por email)
3. Replica o hash: SHA256("password--user.salt")
4. Compara com user.encrypted_password
5. Se válido, cria sessão na collection 'sessions' (compatível com Embers)
   ou cria sessão própria na collection 'curve_sessions'
6. Devolve token ao frontend
7. Frontend envia token no header Authorization em todos os pedidos
```

**Fluxo sem login próprio (reutilizar sessão Embers):**
```
1. Utilizador faz login no Embers → recebe token
2. Frontend do Curve Sync envia o mesmo token
3. Server faz lookup na collection 'sessions': { token: "..." }
4. Se encontra sessão, extrai user_id
5. Faz scoping de todas as queries por esse user_id
```

#### O que é preciso implementar

**Funções criptográficas (para login próprio):**

```javascript
// server/src/services/auth.js
import { createHash } from 'crypto';

/**
 * Replica exactamente o Digest::SHA2.hexdigest do Ruby.
 * Ruby: Digest::SHA2.hexdigest(string) → SHA-256 hex
 */
function sha256(string) {
  return createHash('sha256').update(string).digest('hex');
}

/**
 * Verifica password contra o hash guardado no MongoDB.
 * Replica: user.authenticate(password) do Embers.
 */
function verifyPassword(password, salt, encryptedPassword) {
  const hash = sha256(`${password}--${salt}`);
  return hash === encryptedPassword;
}
```

**Modelo Session (read-only ou read-write):**

```javascript
// server/src/models/Session.js
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'sessions',
    strict: false,  // não conhecemos todos os campos do Embers
  },
);

export default mongoose.model('Session', sessionSchema);
```

**Middleware de autenticação:**

```javascript
// server/src/middleware/auth.js
import Session from '../models/Session.js';

export async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Token em falta.' });
  }

  const session = await Session.findOne({ token }).lean();
  if (!session) {
    return res.status(401).json({ error: 'Sessão inválida.' });
  }

  req.userId = session.user_id;
  next();
}
```

**Endpoint de login (se implementarmos login próprio):**

```javascript
// server/src/routes/auth.js
import User from '../models/User.js';
import Session from '../models/Session.js';
import { randomBytes } from 'crypto';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas.' });

  if (!verifyPassword(password, user.salt, user.encrypted_password)) {
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  const token = randomBytes(32).toString('hex');
  await Session.create({ user_id: user._id, token });

  res.json({ token, user: { id: user._id, email: user.email } });
});
```

---

### Self-service registration — `POST /api/auth/register`

O Curve Sync expõe um endpoint próprio para criar contas Embers-compatíveis,
sem ter de passar pela UI do Embers. As contas criadas aqui podem fazer login
no Embers (e vice-versa) — usam exactamente o mesmo schema, o mesmo algoritmo
de hash, e a mesma collection `users`.

A regra de acesso a `users` no `CLAUDE.md` foi flexibilizada
(READ + INSERT + UPDATE — sem DELETE) precisamente para permitir este fluxo;
ver a secção "MongoDB Collection Access Rules" desse ficheiro para o contrato
completo.

**Contrato HTTP:**

```
POST /api/auth/register
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "correcthorsebatterystaple",
  "password_confirmation": "correcthorsebatterystaple"
}

→ 201 Created
{
  "token": "<64 hex chars>",
  "user": { "id": "<ObjectId>", "email": "alice@example.com", "role": "user" }
}
```

| Status | Quando |
|--------|--------|
| `201`  | Conta criada; sessão aberta; `token` pronto para `Authorization: Bearer …` |
| `400`  | Falta email/password, password com menos de 8 caracteres, ou `password_confirmation` não coincide |
| `409`  | Já existe um row em `users` com este email (lowercase) |
| `429`  | Excedeu o limite de 5 registos/hora por IP (ver `index.js:registerLimiter`) |
| `500`  | Erro inesperado (Mongo, etc.) |

A resposta é deliberadamente **idêntica em forma à de `POST /api/auth/login`**
(`{ token, user }`) para que o frontend (`AuthContext.login(token, user)`)
consiga consumir o resultado sem ramificação extra. O fluxo no frontend é
auto-login + redirect para `/curve/setup` (o passo seguinte natural para um
utilizador novo é ligar a mailbox).

**Derivação Embers-compatível do hash** (`server/src/services/auth.js`):

```javascript
export function hashPassword(password) {
  // Embers: make_salt        = SHA256("#{Time.now.utc}--#{password}")
  // Embers: encrypt_password = SHA256("#{password}--#{salt}")
  const salt = sha256(`${new Date().toISOString()}--${password}`);
  const encrypted_password = sha256(`${password}--${salt}`);
  return { salt, encrypted_password };
}
```

O `salt` é opaco — o Embers nunca o re-deriva a partir do timestamp, apenas o
re-aplica em `encrypt(password)` no login seguinte. A diferença de formato
entre `Date#toISOString()` (`2026-04-13T12:34:56.789Z`) e `Time.now.utc` em
Ruby (`2026-04-13 12:34:56 UTC`) é cosmética: o resultado SHA-256 é igualmente
imprevisível e a verificação cross-app continua a funcionar.

**Auto-login partilha o mesmo helper de tokens.** O `register` invoca o
mesmo `generateToken()` (32 bytes crypto-random → 64 hex chars) e o mesmo
`SESSION_TTL_MS` que o `POST /login`, e escreve na mesma collection `sessions`.
Reutilizar o helper significa que a story de entropia do token é a story do
login — não há um segundo sítio onde tenhamos de manter o algoritmo em sync.

**Role lock — `'user'` apenas.** O handler força `role: 'user'` no `User.create()`.
A atribuição de admin continua a ser exclusiva do Embers (incluindo o "last admin
guard"). UPDATEs futuros nesta tabela **nunca devem** fazer downgrade de um
admin existente; o caveat fica registado no `CLAUDE.md`.

**Race-condition (email uniqueness).** Não há índice único em `users.email`
ao nível da base de dados — o Embers depende exclusivamente da validação
Mongoid `validates :email, uniqueness:`, que tem a sua própria janela
de race entre o `findOne` e o `insert`. O nosso handler tem exactamente a
mesma janela: faz um `findOne` antes do `User.create` e devolve `409` se já
existir.

Razões para não fechar a janela com um índice único em DB:

1. Adicionar um índice único é uma alteração de schema **partilhada com o Embers**
   — fora do âmbito desta feature, requer alinhamento com a equipa que mantém
   o Embers.
2. O caso de uso é uma app de finanças pessoais com cadência de registo
   baixíssima (não é um signup viral).
3. O `registerLimiter` (5 registos/hora por IP) torna a janela de race
   praticamente inalcançável sem um atacante coordenado, e mesmo nesse cenário
   o pior resultado é ter dois rows com o mesmo email — o `findOne` no `login`
   apanha sempre o primeiro `_id` por ordem natural e os dois rows ficam
   detectáveis num índice único futuro.

A rota está coberta por dois rate limiters em `server/src/index.js`:

- `registerLimiter` — 5/hora por IP (mounted em `/api/auth/register`)
- `apiLimiter` — 100/min por IP (catch-all `/api`)

A ordem dos `app.use` é importante: o `registerLimiter` está mais específico
e é montado **antes** do `apiLimiter`, por isso o pedido conta para os dois
buckets e o que dispara primeiro vence — comportamento documentado em
`server/src/index.js:110-120`.

**Audit trail.** O handler escreve duas variantes em `curve_logs` via
`services/audit.js`:

| Action            | Quando                                          | `userId`                          | `error_detail`                |
|-------------------|-------------------------------------------------|-----------------------------------|-------------------------------|
| `register`        | Conta criada com sucesso                        | id do row recém-criado            | `email=<lowercased>`          |
| `register_failed` | Email já existe (única branch que loga falha)   | id do row existente em colisão    | `email_taken=<lowercased>`    |

Validações 400 (email/password ausentes, password curta, confirmação inválida)
não são auditadas — não carregam sinal interessante para o trail e seriam
ruído numa página de logs já apertada.

Ambos os enums (`register`, `register_failed`) estão declarados em
`server/src/models/CurveLog.js`. Como o `audit()` é fire-and-forget, falhas
de validação no schema seriam silenciosas — adicionar o enum é obrigatório
quando se introduz um novo `action`.

#### Prós e contras

| | Prós | Contras |
|---|------|---------|
| **Com login próprio** | Independente do Embers; funciona mesmo se o Embers estiver em baixo | Precisa replicar a lógica de hash; cria sessões que o Embers pode não reconhecer |
| **Só validar sessão** | Zero lógica de auth; reutiliza login existente | Utilizador tem de fazer login no Embers primeiro; acoplado ao schema de sessions |

#### Passo a passo para implementar

1. Inspeccionar a collection `sessions` no MongoDB para confirmar a estrutura (campos, formato do token)
2. Criar `server/src/models/Session.js` (read-only, `strict: false`)
3. Actualizar `server/src/models/User.js` com campos `encrypted_password` e `salt`
4. Criar `server/src/services/auth.js` com `sha256()` e `verifyPassword()`
5. Criar `server/src/middleware/auth.js` com middleware `authenticate`
6. Criar `server/src/routes/auth.js` com `POST /api/auth/login` e `POST /api/auth/logout`
7. Aplicar middleware `authenticate` a todos os routes existentes
8. Fazer scoping de todas as queries por `req.userId`
9. Adicionar página de login ao frontend

---

### Opção 2 — API key dedicada por utilizador

Cada `CurveConfig` tem um campo `api_key` (UUID gerado na criação). O utilizador copia a key do painel Embers ou do Curve Sync e configura-a no frontend.

**Fluxo:**
```
1. Utilizador cria CurveConfig → server gera api_key (UUID v4)
2. Frontend guarda api_key em localStorage
3. Todos os pedidos incluem header X-Curve-API-Key
4. Middleware valida: CurveConfig.findOne({ api_key }) → extrai user_id
```

**Prós:** Totalmente independente do Embers; sem lógica de hash; simples.
**Contras:** Experiência de utilizador pior (copiar/colar key); sem login/password; a key é um segredo que pode ser exposto.

---

### Opção 3 — Proxy de autenticação via Embers

O Curve Sync chama o Embers para validar o token, sem aceder à DB de sessões directamente.

**Fluxo:**
```
1. Utilizador faz login no Embers → recebe token
2. Frontend envia token ao Curve Sync
3. Curve Sync faz GET http://embers-host/api/v1/sessions/check
   com o mesmo token no header
4. Se Embers responde 200 → extrair user_id da resposta
5. Se Embers responde 401 → rejeitar pedido
```

**Prós:** Zero acesso à DB de sessões; reutiliza auth existente; desacoplado do schema.
**Contras:** Dependência de rede do Embers (se o Embers cair, o Curve Sync pára); latência extra em cada pedido (mitigável com cache de curta duração).

---

## Recomendação

**Opção 1 com login próprio** é a mais robusta para um serviço standalone:
- Funciona independentemente do Embers
- A lógica de hash é trivial (3 linhas de código com `crypto` nativo)
- Permite ao utilizador fazer login directamente no Curve Sync
- As sessões podem ser guardadas na collection `sessions` existente (compatível) ou numa collection dedicada `curve_sessions` (isolada)

A única dependência real é ler o `encrypted_password` e `salt` da collection `users` — que já acedemos em read-only.
