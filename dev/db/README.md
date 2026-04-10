# Dev Database

This directory holds MongoDB dumps for local development. Data is bogus/test accounts — safe to commit.

## Export (on production server)

```bash
mongodump --db=embers_db --out=/tmp/mongodump
tar czf embers-dump.tar.gz -C /tmp/mongodump embers_db
```

## Import (on dev machine)

```bash
tar xzf dev/db/embers-dump.tar.gz -C /tmp
mongorestore --db=embers_db /tmp/embers_db --drop
```

## Expected files

```
dev/db/
  embers-dump.tar.gz   # Full DB dump (git-ignored)
  README.md            # This file (tracked)
```
