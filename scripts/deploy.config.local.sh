#!/bin/bash
# deploy.config.sh - Template de configuração para deploy
# Copie este arquivo para deploy.config.local.sh e ajuste as credenciais

# ===== CONFIGURAÇÃO DO VPS =====
export VPS_USER="ember"
export VPS_HOST="embers.brasume.com"  # IP ou domínio do VPS
export VPS_PORT="22"              # Porta SSH
export VPS_PATH="/var/www/sleep"  # Caminho no VPS

# ===== GERENCIAMENTO DE PROCESSOS =====
# Opções: pm2, systemd, manual
export PROCESS_MANAGER="pm2"

# ===== CONFIGURAÇÕES OPCIONAIS =====
# Nome do processo no PM2 (se usar PM2)
export PM2_APP_NAME="sleep-routine"

# Nome do serviço systemd (se usar systemd)
export SYSTEMD_SERVICE="sleep"

# Porta do backend (deve coincidir com .env no VPS)
export BACKEND_PORT="3001"

# ===== BACKUP =====
# Criar backup antes do deploy?
export ENABLE_BACKUP="true"

# Número máximo de backups a manter
export MAX_BACKUPS="5"
