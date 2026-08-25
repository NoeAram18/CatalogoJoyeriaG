const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
// Render está detrás de un proxy inverso: sin esto, req.ip siempre marca la
// IP interna del proxy y el anti-fuerza-bruta del login de cajeras (más
// abajo) terminaría bloqueando a todo mundo junto, o a nadie.
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' })); // 15mb: las fotos de la cámara viajan en base64 en el body
app.use(express.static(__dirname));

// --- CONFIGURACIÓN DE CORREO ELECTRÓNICO ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Fuerza el uso de SSL/TLS desde el inicio de la conexión
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS 
    },
    tls: {
        rejectUnauthorized: false // Evita bloqueos de Render por certificados
    }
});

// Destinatarios del área de ventas: separado del correo remitente para que
// puedan llegar a varias personas (gerencia, contabilidad, etc.) sin tocar
// código. Si no se configura EMAIL_VENTAS, cae de regreso a EMAIL_USER.
function destinatariosVentas() {
    const lista = process.env.EMAIL_VENTAS || process.env.EMAIL_USER || '';
    return lista.split(',').map(e => e.trim()).filter(Boolean).join(',');
}

// Genera un folio único por transacción (todas las piezas de una misma
// venta comparten folio) — antes cada línea del carrito se guardaba suelta
// y no había forma de saber cuántos TICKETS reales se cobraron en el día,
// solo cuántas líneas de producto. Con el folio, el corte de caja cuenta
// tickets de verdad, y el correo/ticket impreso quedan con un número de
// referencia rastreable.
function generarFolio(prefijo) {
    return `${prefijo}-${Date.now().toString(36).toUpperCase()}`;
}

// --- WHATSAPP AUTOMÁTICO A LA SUPERVISORA (Meta WhatsApp Cloud API) ---
// Se usa la API oficial de Meta (no un tercero) porque no requiere librería
// adicional: basta con hacer un POST a graph.facebook.com con fetch, que ya
// viene incluido en Node 18+. Variables de entorno necesarias en Render:
//   WHATSAPP_TOKEN      -> token de acceso de tu app de WhatsApp Business
//                          (developers.facebook.com > tu app > WhatsApp > API Setup)
//   WHATSAPP_PHONE_ID   -> "Phone number ID" del número emisor (el de Gedalia)
//   WHATSAPP_SUPERVISOR -> número de la supervisora en formato E.164 sin "+"
//                          (ej. 5215534612076)
// NOTA IMPORTANTE sobre la "ventana de 24 horas": Meta solo permite mensajes
// de texto libres si la supervisora le escribió al número del negocio en las
// últimas 24h. Para que esto funcione siempre, pídele a la supervisora que
// le mande un "Hola" una vez al número de WhatsApp Business de Gedalia (deja
// la ventana abierta indefinidamente mientras seguido conteste), o crea una
// plantilla aprobada en Meta y cámbiala aquí por type:"template" si prefieres
// no depender de eso.
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_SUPERVISOR = process.env.WHATSAPP_SUPERVISOR;

async function enviarWhatsAppVenta(origen, folio, detalles, total, metodoPago, vendedor) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !WHATSAPP_SUPERVISOR) {
        console.warn('📲 WhatsApp no configurado (faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID / WHATSAPP_SUPERVISOR). Se omite notificación.');
        return;
    }

    const totalPiezas = detalles.reduce((acc, i) => acc + parseInt(i.cantidad || 1), 0);
    const listaArticulos = detalles
        .map(i => `• ${i.cantidad}x ${i.nombre} (${i.codigo})${i.talla ? ` — Talla ${i.talla}` : ''} — $${parseFloat(i.precio).toFixed(2)}`)
        .join('\n');

    const texto =
        `💎 *Nueva venta — Gedalia*\n\n` +
        `📍 Origen: ${origen}\n` +
        `🧾 Folio: ${folio}\n` +
        `👤 Vendedora: ${vendedor || 'No especificada'}\n` +
        `💳 Pago: ${metodoPago}\n` +
        `📦 Piezas: ${totalPiezas}\n\n` +
        `${listaArticulos}\n\n` +
        `*Total: $${parseFloat(total).toFixed(2)} MXN*\n` +
        `🕒 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`;

    try {
        const resp = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: WHATSAPP_SUPERVISOR,
                type: 'text',
                text: { body: texto, preview_url: false }
            })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            console.error('⚠️ WhatsApp rechazó el mensaje (revisa ventana de 24h o el token):', JSON.stringify(data));
        } else {
            console.log(`📲 WhatsApp de venta enviado a la supervisora (${origen} — ${folio}).`);
        }
    } catch (error) {
        console.error('⚠️ Error de red enviando WhatsApp:', error.message);
    }
}

// --- CORREO INTERNO AL ÁREA DE VENTAS (automático en cada venta) ---
// Incluye todo lo que el área de ventas necesita para reconciliar sin abrir
// el ERP: folio, piezas totales, costo/precio/ganancia por artículo, stock
// restante de cada pieza vendida, y el total cobrado.
async function enviarCorreoVentas(origen, folio, detalles, total, metodoPago) {
    if (!process.env.EMAIL_USER) return console.warn("No hay credenciales de correo configuradas.");

    const totalPiezas = detalles.reduce((acc, i) => acc + parseInt(i.cantidad || 1), 0);
    const gananciaBrutaTotal = detalles.reduce((acc, i) => {
        const costo = parseFloat(i.costo || 0);
        const precio = parseFloat(i.precio || 0);
        return acc + (precio - costo) * parseInt(i.cantidad || 1);
    }, 0);

    const mailOptions = {
        from: `"Gedalia ERP" <${process.env.EMAIL_USER}>`,
        to: destinatariosVentas(),
        subject: `💰 Venta ${origen} — Folio ${folio} — $${parseFloat(total).toFixed(2)} MXN`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 640px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                <h2 style="color: #c5a059; text-align: center; margin-top:0;">Nueva Venta Confirmada</h2>
                <p><strong>Folio:</strong> ${folio}</p>
                <p><strong>Origen:</strong> ${origen}</p>
                <p><strong>Fecha y Hora:</strong> ${new Date().toLocaleString('es-MX', {timeZone: 'America/Mexico_City'})}</p>
                <p><strong>Método de Pago:</strong> ${metodoPago}</p>
                <p><strong>Piezas vendidas en este ticket:</strong> ${totalPiezas}</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <h3 style="margin-top: 0;">Detalle por artículo:</h3>
                <table style="width:100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                        <tr style="background:#fafafa; text-align:left;">
                            <th style="padding:8px; border-bottom:1px solid #eee;">SKU</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Artículo</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Talla</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Cant.</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Costo Unit.</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Venta Unit.</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Ganancia</th>
                            <th style="padding:8px; border-bottom:1px solid #eee;">Stock Restante</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${detalles.map(i => {
                            const costo = parseFloat(i.costo || 0);
                            const precio = parseFloat(i.precio || 0);
                            const cant = parseInt(i.cantidad || 1);
                            const ganancia = (precio - costo) * cant;
                            return `
                            <tr>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;"><b>${i.codigo}</b></td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;">${i.nombre}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;">${i.talla || '—'}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;">${cant}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4; color:#d9534f;">$${costo.toFixed(2)}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;">$${precio.toFixed(2)}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4; color:#28a745; font-weight:bold;">$${ganancia.toFixed(2)}</td>
                                <td style="padding:8px; border-bottom:1px solid #f4f4f4;">${i.stockRestante !== undefined ? i.stockRestante : '—'}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="text-align:right; margin: 4px 0; color:#28a745;"><strong>Ganancia bruta del ticket:</strong> $${gananciaBrutaTotal.toFixed(2)} MXN</p>
                <h2 style="text-align: right; color: #0a0a0a; margin: 4px 0;">Total cobrado: $${parseFloat(total).toFixed(2)} MXN</h2>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✉️ Correo interno de venta enviado (${origen} — ${folio}).`);
    } catch (error) {
        console.error("⚠️ Error al enviar el correo interno de venta:", error);
    }
}

// --- RECIBO AL CLIENTE (opcional, si dejó su correo) ---
// No expone costos ni ganancia — solo lo que le corresponde ver a un
// cliente: qué compró, cuánto pagó, y su folio de referencia.
async function enviarReciboCliente(correoCliente, origen, folio, detalles, total, metodoPago) {
    if (!process.env.EMAIL_USER || !correoCliente) return;

    const mailOptions = {
        from: `"Gedalia 925" <${process.env.EMAIL_USER}>`,
        to: correoCliente,
        subject: `💎 Tu recibo de compra Gedalia — Folio ${folio}`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 25px; border-radius: 10px;">
                <h2 style="color: #c5a059; text-align: center; margin-top:0;">¡Gracias por tu compra!</h2>
                <p style="text-align:center; color:#666;">Gedalia — Joyería Fina de Plata Ley 925</p>
                <p><strong>Folio:</strong> ${folio}</p>
                <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-MX', {timeZone: 'America/Mexico_City'})}</p>
                <p><strong>Método de pago:</strong> ${metodoPago}</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <ul style="list-style: none; padding: 0;">
                    ${detalles.map(i => `
                        <li style="margin-bottom: 10px; background: #f9f9f9; padding: 10px; border-radius: 5px;">
                            <strong>${i.cantidad}x ${i.nombre}</strong> ${i.talla ? `(Talla: ${i.talla})` : ''}<br>
                            <span style="color: #888;">$${parseFloat(i.precio).toFixed(2)} c/u</span>
                        </li>
                    `).join('')}
                </ul>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <h2 style="text-align: right; color: #0a0a0a;">Total: $${parseFloat(total).toFixed(2)} MXN</h2>
                <p style="font-size:12px; color:#999; text-align:center; margin-top:30px;">Garantía de Plata Ley .925 · Conserva este correo como tu comprobante.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✉️ Recibo enviado al cliente (${correoCliente}).`);
    } catch (error) {
        console.error("⚠️ Error al enviar recibo al cliente:", error);
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
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS cliente_email VARCHAR(255);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS folio VARCHAR(60);`,
            `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS vendedor VARCHAR(120);`
        ];
        for (const sql of columnasVentas) {
            try { await pool.query(sql); } catch (e) { console.error('Migración ventas falló para:', sql, e.message); }
        }

        await pool.query(`CREATE TABLE IF NOT EXISTS configuracion (clave VARCHAR(50) PRIMARY KEY, valor TEXT);`);
        console.log('Gedalia ERP Omnicanal - Conectado a Aiven con éxito 💎');
    } catch (error) { console.error('Error BD:', error); }
}
inicializarBD();

// --- AUTENTICACIÓN DE CAJERAS EN EL POS (PIN) ---
// Antes cualquier persona con la URL del POS podía cobrar sin identificarse
// y las ventas no quedaban ligadas a nadie. Ahora cada cajera tiene su
// propio PIN, configurado en la variable de entorno POS_CAJEROS de Render
// como JSON, por ejemplo:  {"1234":"Ana","5678":"Luisa"}
// El nombre validado viaja con cada venta (columna "vendedor") y aparece en
// el correo interno y en el WhatsApp de la supervisora, dando trazabilidad
// real de quién cobró cada ticket.
let CAJEROS = null;
try {
    CAJEROS = process.env.POS_CAJEROS ? JSON.parse(process.env.POS_CAJEROS) : null;
} catch (e) {
    console.error('⚠️ POS_CAJEROS mal formado, debe ser JSON válido. Ej: {"1234":"Ana"}. Usando modo demo.');
}
if (!CAJEROS) {
    CAJEROS = { '0000': 'Vendedora Demo' };
    console.warn('⚠️ POS_CAJEROS no configurado: usando PIN demo "0000". Configura PINs reales en Render antes de operar en producción.');
}

// Bloqueo simple anti fuerza-bruta: 5 intentos fallidos por IP -> 2 minutos
// de bloqueo. No sustituye una autenticación robusta, pero evita que alguien
// pruebe PINs al azar desde el mismo dispositivo indefinidamente.
const intentosLogin = new Map();
function ipBloqueada(ip) {
    const registro = intentosLogin.get(ip);
    return !!(registro && registro.bloqueadoHasta && Date.now() < registro.bloqueadoHasta);
}
function registrarFallo(ip) {
    const registro = intentosLogin.get(ip) || { fallos: 0 };
    registro.fallos++;
    if (registro.fallos >= 5) {
        registro.bloqueadoHasta = Date.now() + 2 * 60 * 1000;
        registro.fallos = 0;
    }
    intentosLogin.set(ip, registro);
}
function registrarExito(ip) { intentosLogin.delete(ip); }

app.post('/api/pos/login', (req, res) => {
    const ip = req.ip;
    if (ipBloqueada(ip)) {
        return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 2 minutos e intenta de nuevo.' });
    }
    const pin = String((req.body && req.body.pin) || '').trim();
    const nombre = CAJEROS[pin];
    if (!nombre) {
        registrarFallo(ip);
        return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    registrarExito(ip);
    res.json({ vendedor: nombre });
});

// --- QUITAR FONDO DE FOTOGRAFÍAS (remove.bg) ---
// Usado por admin.html cuando se capturan fotos con la cámara web 4K: cada
// imagen se manda aquí en base64, remove.bg quita el fondo y lo compone
// sobre un blanco sólido (bg_color=ffffff), listo para catálogo, y
// regresamos el PNG resultante también en base64. La API key nunca se
// expone al navegador. Requiere la variable de entorno REMOVEBG_API_KEY
// (cuenta gratuita disponible en remove.bg/api, con límite mensual de
// imágenes gratis; si se agota, la app permite seguir subiendo la foto
// original sin fondo quitado).
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY;

app.post('/api/imagenes/quitar-fondo', async (req, res) => {
    if (!REMOVEBG_API_KEY) {
        return res.status(503).json({ error: 'Servicio de quitar fondo no configurado (falta REMOVEBG_API_KEY en el servidor).' });
    }
    const imagen = req.body && req.body.imagen;
    if (!imagen || typeof imagen !== 'string' || !imagen.startsWith('data:image')) {
        return res.status(400).json({ error: 'Falta una imagen válida (data URL).' });
    }

    try {
        const base64 = imagen.split(',')[1];
        const formData = new FormData();
        formData.append('image_file_b64', base64);
        formData.append('size', 'auto');
        formData.append('bg_color', 'ffffff'); // fondo blanco sólido, listo para el catálogo

        const resp = await fetch('https://api.remove.bg/v1.0/removebg', {
            method: 'POST',
            headers: { 'X-Api-Key': REMOVEBG_API_KEY },
            body: formData
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            console.error('remove.bg rechazó la imagen:', errText);
            return res.status(502).json({ error: 'No se pudo quitar el fondo de la imagen. Se puede subir la foto original.' });
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const resultado = `data:image/png;base64,${buffer.toString('base64')}`;
        res.json({ imagen: resultado });
    } catch (error) {
        console.error('⚠️ Error quitando fondo:', error.message);
        res.status(500).json({ error: 'Error interno al procesar la imagen.' });
    }
});

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
    const { id, codigo, nombre, precio, talla, clienteEmail } = req.body;
    if (!id) return res.status(400).json({ error: 'Falta el producto.' });

    const folio = generarFolio('WEB');

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
                    `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta, cliente_email, folio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    ['Web', p.codigo, p.nombre, p.talla || '', 1, 'WhatsApp / Acordar', p.costo || 0, precio, clienteEmail || null, folio]
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
        const detallesVenta = [{
            codigo, nombre: nombreFinal, talla: prod.talla || '',
            cantidad: 1, costo: prod.costo || 0, precio, stockRestante: prod.stock
        }];

        enviarCorreoVentas('Página Web (WhatsApp)', folio, detallesVenta, precio, 'Pendiente de cobro');
        if (clienteEmail) enviarReciboCliente(clienteEmail, 'Página Web', folio, detallesVenta, precio, 'Pendiente de cobro');

        res.json({ message: 'Venta web reservada con éxito', folio });
    } catch (err) {
        console.error('Error al procesar venta web:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// VENTA POS (Sucursal Física) - PROTEGIDA CON TRANSACCIÓN SQL + REINTENTO
app.post('/api/pos/vender', async (req, res) => {
    const { carrito, total, metodoPago, clienteEmail, vendedor } = req.body;

    if (!Array.isArray(carrito) || carrito.length === 0) {
        return res.status(400).json({ error: 'El carrito está vacío.' });
    }
    if (!metodoPago) {
        return res.status(400).json({ error: 'Falta el método de pago.' });
    }
    if (!vendedor) {
        return res.status(400).json({ error: 'Sesión de cajera no identificada. Vuelve a iniciar sesión en el POS.' });
    }

    const folio = generarFolio('POS');
    const detallesParaCorreo = []; // se llena con datos reales de BD (costo, stock restante)

    try {
        const resultado = await conReintento(async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN'); // Inicia transacción
                detallesParaCorreo.length = 0; // limpiar si este es un reintento

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
                        `INSERT INTO ventas (origen, codigo, nombre_articulo, talla, cantidad, tipo_pago, costo, precio_venta, cliente_email, folio, vendedor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                        ['POS', prod.codigo, prod.nombre, prod.talla || '', item.cantidad, metodoPago, costoReal, item.precio, clienteEmail || null, folio, vendedor]
                    );

                    detallesParaCorreo.push({
                        codigo: prod.codigo, nombre: prod.nombre, talla: prod.talla || '',
                        cantidad: item.cantidad, costo: costoReal, precio: item.precio,
                        stockRestante: prod.stock
                    });
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
            // El correo y el WhatsApp nunca deben tumbar la venta; ambos están
            // protegidos internamente y corren en paralelo, sin bloquear la
            // respuesta al POS (la cajera no espera a que salgan las notificaciones).
            enviarCorreoVentas('Sucursal POS', folio, detallesParaCorreo, total, metodoPago);
            enviarWhatsAppVenta('Sucursal POS', folio, detallesParaCorreo, total, metodoPago, vendedor);
            if (clienteEmail) enviarReciboCliente(clienteEmail, 'Sucursal POS', folio, detallesParaCorreo, total, metodoPago);
            res.json({ message: 'Venta registrada con éxito', folio });
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
