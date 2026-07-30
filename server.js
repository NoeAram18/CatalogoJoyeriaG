const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

// Servir los archivos estáticos de tu tienda (index.html y admin.html)
app.use(express.static(__dirname));

// 1. Configuración de Conexión a Aiven PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Evita el error de certificado
    }
});

// 2. Inicializar la Base de Datos (Crear tabla y agregar columna de imágenes)
async function inicializarBD() {
    try {
        // Crea la base principal si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS productos (
                id SERIAL PRIMARY KEY,
                codigo VARCHAR(50) UNIQUE,
                nombre VARCHAR(255),
                precio DECIMAL(10, 2),
                stock INTEGER
            );
        `);
        
        // TRUCO: Intenta agregar la columna de imágenes a tu tabla existente
        try {
            await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`);
            console.log('Columna de imágenes agregada con éxito a PostgreSQL.');
        } catch (e) {
            // Si la columna ya existe, PostgreSQL lanzará un error que podemos ignorar en silencio
        }
        
        console.log('Gedalia ERP Online - ¡Conectado a Aiven con éxito! 💎');
        console.log('Tabla "productos" verificada y lista para tu catálogo. 🛠️');
    } catch (error) {
        console.error('Error inicializando la base de datos:', error);
    }
}
inicializarBD();

// 3. RUTA: Mostrar todo el inventario
app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. RUTA: Guardar una nueva joya (¡Ahora con imágenes!)
app.post('/api/productos', async (req, res) => {
    const { codigo, nombre, precio, stock, imagenes } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO productos (codigo, nombre, precio, stock, imagenes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [codigo, nombre, precio, stock, imagenes || []]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. RUTA: Eliminar una pieza del inventario
app.delete('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.json({ message: 'Joya eliminada correctamente de Aiven' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. Encender el servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor de Gedalia ERP corriendo en el puerto ${PORT}`);
});
