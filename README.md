#  PetCard IS (`pet_card_IS`) — Versión Funcional PostgreSQL

Proyecto clonado y adaptado, conectado a PostgreSQL **sin procedimientos almacenados, sin triggers, sin funciones PL/pgSQL y sin restricciones (FK, CHECK, UNIQUE, NOT NULL)** a nivel de base de datos, delegando toda la lógica e integridad a la capa de aplicación en Node.js / Express.

---

## 🖥️ Ventanas Incluidas

El sistema incluye el flujo completo de **Login / Registro** más las **5 ventanas principales de PetCare**:

1. **Login / Registro de Usuarios** (`#login-screen`): Inicio de sesión y creación de cuenta (Dueño de mascota o Médico Veterinario), conectado a PostgreSQL con sesiones JWT.
2. **Ventana 1 — Inicio y Gestión de Mascotas** (`#page-dashboard` + `#page-add-pet`): Tarjeta interactiva de la mascota activa, selector de mascotas en barra lateral, creación/edición de mascotas con foto, resumen de vacunas, próxima cita, tratamientos activos y accesos rápidos.
3. **Ventana 2 — Cartilla de Vacunación Digital** (`#page-vaccines`): Progreso del esquema de vacunación, vacunas próximas/vencidas, línea de tiempo de vacunas aplicadas, catálogo por especie y registro/edición/eliminación de vacunas.
4. **Ventana 3 — Citas Veterinarias (Agenda)** (`#page-appointments`): Listado de próximas citas e historial de citas completadas, agendar nueva cita, editar o cancelar citas.
5. **Ventana 4 — Tratamientos Médicos y Control de Dosis** (`#page-treatments`): Control de medicamentos activos e historial, registro de nuevos tratamientos y botón rápido para registrar tomas/dosis (`+ Dosis`).
6. **Ventana 5 — Mapa y Directorio de Clínicas Cercanas** (`#page-map` + `#page-clinic-detail`): Mapa interactivo y directorio de clínicas veterinarias con filtro de urgencias 24h, búsqueda por cercanía y detalle/reseñas de clínicas.

---

## 🗄️ Base de Datos PostgreSQL (Sin Procedimientos Almacenados ni Restricciones)

El esquema SQL se encuentra en [`migrations/001_schema.sql`](file:///home/daniel/Documentos/pet_card_IS/migrations/001_schema.sql) y cumple estrictamente con:
- **Cero procedimientos almacenados / funciones PL/pgSQL** (se eliminaron `update_updated_at()` y `refresh_clinic_rating()`).
- **Cero triggers** (las actualizaciones de `updated_at` y el cálculo de `rating_avg` / `rating_count` de clínicas se ejecutan directamente desde el backend en Node.js).
- **Cero restricciones (`FOREIGN KEY`, `CHECK`, `UNIQUE`, `NOT NULL`, `ENUM`)**: todas las tablas usan tipos estándar (`UUID`, `VARCHAR`, `TEXT`, `BOOLEAN`, `DECIMAL`, `TIMESTAMPTZ`, `JSONB`) sin restricciones relacionales forzadas en el motor SQL, y los borrados en cascada o validaciones se manejan directamente en las rutas de Express (`src/routes/`).

---

## 🚀 Cómo Ejecutar el Proyecto

```bash
cd /home/daniel/Documentos/pet_card_IS

# 1. Ejecutar migraciones del esquema limpio y datos semilla (si usas una BD nueva)
npm run migrate

# 2. Iniciar el servidor en modo desarrollo (puerto 3000)
npm run dev
```

Luego abre **http://localhost:3000** en tu navegador.

### Usuarios Demo
- **Dueño de mascota:** `demo.owner@petcare.mx` / `Demo12345!`
- **Veterinario:** `demo.vet@petcare.mx` / `Demo12345!`
