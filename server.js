const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// 1. CONEXIÓN A BASE DE DATOS
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ GEDALIA Enterprise: Sistema de Datos Activo"))
    .catch(err => console.error("❌ Error DB:", err));

// ==========================================
// 2. MODELOS DE DATOS (ESQUEMAS)
// ==========================================

// Esquema de Productos con Analítica y Promociones
const ProductoSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    categoria: { type: String, enum: ['Anillos', 'Dije', 'Collares', 'Aretes', 'Pulseras'], required: true },
    precioBase: { type: Number, required: true },
    imagenes: [String],
    stock: { type: Boolean, default: true },
    // Campos de Marketing y Analítica
    vistas: { type: Number, default: 0 },
    descuento: { type: Number, default: 0 }, // Porcentaje (0-100)
    envioGratis: { type: Boolean, default: false }
});
const Producto = mongoose.model('Producto', ProductoSchema);

// Esquema de Pedidos / Compras
const PedidoSchema = new mongoose.Schema({
    cliente: String,
    joya: String,
    monto: Number,
    tipo: String, // "Carrito" o "Compra Rápida"
    fecha: { type: Date, default: Date.now }
});
const Pedido = mongoose.model('Pedido', PedidoSchema);

// ==========================================
// 3. CONFIGURACIÓN Y MIDDLEWARES
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); 

const upload = multer({ dest: 'uploads/' });

// Variables de Telegram (Render Environment Variables)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
let buzónEdiciones = {}; // Caché para montajes editados

// ==========================================
// 4. API PARA LA TIENDA (CLIENTE)
// ==========================================

// Servir la página principal
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Obtener catálogo activo
app.get('/api/productos', async (req, res) => {
    try {
        const p = await Producto.find({ stock: true });
        res.json(p);
    } catch (e) { res.status(500).json([]); }
});

// Incrementar contador de vistas (Analítica)
app.post('/api/productos/view/:id', async (req, res) => {
    try {
        await Producto.findByIdAndUpdate(req.params.id, { $inc: { vistas: 1 } });
        res.sendStatus(200);
    } catch (e) { res.sendStatus(500); }
});

// Registrar una compra o carrito
app.post('/api/comprar', async (req, res) => {
    try {
        const pedido = await Pedido.create(req.body);
        res.json({ success: true, pedido });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Envío de Solicitud de Montaje a Telegram (MediaGroup)
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    const { catalogPath, clientName, joyaNombre } = req.body;
    const clientId = Date.now();
    res.json({ success: true, clientId });

    try {
        const responseImg = await axios.get(catalogPath, { responseType: 'arraybuffer' });
        
        const mediaGroup = [
            { 
                type: 'photo', 
                media: 'attach://uPhoto', 
                caption: `👑 **NUEVO PEDIDO GEDALIA**\n\n👤 Cliente: ${clientName}\n💍 Joya: ${joyaNombre}\n🆔 ID Seguimiento: ${clientId}` 
            },
            { type: 'photo', media: 'attach://cPhoto' }
        ];

        const fd = new FormData();
        fd.append('chat_id', CHAT_ID);
        fd.append('media', JSON.stringify(mediaGroup));
        fd.append('uPhoto', fs.createReadStream(req.file.path));
        fd.append('cPhoto', Buffer.from(responseImg.data), { filename: 'catalogo.jpg' });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`, fd, { headers: fd.getHeaders() });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (e) { console.error("Error Telegram:", e.message); }
});

// ==========================================
// 5. API PARA ADMINISTRACIÓN (ESTADÍSTICAS)
// ==========================================

// Obtener estadísticas consolidadas
app.get('/api/admin/stats', async (req, res) => {
    try {
        const masVistos = await Producto.find().sort({ vistas: -1 }).limit(5);
        const ventasRecientes = await Pedido.find().sort({ fecha: -1 }).limit(10);
        res.json({ masVistos, ventasRecientes });
    } catch (e) { res.status(500).json({ error: "Error en stats" }); }
});

// Obtener lista completa para gestión
app.get('/api/admin/productos-todos', async (req, res) => {
    const p = await Producto.find().sort({ _id: -1 });
    res.json(p);
});

// Crear producto con promociones
app.post('/api/admin/productos', async (req, res) => {
    try {
        const nuevo = await Producto.create(req.body);
        res.json(nuevo);
    } catch (e) { res.status(400).send(e); }
});

// Actualizar Stock o Promoción (Descuento/Envío)
app.patch('/api/admin/productos/:id', async (req, res) => {
    const p = await Producto.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(p);
});

// Eliminar producto
app.delete('/api/admin/productos/:id', async (req, res) => {
    await Producto.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// ==========================================
// 6. SISTEMA DE RESPUESTA (WEBHOOK)
// ==========================================

app.post('/telegram-webhook', async (req, res) => {
    const msg = req.body.message;
    if (msg?.reply_to_message && msg?.photo) {
        const match = (msg.reply_to_message.caption || "").match(/ID Seguimiento: (\d+)/);
        if (match) {
            const clientId = match[1];
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            buzónEdiciones[clientId] = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fRes.data.result.file_path}`;
        }
    }
    res.sendStatus(200);
});

app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    res.json({ ready: !!buzónEdiciones[id], url: buzónEdiciones[id] });
});

// ==========================================
// 7. INICIO DE SERVIDOR
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ===========================================
    💎 GEDALIA JEWELRY ERP 2024
    🚀 Puerto: ${PORT}
    📈 Analítica: Activada
    🛒 E-commerce: Listo
    ===========================================
    `);
});
