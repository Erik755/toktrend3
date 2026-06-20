#!/bin/bash
# Script para aplicar el fix de auto-refresh del token TikTok
# Ejecutar desde la raíz del repo: bash apply_fix.sh

echo '🔧 Aplicando fix de auto-refresh de token TikTok...'
cp server_fixed.mjs server.mjs
git add server.mjs
git commit -m 'fix: apply auto-refresh token patch (v auto-refresh-11)'
git push origin main
echo '✅ Fix aplicado y desplegado. Render lo redesplegará automáticamente.'
echo 'Después de ~2 min, reconecta TikTok en https://toktrend3.onrender.com'
