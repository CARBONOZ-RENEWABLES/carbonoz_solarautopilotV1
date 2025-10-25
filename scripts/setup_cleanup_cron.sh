#!/bin/bash
# Setup automatic daily cleanup via cron job

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP_SCRIPT="$SCRIPT_DIR/cleanup_old_data.js"

# Add cron job to run cleanup daily at 1 AM
(crontab -l 2>/dev/null; echo "0 1 * * * /usr/bin/node $CLEANUP_SCRIPT") | crontab -

echo "Cron job added: Daily cleanup at 1:00 AM"
echo "To remove: crontab -e and delete the cleanup line"