const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// --- RUTAS DE NAVEGACIÓN ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'pos.html'))); // NUEVO: Punto de Venta
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function inicializarBD() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS productos (
                id SERIAL PRIMARY KEY, codigo VARCHAR(50) UNIQUE,
                nombre VARCHAR(255), precio DECIMAL(10, 2), stock INTEGER
            );
        `);
        
        // Estructura anterior [cite: 224, 225]
        try { await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN descuento INT DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN talla VARCHAR(50) DEFAULT '';`); } catch (e) {}
        
        // NUEVO: Columnas para Omnicanalidad y Métricas
        try { await pool.query(`ALTER TABLE productos ADD COLUMN publicado BOOLEAN DEFAULT false;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN vistas INT DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN ventas INT DEFAULT 0;`); } catch (e) {}

        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (clave VARCHAR(50) PRIMARY KEY, valor TEXT);`);
        console.log('Gedalia ERP Omnicanal - Conectado a Aiven con éxito 💎');
    } catch (error) { console.error(error); }
}
inicializarBD();

// --- RUTAS API: PRODUCTOS ---
app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/productos', async (req, res) => {
    const { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo, nombre, precio, stock, imagenes, descuento, talla, publicado) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', async (req, res) => {
    // Lógica de actualización existente...
    const { id } = req.params;
    const { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE productos SET codigo = $1, nombre = $2, precio = $3, stock = $4, imagenes = $5, descuento = $6, talla = $7, publicado = $8 WHERE id = $9 RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM productos WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- NUEVO: RUTAS DE PUNTO DE VENTA Y MÉTRICAS ---

// Buscar producto exacto por lector de código de barras/QR (Mejorado)
app.get('/api/pos/producto/:codigo', async (req, res) => {
    try {
        // Convertimos la búsqueda a mayúsculas y limpiamos espacios
        const codigoBuscado = req.params.codigo.trim().toUpperCase();
        
        // Usamos UPPER() en SQL para asegurar coincidencia exacta sin importar mayúsculas
        const result = await pool.query(
            'SELECT * FROM productos WHERE UPPER(codigo) = $1 AND stock > 0', 
            [codigoBuscado]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No encontrado o sin stock físico disponible' });
        }
        res.json(result.rows[0]);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// Registrar venta en sucursal (Reduce stock, aumenta ventas)
app.post('/api/pos/vender', async (req, res) => {
    const { carrito } = req.body; // Array de IDs vendidos
    try {
        for (let item of carrito) {
            await pool.query('UPDATE productos SET stock = stock - 1, ventas = ventas + 1 WHERE id = $1 AND stock > 0', [item.id]);
        }
        res.json({ message: 'Venta registrada con éxito' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Registrar vista desde la página web
app.put('/api/productos/:id/vista', async (req, res) => {
    try {
        await pool.query('UPDATE productos SET vistas = vistas + 1 WHERE id = $1', [req.params.id]);
        res.json({ message: 'Vista sumada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Obtener datos valiosos (Dashboard)
app.get('/api/metricas', async (req, res) => {
    try {
        const masVistos = await pool.query('SELECT nombre, vistas FROM productos ORDER BY vistas DESC LIMIT 5');
        const masVendidos = await pool.query('SELECT nombre, ventas FROM productos ORDER BY ventas DESC LIMIT 5');
        res.json({ masVistos: masVistos.rows, masVendidos: masVendidos.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- RUTAS DE CAMPAÑAS (MANTENIDAS) ---
app.get('/api/campanas', async (req, res) => {
    try { const r = await pool.query("SELECT valor FROM configuracion WHERE clave='campanas'"); res.json(r.rows.length ? JSON.parse(r.rows[0].valor) : {}); } catch (e) { res.status(500).json({error:e.message}); }
});
app.put('/api/campanas', async (req, res) => {
    try { const r = await pool.query("INSERT INTO configuracion (clave, valor) VALUES ('campanas', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor RETURNING valor", [JSON.stringify(req.body)]); res.json(JSON.parse(r.rows[0].valor)); } catch (e) { res.status(500).json({error:e.message}); }
});

app.listen(process.env.PORT || 10000, () => console.log(`Servidor ERP Omnicanal corriendo`));
