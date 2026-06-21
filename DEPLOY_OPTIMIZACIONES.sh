#!/bin/bash

# Script para desplegar optimizaciones de memoria a GitHub y Render
# Las optimizaciones ya están commiteadas localmente, solo falta push

echo "🚀 Desplegando optimizaciones de memoria a toktrend3..."
echo ""

# Verificar que estamos en el directorio correcto
if [ ! -f "server_v8.mjs" ]; then
  echo "❌ Error: Ejecuta este script desde el directorio toktrend3"
  exit 1
fi

# Mostrar el commit pendiente
echo "📦 Commit listo para desplegar:"
git log -1 --oneline
echo ""

# Intentar push
echo "📤 Haciendo push a GitHub..."
if git push origin main; then
  echo "✅ Push exitoso a GitHub"
  echo ""
  echo "🎯 Render detectará los cambios automáticamente y redesplegará"
  echo "⏱️  El redespliegue tomará aproximadamente 2-3 minutos"
  echo ""
  echo "📊 Monitorea el despliegue en:"
  echo "   https://dashboard.render.com/web/srv-d8i2oh37uimc73aak540"
  echo ""
  echo "🔍 Una vez desplegado, verifica con:"
  echo "   curl https://toktrend3.onrender.com/api/diagnostics"
else
  echo ""
  echo "⚠️  El push automático falló."
  echo ""
  echo "Por favor:"
  echo "1. Configura tu token de GitHub:"
  echo "   git remote set-url origin https://TU_TOKEN@github.com/Erik755/toktrend3.git"
  echo ""
  echo "2. Haz push manualmente:"
  echo "   git push origin main"
  echo ""
  echo "O desde GitHub Desktop o tu cliente Git favorito."
fi
