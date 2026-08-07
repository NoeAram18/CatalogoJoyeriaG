const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// --- RUTAS DE NAVEGACIÓN ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'pos.html')));
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

        try { await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN descuento INT DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN talla VARCHAR(50) DEFAULT '';`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN publicado BOOLEAN DEFAULT false;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN vistas INT DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN ventas INT DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN gramos DECIMAL(10,2) DEFAULT 0;`); } catch (e) {}

        // NUEVO: normaliza códigos ya existentes (mayúsculas, sin espacios) para que dejen de
        // fallar las búsquedas del POS por diferencias de mayúsculas/minúsculas o espacios.
        try { await pool.query(`UPDATE productos SET codigo = UPPER(TRIM(codigo)) WHERE codigo IS NOT NULL;`); } catch (e) {}

        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (clave VARCHAR(50) PRIMARY KEY, valor TEXT);`);

        // NUEVO: historial real de ventas. Antes las ventas del POS solo vivían en la memoria
        // del navegador y se perdían al recargar; el admin nunca las veía.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ventas (
                id SERIAL PRIMARY KEY,
                fecha TIMESTAMP DEFAULT NOW(),
                sucursal VARCHAR(100) DEFAULT 'Sucursal 1 (Matriz CDMX)',
                metodo_pago VARCHAR(50),
                total DECIMAL(10,2),
                items JSONB
            );
        `);

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
    let { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    if (!codigo || !codigo.trim()) return res.status(400).json({ error: 'El código es obligatorio.' });
    codigo = codigo.trim().toUpperCase(); // NUEVO: normaliza siempre a MAYÚSCULAS sin espacios
    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            // NUEVO: antes esto tronaba con un error 500 crudo; ahora se explica el motivo real
            return res.status(409).json({ error: `Ya existe un producto con el código ${codigo}. Genera otro código.` });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    let { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    if (codigo) codigo = codigo.trim().toUpperCase();
    try {
        const result = await pool.query(
            `UPDATE productos SET codigo = $1, nombre = $2, precio = $3, stock = $4, imagenes = $5, descuento = $6, talla = $7, publicado = $8, gramos = $9 WHERE id = $10 RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: `Ya existe un producto con el código ${codigo}.` });
        }
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM productos WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// NUEVO: permite a Admin verificar en vivo si un código autogenerado ya existe antes de guardarlo
app.get('/api/productos/verificar-codigo/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo.trim().toUpperCase();
        const result = await pool.query('SELECT id FROM productos WHERE codigo = $1', [codigo]);
        res.json({ disponible: result.rows.length === 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- RUTAS DE PUNTO DE VENTA Y MÉTRICAS ---

// Buscar producto exacto por lector de código de barras/QR
// CORREGIDO: esta ruta era sensible a mayúsculas/minúsculas y a espacios, por lo que
// productos dados de alta correctamente no se encontraban al escanear en el POS.
app.get('/api/pos/producto/:codigo', async (req, res) => {
    try {
        const codigo = req.params.codigo.trim().toUpperCase();
        const result = await pool.query('SELECT * FROM productos WHERE UPPER(TRIM(codigo)) = $1', [codigo]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Registrar venta en sucursal (reduce stock, aumenta ventas y ahora persiste el ticket en BD)
app.post('/api/pos/vender', async (req, res) => {
    const { carrito, total, metodoPago, sucursal } = req.body;
    if (!carrito || carrito.length === 0) return res.status(400).json({ error: 'Carrito vacío' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let item of carrito) {
            const cantidad = item.cantidad || 1;
            const upd = await client.query(
                'UPDATE productos SET stock = stock - $1, ventas = ventas + $1 WHERE id = $2 AND stock >= $1 RETURNING id',
                [cantidad, item.id]
            );
            if (upd.rows.length === 0) {
                throw new Error(`Sin stock suficiente para el producto ${item.codigo || item.id}`);
            }
        }
        // NUEVO: guarda la venta en BD para que el admin y el corte de caja tengan datos reales
        await client.query(
            'INSERT INTO ventas (sucursal, metodo_pago, total, items) VALUES ($1, $2, $3, $4)',
            [sucursal || 'Sucursal 1 (Matriz CDMX)', metodoPago || 'Efectivo', total || 0, JSON.stringify(carrito)]
        );
        await client.query('COMMIT');
        res.json({ message: 'Venta registrada con éxito' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
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

// NUEVO: esta ruta no existía. admin.html ya la llamaba para el "Monitor en Tiempo Real"
// pero al no existir, siempre mostraba números de ejemplo (falsos).
app.get('/api/operaciones/vivo', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT sucursal, metodo_pago, SUM(total)::numeric AS total, COUNT(*)::int AS cuenta
            FROM ventas
            WHERE fecha >= CURRENT_DATE
            GROUP BY sucursal, metodo_pago
        `);
        let webSales = 0, webOrders = 0, s1Sales = 0, s1Tickets = 0;
        for (const row of r.rows) {
            const total = parseFloat(row.total);
            if (row.sucursal === 'Web') { webSales += total; webOrders += row.cuenta; }
            else { s1Sales += total; s1Tickets += row.cuenta; }
        }
        res.json({
            webSales: webSales.toFixed(2), webOrders,
            s1Sales: s1Sales.toFixed(2), s1Tickets
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// NUEVO: alimenta la tabla "Últimas Transacciones" del monitor en vivo, que nunca se llenaba
app.get('/api/ventas/recientes', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM ventas ORDER BY fecha DESC LIMIT 30');
        res.json(r.rows);
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
