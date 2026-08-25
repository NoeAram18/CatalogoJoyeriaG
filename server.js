const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// --- CONFIGURACIÓN DE CORREO ELECTRÓNICO ---
const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS 
    }
});

async function enviarCorreoNotificacion(origen, detalles, total, metodoPago) {
    if (!process.env.EMAIL_USER) return console.warn("No hay credenciales de correo configuradas.");
    
    const mailOptions = {
        from: `"Gedalia ERP" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER, // Puedes separarlo con comas si quieres enviar a varios socios
        subject: `💰 Nueva Venta Confirmada (${origen}) - Gedalia 925`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                <h2 style="color: #c5a059; text-align: center;">Nueva Venta Confirmada</h2>
                <p><strong>Origen:</strong> ${origen}</p>
                <p><strong>Fecha y Hora:</strong> ${new Date().toLocaleString('es-MX', {timeZone: 'America/Mexico_City'})}</p>
                <p><strong>Método de Pago:</strong> ${metodoPago}</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <h3 style="margin-top: 0;">Detalles de la compra:</h3>
                <ul style="list-style: none; padding: 0;">
                    ${detalles.map(i => `
                        <li style="margin-bottom: 10px; background: #f9f9f9; padding: 10px; border-radius: 5px;">
                            <strong>${i.cantidad}x ${i.codigo}</strong> - ${i.nombre} <br>
                            <span style="color: #888;">Precio unitario pagado: $${parseFloat(i.precio).toFixed(2)}</span>
                        </li>
                    `).join('')}
                </ul>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <h2 style="text-align: right; color: #0a0a0a;">Total: $${parseFloat(total).toFixed(2)} MXN</h2>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✉️ Correo de venta enviado con éxito (${origen}).`);
    } catch (error) {
        // Solo logueamos el error, no interrumpimos la venta al cliente por un fallo del correo
        console.error("⚠️ Error al enviar el correo de venta:", error);
    }
}

// --- RUTAS DE NAVEGACIÓN ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'pos.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/publicidad', (req, res) => res.sendFile(path.join(__dirname, 'publicidad.html')));

// --- BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function inicializarBD() {
    try {
        // Actualización de la tabla Productos (Agregamos costo)
        await pool.query(`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo VARCHAR(50) UNIQUE, nombre VARCHAR(255), precio DECIMAL(10, 2), stock INTEGER);`);
        try { await pool.query(`ALTER TABLE productos ADD COLUMN costo DECIMAL(10, 2) DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN descuento INT DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN talla VARCHAR(50) DEFAULT '';`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN gramos DECIMAL(10, 2) DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN publicado BOOLEAN DEFAULT false;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN vistas INT DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN ventas INT DEFAULT 0;`); } catch(e){}
        
        // Nueva Tabla: Historial de Ventas
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ventas (
                id SERIAL PRIMARY KEY,
                origen VARCHAR(50),
                codigo VARCHAR(50),
                nombre_articulo VARCHAR(255),
                talla VARCHAR(50),
                cantidad INTEGER,
                tipo_pago VARCHAR(50),
                costo DECIMAL(10, 2),
                precio_venta DECIMAL(10, 2),
                fecha_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (clave VARCHAR(50) PRIMARY KEY, valor TEXT);`);
        console.log('Gedalia ERP Omnicanal - Conectado a Aiven con éxito 💎');
    } catch (error) { console.error('Error BD:', error); }
}
inicializarBD();

// --- RUTAS API CATALOGO ---
app.get('/api/productos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/productos', async (req, res) => {
    const { codigo, nombre, costo, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo, nombre, costo, precio, stock, imagenes, descuento, talla, publicado, gramos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [codigo, nombre, costo || 0, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { codigo, nombre, costo, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    try {
        const result = await pool.query(
            `UPDATE productos SET codigo = $1, nombre = $2, costo = $3, precio = $4, stock = $5, imagenes = $6, descuento = $7, talla = $8, publicado = $9, gramos = $10 WHERE id = $11 RETURNING *`,
            [codigo, nombre, costo || 0, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0, id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM productos WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- NUEVAS RUTAS DE VENTAS ---

// Obtener todas las ventas (Para el Admin)
app.get('/api/ventas', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ventas ORDER BY fecha_hora DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// VENTA WEB (Página E-commerce / WhatsApp)
app.post('/api/web/vender', async (req, res) => {
    const { id, codigo, nombre, precio, talla } = req.body;
    try {
        const updateRes = await pool.query('UPDATE productos SET stock = stock - 1, ventas = ventas + 1 WHERE id = $1 AND stock > 0 RETURNING *', [id]);
        
        if(updateRes.rows.length === 0) {
            return res.status(400).json({ error: 'Lo sentimos, este producto se acaba de agotar.' });
        }

        const prod = updateRes.rows[0];
        const costoReal = prod.costo || 0;
        const nombreFinal = prod.talla ? `${prod.nombre} (Talla: ${prod.talla})` : prod.nombre;

        // Registrar la venta en el historial
        await pool.query(
            `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
            ['Web', prod.codigo, prod.nombre, prod.talla || '', 1, 'WhatsApp / Acordar', costoReal, precio]
        );

        const detallesVenta = [{ cantidad: 1, codigo, nombre: nombreFinal, precio }];
        await enviarCorreoNotificacion('Página Web (WhatsApp)', detallesVenta, precio, 'Pendiente de cobro');

        res.json({ message: 'Venta web reservada con éxito' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// VENTA POS (Sucursal Física) - PROTEGIDA CON TRANSACCIÓN SQL
app.post('/api/pos/vender', async (req, res) => {
    const { carrito, total, metodoPago } = req.body;
    
    // Usamos client.query para una transacción controlada (BEGIN/COMMIT)
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN'); // Inicia transacción
        
        for (let item of carrito) {
            // Descontamos stock y regresamos el registro actualizado
            const upRes = await client.query('UPDATE productos SET stock = stock - $1, ventas = ventas + $1 WHERE codigo = $2 AND stock >= $1 RETURNING *', [item.cantidad, item.codigo]);
            
            if(upRes.rows.length === 0) {
                throw new Error(`Stock insuficiente para el artículo: ${item.codigo}. Venta abortada.`);
            }

            const prod = upRes.rows[0];
            const costoReal = prod.costo || 0;

            // Registramos este artículo en el historial de ventas
            await client.query(
                `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
                ['POS', prod.codigo, prod.nombre, prod.talla || '', item.cantidad, metodoPago, costoReal, item.precio]
            );
        }
        
        await client.query('COMMIT'); // Si todo salió bien, guardamos cambios en BD
        
        // Se ejecuta solo si el commit fue exitoso
        await enviarCorreoNotificacion('Sucursal POS', carrito, total, metodoPago);
        res.json({ message: 'Venta registrada con éxito' });

    } catch (err) { 
        await client.query('ROLLBACK'); // Si algo falla, revertimos TODO (nada se descuenta)
        res.status(400).json({ error: err.message }); 
    } finally {
        client.release(); // Liberamos la conexión
    }
});

app.get('/api/pos/producto/:codigo', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos WHERE UPPER(codigo) = $1 AND stock > 0', [req.params.codigo.trim().toUpperCase()]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id/vista', async (req, res) => {
    try { await pool.query('UPDATE productos SET vistas = vistas + 1 WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } catch (e) {}
});

// --- RUTAS DE CAMPAÑAS Y METRICAS ---
app.get('/api/campanas', async (req, res) => {
    try { const r = await pool.query("SELECT valor FROM configuracion WHERE clave='campanas'"); res.json(r.rows.length ? JSON.parse(r.rows[0].valor) : {}); } catch (e) { res.status(500).json({error:e.message}); }
});
app.put('/api/campanas', async (req, res) => {
    try { const r = await pool.query("INSERT INTO configuracion (clave, valor) VALUES ('campanas', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor RETURNING valor", [JSON.stringify(req.body)]); res.json(JSON.parse(r.rows[0].valor)); } catch (e) { res.status(500).json({error:e.message}); }
});
app.get('/api/metricas', async (req, res) => {
    try {
        const v = await pool.query('SELECT nombre, vistas FROM productos ORDER BY vistas DESC LIMIT 5');
        const s = await pool.query('SELECT nombre, ventas FROM productos ORDER BY ventas DESC LIMIT 5');
        res.json({ masVistos: v.rows, masVendidos: s.rows });
    } catch (e) { res.status(500).json({error:e.message}); }
});

app.listen(process.env.PORT || 10000, () => console.log(`Servidor de Gedalia corriendo`));
