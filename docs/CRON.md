# CRON.md — Pipeline de Sincronização de Emails

## Pipeline actual (Python + cron)

```
crontab (cada minuto)
  │
  ▼
offlineimap -o                       # Sync IMAP → Maildir local
  │
  ▼
find ".../Curve Receipts/new"        # Ficheiros dos últimos 70 min
  -type f -mmin -70
  │
  ▼
cat ficheiro | python curve.py       # Para cada email:
  │                                  #   decode quoted-printable
  │                                  #   BeautifulSoup parse HTML
  │                                  #   SHA-256 digest
  ▼
POST /admin/expenses/add_expense     # Envia ao Embers via HTTP
```

### Cronjob de produção

```cron
* * * * * offlineimap -o && find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -mmin -70 -exec sh -c 'cat "$0" | python /var/www/embers/curve.py' {} \; || true
```

### Problemas

- **offlineimap descontinuado** (último release 2020)
- **Sem lock** — se demora mais de 1 min, processos acumulam-se
- **`-mmin -70`** como heurística — janela de overlap que depende de reprocessamento + dedup
- **Erros silenciosos** — `print()` para stdout, sem registo persistente
- **Um email com erro pode matar o pipeline** — o `find -exec` pára
- **`user_id` hardcoded** no script
- **POST HTTP** para o Embers — dependência de rede e do servidor Rails

---

## Pipeline novo (JavaScript + node-cron)

```
node-cron (intervalo configurável)
  │
  ▼
imapflow                             # Liga directamente ao IMAP
  │                                  # Busca emails com flag UNSEEN
  ▼
emailParser (cheerio)                # Para cada email:
  │                                  #   decode quoted-printable
  │                                  #   cheerio parse HTML (mesmos selectores)
  │                                  #   SHA-256 digest
  ▼
Expense.create()                     # Insert directo no MongoDB (mesma DB)
  │
  ▼
CurveLog.create()                    # Log persistente (status, entity, digest)
  │
  ▼
markAsSeen(uid)                      # Marca email como lido no IMAP
```

### Diferenças

| | Python + cron | JavaScript |
|---|---|---|
| Scheduler | crontab do sistema | `node-cron` in-process |
| Email | offlineimap → Maildir → `find` | `imapflow` directo, sem ficheiros |
| Quais emails | `-mmin -70` (heurística) | Flag `UNSEEN` (exacto) |
| Parser | BeautifulSoup | cheerio (mesmos selectores CSS) |
| Output | POST HTTP → Embers | `Expense.create()` directo no MongoDB |
| Logging | `print()` → stdout | `CurveLog` no MongoDB (TTL 90 dias) |
| Erros | Um email falha → pipeline pára | Cada email isolado, erros não bloqueiam |
| Concorrência | Sem protecção | Mutex in-process |
| User | Hardcoded | Via `CurveConfig.user_id` |

---

## Código

### 1. Scheduler

Equivalente ao `* * * * *` do crontab, mas configurável via UI.

```javascript
// server/src/services/scheduler.js
import cron from 'node-cron';
import { runSync } from './syncOrchestrator.js';

let task = null;

export function startScheduler(intervalMinutes = 5) {
  stopScheduler();
  task = cron.schedule(`*/${intervalMinutes} * * * *`, () => {
    runSync();
  });
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}
```

### 2. IMAP Reader

Substitui `offlineimap -o` + `find -mmin -70`. Liga directamente ao servidor IMAP, busca emails não lidos, e marca como lidos após processamento.

```javascript
// server/src/services/imapReader.js
import { ImapFlow } from 'imapflow';

export async function fetchUnseenEmails(config) {
  const client = new ImapFlow({
    host: config.imap_server,
    port: config.imap_port,
    secure: true,
    auth: { user: config.imap_username, pass: config.imap_password },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock(config.imap_folder);

  try {
    const emails = [];
    for await (const msg of client.fetch({ seen: false }, { source: true })) {
      emails.push({ uid: msg.uid, raw: msg.source.toString() });
    }
    return { client, lock, emails };
  } catch (err) {
    lock.release();
    await client.logout();
    throw err;
  }
}

export async function markAsSeen(client, uid) {
  await client.messageFlagsAdd(uid, ['\\Seen']);
}

export async function testConnection(config) {
  const client = new ImapFlow({
    host: config.imap_server,
    port: config.imap_port,
    secure: true,
    auth: { user: config.imap_username, pass: config.imap_password },
    logger: false,
  });
  await client.connect();
  await client.logout();
}
```

### 3. Email Parser

Porta exacta do `curve.py`. Mesmos selectores CSS, mesma lógica de digest.

```javascript
// server/src/services/emailParser.js
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';

export function parseEmail(rawEmail) {
  // 1. Encontrar início do HTML
  //    curve.py: start_index = encoded_content.find('<!doctype html>')
  const htmlStart = rawEmail.search(/<![dD][oO][cC][tT][yY][pP][eE]\s+html>/i);
  if (htmlStart === -1) throw new Error('No HTML content found');

  // 2. Decode quoted-printable
  //    curve.py: quopri.decodestring(encoded_content[start_index:])
  const html = rawEmail.slice(htmlStart)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );

  // 3. Parse com cheerio (mesmos selectores do BeautifulSoup)
  const $ = cheerio.load(html);

  //    curve.py: entity_tag = soup.find('td', class_='u-bold')
  const entityTag = $('td.u-bold').first();
  //    curve.py: amount_tag = entity_tag.find_next_sibling('td', class_='u-bold')
  const amountTag = entityTag.nextAll('td.u-bold').first();
  //    curve.py: date_tag = soup.find('td', class_='u-greySmaller u-padding__top--half')
  const dateTag = $('td.u-greySmaller.u-padding__top--half').first();
  //    curve.py: name_and_card_tag = soup.find_all('td', class_='u-padding__top--half')[-2]
  const cardTags = $('td.u-padding__top--half');
  const cardTag = cardTags.eq(cardTags.length - 2);

  const entity = entityTag.text().trim();
  const amount = amountTag.text().trim().replace('€', '');
  const date = dateTag.text().trim();
  const card = cardTag.text().trim().replace(/\s+/g, ' ');

  if (!entity) throw new Error('Entity not found (td.u-bold)');

  // 4. Digest — idêntico ao curve.py
  //    curve.py: hashlib.sha256((entity+amount+date+card).encode('utf-8')).hexdigest()
  const digest = createHash('sha256')
    .update(`${entity}${amount}${date}${card}`)
    .digest('hex');

  return { entity, amount: parseFloat(amount), date, card, digest };
}
```

### 4. Orquestrador

Substitui toda a linha do crontab. Coordena IMAP → parse → insert → log → mark seen.

```javascript
// server/src/services/syncOrchestrator.js
import { fetchUnseenEmails, markAsSeen } from './imapReader.js';
import { parseEmail } from './emailParser.js';
import { assignCategory } from './expense.js';
import Expense from '../models/Expense.js';
import CurveLog from '../models/CurveLog.js';
import CurveConfig from '../models/CurveConfig.js';

let syncing = false;

export async function runSync(configId) {
  if (syncing) return { skipped: true, reason: 'Sync already in progress' };
  syncing = true;

  const results = { ok: 0, duplicate: 0, error: 0 };

  try {
    const config = configId
      ? await CurveConfig.findById(configId)
      : await CurveConfig.findOne({ sync_enabled: true });
    if (!config) return { skipped: true, reason: 'No config found' };

    const { client, lock, emails } = await fetchUnseenEmails(config);

    try {
      for (const email of emails) {
        try {
          const data = parseEmail(email.raw);
          const category_id = await assignCategory(data.entity);

          const expense = await Expense.create({
            ...data,
            user_id: config.user_id,
            category_id,
          });

          await CurveLog.create({
            user_id: config.user_id,
            config_id: config._id,
            status: 'ok',
            entity: data.entity,
            amount: data.amount,
            digest: data.digest,
            expense_id: expense._id,
          });

          await markAsSeen(client, email.uid);
          results.ok++;
        } catch (err) {
          const status = err.code === 11000 ? 'duplicate' : 'error';
          results[status]++;

          await CurveLog.create({
            user_id: config.user_id,
            config_id: config._id,
            status,
            entity: err.code === 11000 ? 'duplicate digest' : undefined,
            error_detail: err.message,
          });

          // Duplicados também são marcados como lidos
          if (err.code === 11000) await markAsSeen(client, email.uid);
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }

    await CurveConfig.updateOne({ _id: config._id }, {
      last_sync_at: new Date(),
      last_sync_status: results.error > 0 ? 'error' : 'ok',
      $inc: { emails_processed_total: results.ok },
    });

    return results;
  } finally {
    syncing = false;
  }
}
```

---

## Mapeamento linha a linha

```
CRON ACTUAL                              JAVASCRIPT EQUIVALENTE
─────────────────────────────────────    ─────────────────────────────────────
* * * * *                                cron.schedule(`*/${interval} * * * *`)
offlineimap -o                           client.connect() + client.fetch({seen:false})
find ... -mmin -70                       (implícito no UNSEEN — sem heurística)
cat "$0"                                 msg.source.toString()
python curve.py                          parseEmail(raw)
  quopri.decodestring()                    .replace(/=([0-9A-Fa-f]{2})/g, ...)
  BeautifulSoup(html, 'html.parser')       cheerio.load(html)
  soup.find('td', class_='u-bold')         $('td.u-bold').first()
  hashlib.sha256(...).hexdigest()          createHash('sha256')...digest('hex')
  requests.post(api_url, json=data)        Expense.create(data)
print("Expense criada")                  CurveLog.create({ status: 'ok' })
|| true                                  try/catch por email (erros isolados)
(sem lock)                               if (syncing) return
(sem mark as read)                       client.messageFlagsAdd(uid, ['\\Seen'])
```
