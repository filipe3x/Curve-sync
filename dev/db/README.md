# Dev Database

This directory holds MongoDB dumps for local development. Data is bogus/test accounts — safe to commit.

## Export (on production server)

```bash
mongodump --db=embers_production --out=/tmp/mongodump
tar czf embers-dump.tar.gz -C /tmp/mongodump embers_production
```

## Import (on dev machine)

```bash
tar xzf dev/db/embers-dump.tar.gz -C /tmp
mongorestore --db=embers_production /tmp/embers_production --drop
```

## Expected files

```
dev/db/
  embers-dump.tar.gz   # Full DB dump (git-ignored)
  README.md            # This file (tracked)
```
