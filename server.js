const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer'); // NUEVO: Librería de correos

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// --- CONFIGURACIÓN DE CORREO ELECTRÓNICO ---
// Asegúrate de configurar EMAIL_USER y EMAIL_PASS en las Environment Variables de Render
const transporter = nodemailer.createTransport({
    service: 'gmail', // O el proveedor que utilices
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // Si usas Gmail, debes generar una "Contraseña de Aplicación"
    }
});

async function enviarCorreoNotificacion(origen, detalles, total, metodoPago) {
    if (!process.env.EMAIL_USER) return console.warn("No hay credenciales de correo configuradas.");
    
    const mailOptions = {
        from: `"Gedalia ERP" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_USER, // Te envía el correo a ti mismo
        subject: `💰 Nueva Venta Registrada (${origen}) - Gedalia 925`,
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
                            <span style="color: #888;">Precio unitario: $${parseFloat(i.precio).toFixed(2)}</span>
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
        console.log(`Correo de venta enviado con éxito (${origen}).`);
    } catch (error) {
        console.error("Error al enviar el correo de venta:", error);
    }
}

// --- RUTAS DE NAVEGACIÓN ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'pos.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- BASE DE DATOS ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function inicializarBD() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS productos (id SERIAL PRIMARY KEY, codigo VARCHAR(50) UNIQUE, nombre VARCHAR(255), precio DECIMAL(10, 2), stock INTEGER);`);
        try { await pool.query(`ALTER TABLE productos ADD COLUMN imagenes TEXT[];`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN descuento INT DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN talla VARCHAR(50) DEFAULT '';`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN gramos DECIMAL(10, 2) DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN publicado BOOLEAN DEFAULT false;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN vistas INT DEFAULT 0;`); } catch(e){}
        try { await pool.query(`ALTER TABLE productos ADD COLUMN ventas INT DEFAULT 0;`); } catch(e){}
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
    const { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/productos/:id', async (req, res) => {
    const { id } = req.params;
    const { codigo, nombre, precio, stock, imagenes, descuento, talla, publicado, gramos } = req.body;
    try {
        const result = await pool.query(
            `UPDATE productos SET codigo = $1, nombre = $2, precio = $3, stock = $4, imagenes = $5, descuento = $6, talla = $7, publicado = $8, gramos = $9 WHERE id = $10 RETURNING *`,
            [codigo, nombre, precio, stock, imagenes || [], descuento || 0, talla || '', publicado || false, gramos || 0, id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM productos WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- NUEVA RUTA: VENTA EN LÍNEA VÍA WHATSAPP ---
app.post('/api/web/vender', async (req, res) => {
    const { id, codigo, nombre, precio, talla } = req.body;
    try {
        // Disminuir stock y aumentar venta (Solo si hay stock > 0)
        const updateRes = await pool.query('UPDATE productos SET stock = stock - 1, ventas = ventas + 1 WHERE id = $1 AND stock > 0 RETURNING *', [id]);
        
        if(updateRes.rows.length === 0) {
            return res.status(400).json({ error: 'Lo sentimos, este producto se acaba de agotar.' });
        }

        // Armar detalles para el correo
        const nombreFinal = talla ? `${nombre} (Talla: ${talla})` : nombre;
        const detallesVenta = [{ cantidad: 1, codigo, nombre: nombreFinal, precio }];
        
        // Disparar correo de notificación
        await enviarCorreoNotificacion('Página Web (WhatsApp)', detallesVenta, precio, 'Pendiente de cobro en WhatsApp');

        res.json({ message: 'Venta web reservada con éxito' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- RUTA: PUNTO DE VENTA FISICO ---
app.get('/api/pos/producto/:codigo', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos WHERE UPPER(codigo) = $1 AND stock > 0', [req.params.codigo.trim().toUpperCase()]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pos/vender', async (req, res) => {
    const { carrito, total, metodoPago } = req.body;
    try {
        for (let item of carrito) {
            await pool.query('UPDATE productos SET stock = stock - $1, ventas = ventas + $1 WHERE codigo = $2 AND stock >= $1', [item.cantidad, item.codigo]);
        }
        
        // Disparar correo de notificación
        await enviarCorreoNotificacion('Sucursal POS', carrito, total, metodoPago);
        
        res.json({ message: 'Venta registrada con éxito' });
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
