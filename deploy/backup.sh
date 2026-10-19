#!/bin/sh
# Daily backup (cron, as the mybarber user):
#   15 3 * * * /opt/mybarber/current/deploy/backup.sh >> /opt/mybarber/backups/backup.log 2>&1
# Keeps the newest 30 backups in /opt/mybarber/backups. Also copy that folder OFF the server (README → Backups).
set -e
cd /opt/mybarber/current
DB_PATH=/opt/mybarber/data/bookings.db BACKUP_DIR=/opt/mybarber/backups /usr/bin/node --disable-warning=ExperimentalWarning tools/backup.js
