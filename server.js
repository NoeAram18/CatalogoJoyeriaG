const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

// Servir archivos estáticos del proyecto
app.use(express.static(__dirname));

// --- RUTAS DE NAVEGACIÓN (URLs Limpias) ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Permite entrar a la raíz principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Configuración de Conexión a Aiven PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// 2. Inicializar la Base de Datos (Automatizada)
async function inicializarBD() {
    try {
        // Crear tabla base si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS productos (
                id SERIAL PRIMARY KEY,
                codigo VARCHAR(50) UNIQUE,
                nombre VARCHAR(255),
                precio DECIMAL(10, 2),
                stock INTEGER
            );
        `);
        
        // Agregar columna imagenes si no existe
        try {
            await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`);
            console.log('Columna de imágenes lista.');
        } catch (e) { /* Ignorar si ya existe */ }

        // AUTOMATIZACIÓN: Agregar columna descuento si no existe
        try {
            await pool.query(`ALTER TABLE productos ADD COLUMN descuento INT DEFAULT 0;`);
            console.log('Columna de descuento agregada automáticamente con éxito 🏷️');
        } catch (e) { /* Ignorar si ya existe */ }

        // AUTOMATIZACIÓN: Agregar columna talla si no existe
        try {
            await pool.query(`ALTER TABLE productos ADD COLUMN talla VARCHAR(50) DEFAULT '';`);
            console.log('Columna de talla agregada automáticamente con éxito 📏');
        } catch (e) { /* Ignorar si ya existe */ }
        
        console.log('Gedalia ERP Online - Conectado a Aiven con éxito 💎');
    } catch (error) {
        console.error('Error inicializando la base de datos:', error);
    }
}
inicializarBD();

// 3. RUTA API: Obtener todo el inventario (Ya incluye automáticamente descuento y talla gracias al SELECT *)
app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. RUTA API: Crear un nuevo producto (Actualizada con descuento y talla)
app.post('/api/productos', async (req, res) => {
    const { codigo, nombre, precio, stock, imagenes, descuento, talla } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo, nombre, precio, stock, imagenes, descuento, talla) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. RUTA API: ACTUALIZAR/EDITAR una joya existente (Actualizada con descuento y talla)
app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { codigo, nombre, precio, stock, imagenes, descuento, talla } = req.body;
    try {
        const result = await pool.query(
            `UPDATE productos 
             SET codigo = $1, nombre = $2, precio = $3, stock = $4, imagenes = $5, descuento = $6, talla = $7 
             WHERE id = $8 RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. RUTA API: Eliminar una pieza del inventario
app.delete('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.json({ message: 'Joya eliminada correctamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Encender servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor de Gedalia ERP corriendo en el puerto ${PORT}`);
});
