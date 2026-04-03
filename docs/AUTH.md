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
email               String (unique, lowercase)
encrypted_password  String (SHA-256 hex)
salt                String (SHA-256 hex)
role                String ("admin" | "user")
```

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
