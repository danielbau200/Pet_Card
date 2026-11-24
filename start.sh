#!/usr/bin/env bash

# Directorio base del script
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

PG_DATA="/home/daniel/.postgres_data"
PG_LOG="$PG_DATA/logfile"
PG_CTL="$(which pg_ctl 2>/dev/null || echo "/home/daniel/.local/bin/pg_ctl")"

echo "================================================="
echo "🐾 Iniciando entorno de PetCare Manager"
echo "================================================="

# 1. Comprobar y arrancar PostgreSQL si está apagado
if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
    echo "🟡 PostgreSQL no está corriendo. Iniciando servidor de BD..."
    if [ -x "$PG_CTL" ]; then
        "$PG_CTL" -D "$PG_DATA" -l "$PG_LOG" start
    else
        echo "❌ No se encontró el comando pg_ctl en $PG_CTL."
    fi
else
    echo "✅ PostgreSQL ya se encuentra activo."
fi

# 2. Esperar a que la base de datos responda
echo "⏳ Verificando disponibilidad de la base de datos..."
until pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; do
    sleep 1
done

echo "✅ Base de datos lista para pgAdmin 4:"
echo "   - Servidor: 127.0.0.1 / localhost"
echo "   - Puerto: 5432"
echo "   - Base de datos: pet_card_is_db"
echo "   - Usuario: postgres"
echo "-------------------------------------------------"
echo "🚀 Iniciando PetCare Manager en http://localhost:3000..."
echo "================================================="

# 3. Iniciar el servidor web Node.js
npm run dev
