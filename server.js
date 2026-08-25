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
    ssl: { rejectUnauthorized: false },
    max: 10,                        // límite razonable para el tier gratuito de Aiven
    idleTimeoutMillis: 30000,       // cierra clientes ociosos antes que lo haga Aiven
    connectionTimeoutMillis: 8000,  // no se queda colgado esperando una conexión
    keepAlive: true
});

// *** FIX CRÍTICO ***
// Sin este listener, cuando Aiven cierra una conexión inactiva del pool,
// pg emite un evento 'error' en un cliente ocioso. Si nadie lo escucha,
// Node lo trata como excepción no capturada y TUMBA todo el proceso.
// En Render eso reinicia el servicio a medio proceso -> cualquier venta
// en curso falla con "error de conexión". Esta es la causa raíz del bug
// reportado en el POS.
pool.on('error', (err) => {
    console.error('⚠️ Error inesperado en cliente inactivo del pool de PG (recuperado, el servidor NO se cae):', err.message);
});

// Reintenta una vez una función que golpea la BD, útil para conexiones
// que Aiven cerró justo antes de usarse.
async function conReintento(fn, intentos = 2) {
    let ultimoError;
    for (let i = 0; i < intentos; i++) {
        try { return await fn(); }
        catch (err) {
            ultimoError = err;
            const transitorio = /Connection terminated|ECONNRESET|timeout|read ECONNRESET/i.test(err.message || '');
            if (!transitorio || i === intentos - 1) throw err;
            console.warn(`Reintentando operación de BD (intento ${i + 2}/${intentos})...`);
            await new Promise(r => setTimeout(r, 300));
        }
    }
    throw ultimoError;
}

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
                id SERIAL PRIMARY KEY
            );
        `);
        // *** FIX CRÍTICO ***
        // La tabla "ventas" ya existía en tu base de Aiven con un esquema
        // viejo/incompleto. CREATE TABLE IF NOT EXISTS NO modifica una tabla
        // que ya existe, así que la columna "origen" (y otras) nunca se
        // creaban -> "column origen of relation ventas does not exist" en
        // CADA venta, tanto en POS como en la compra web. Igual que ya se
        // hace con "productos", migramos con ALTER TABLE ADD COLUMN IF NOT
        // EXISTS, que sí es seguro de re-ejecutar aunque la columna exista.
        const columnasVentas = [
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS origen VARCHAR(50);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS codigo VARCHAR(50);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS nombre_articulo VARCHAR(255);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS talla VARCHAR(50);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cantidad INTEGER;`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS tipo_pago VARCHAR(50);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS costo DECIMAL(10, 2);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS precio_venta DECIMAL(10, 2);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS fecha_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cliente_email VARCHAR(255);`
        ];
        for (const sql of columnasVentas) {
            try { await pool.query(sql); } catch (e) { console.error('Migración ventas falló para:', sql, e.message); }
        }

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
// VENTA WEB (Página E-commerce / WhatsApp) - transaccional: si falla el
// registro en "ventas", se revierte el descuento de stock. Antes, si el
// INSERT fallaba (como pasaba por el bug de la columna "origen"), el stock
// ya se había descontado sin que la venta quedara registrada: el producto
// terminaba marcado como agotado sin haberse vendido realmente.
app.post('/api/web/vender', async (req, res) => {
    const { id, codigo, nombre, precio, talla } = req.body;
    if (!id) return res.status(400).json({ error: 'Falta el producto.' });

    try {
        const prod = await conReintento(async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const updateRes = await client.query(
                    'UPDATE productos SET stock = stock - 1, ventas = ventas + 1 WHERE id = $1 AND stock > 0 RETURNING *',
                    [id]
                );
                if (updateRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return null; // sin stock real, no es error de conexión
                }
                const p = updateRes.rows[0];
                await client.query(
                    `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    ['Web', p.codigo, p.nombre, p.talla || '', 1, 'WhatsApp / Acordar', p.costo || 0, precio]
                );
                await client.query('COMMIT');
                return p;
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (e2) {}
                throw err;
            } finally {
                client.release();
            }
        });

        if (!prod) {
            return res.status(400).json({ error: 'Lo sentimos, este producto se acaba de agotar.' });
        }

        const nombreFinal = prod.talla ? `${prod.nombre} (Talla: ${prod.talla})` : prod.nombre;
        const detallesVenta = [{ cantidad: 1, codigo, nombre: nombreFinal, precio }];
        enviarCorreoNotificacion('Página Web (WhatsApp)', detallesVenta, precio, 'Pendiente de cobro');

        res.json({ message: 'Venta web reservada con éxito' });
    } catch (err) {
        console.error('Error al procesar venta web:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// VENTA POS (Sucursal Física) - PROTEGIDA CON TRANSACCIÓN SQL + REINTENTO
app.post('/api/pos/vender', async (req, res) => {
    const { carrito, total, metodoPago } = req.body;

    if (!Array.isArray(carrito) || carrito.length === 0) {
        return res.status(400).json({ error: 'El carrito está vacío.' });
    }
    if (!metodoPago) {
        return res.status(400).json({ error: 'Falta el método de pago.' });
    }

    try {
        const resultado = await conReintento(async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN'); // Inicia transacción

                for (let item of carrito) {
                    const upRes = await client.query(
                        'UPDATE productos SET stock = stock - $1, ventas = ventas + $1 WHERE codigo = $2 AND stock >= $1 RETURNING *',
                        [item.cantidad, item.codigo]
                    );

                    if (upRes.rows.length === 0) {
                        throw new Error(`Stock insuficiente para el artículo: ${item.codigo}. Venta abortada.`);
                    }

                    const prod = upRes.rows[0];
                    const costoReal = prod.costo || 0;

                    await client.query(
                        `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        ['POS', prod.codigo, prod.nombre, prod.talla || '', item.cantidad, metodoPago, costoReal, item.precio]
                    );
                }

                await client.query('COMMIT');
                return true;
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (e2) { /* la conexión ya pudo haberse caído */ }
                throw err;
            } finally {
                client.release();
            }
        });

        if (resultado) {
            // El correo nunca debe tumbar la venta; ya está protegido internamente.
            enviarCorreoNotificacion('Sucursal POS', carrito, total, metodoPago);
            res.json({ message: 'Venta registrada con éxito' });
        }
    } catch (err) {
        console.error('Error al procesar venta POS:', err.message);
        res.status(400).json({ error: err.message });
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
// Esquema único y anidado, compartido por publicidad.html (quien escribe)
// e index.html (quien lee). Antes index.html esperaba campos planos
// (data.heroImg) mientras publicidad.html guardaba anidado (data.hero.img):
// por eso la publicidad "no se reflejaba". Ahora ambos usan esta forma.
const CAMPANAS_DEFAULT = {
    cinta: { activo: false, texto: '' },
    splash: { activo: true, texto: 'NUEVA COLECCIÓN', img: '' },
    hero: { titulo: 'NUEVOS DISEÑOS EXCLUSIVOS', sub: 'Descubre nuestra más reciente colección.', img: '' },
    promo1: { badge: '', titulo: '', sub: '', img: '' },
    promo2: { badge: '', titulo: '', sub: '', img: '' },
    contacto: { whatsapp: '525534612076', direccion: 'Centro Histórico, Ciudad de México (CDMX)' }
};

app.get('/api/campanas', async (req, res) => {
    try {
        const r = await conReintento(() => pool.query("SELECT valor FROM configuracion WHERE clave='campanas'"));
        const guardado = r.rows.length ? JSON.parse(r.rows[0].valor) : {};
        // Merge con defaults para que index.html nunca reciba undefined
        res.json({ ...CAMPANAS_DEFAULT, ...guardado });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/campanas', async (req, res) => {
    try {
        const payload = { ...CAMPANAS_DEFAULT, ...req.body };
        const r = await conReintento(() => pool.query(
            "INSERT INTO configuracion (clave, valor) VALUES ('campanas', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor RETURNING valor",
            [JSON.stringify(payload)]
        ));
        res.json(JSON.parse(r.rows[0].valor));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- CORTE DE CAJA DIARIO (mejora: el nav decía "próximamente") ---
app.get('/api/pos/corte-diario', async (req, res) => {
    try {
        const r = await conReintento(() => pool.query(`
            SELECT tipo_pago, COUNT(*) AS transacciones, SUM(cantidad) AS piezas, SUM(precio_venta * cantidad) AS total
            FROM ventas
            WHERE origen = 'POS' AND fecha_hora >= CURRENT_DATE
            GROUP BY tipo_pago
            ORDER BY total DESC
        `));
        const totalGeneral = r.rows.reduce((acc, row) => acc + parseFloat(row.total || 0), 0);
        res.json({ desglose: r.rows, totalGeneral, fecha: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/metricas', async (req, res) => {
    try {
        const v = await pool.query('SELECT nombre, vistas FROM productos ORDER BY vistas DESC LIMIT 5');
        const s = await pool.query('SELECT nombre, ventas FROM productos ORDER BY ventas DESC LIMIT 5');
        res.json({ masVistos: v.rows, masVendidos: s.rows });
    } catch (e) { res.status(500).json({error:e.message}); }
});

app.listen(process.env.PORT || 10000, () => console.log(`Servidor de Gedalia corriendo`));
