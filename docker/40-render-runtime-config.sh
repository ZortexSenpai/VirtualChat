#!/bin/sh
set -eu

: "${KLIPY_API_KEY:=}"
: "${DEFAULT_HOMESERVER:=}"
: "${LOCK_HOMESERVER:=}"

export KLIPY_API_KEY DEFAULT_HOMESERVER LOCK_HOMESERVER

envsubst '$KLIPY_API_KEY $DEFAULT_HOMESERVER $LOCK_HOMESERVER' \
  < /etc/virtualchat/config.template.js \
  > /usr/share/nginx/html/config.js
