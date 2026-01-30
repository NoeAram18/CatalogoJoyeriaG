const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 10000;

// --- CONEXIÓN A BASE DE DATOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Conectado a MongoDB"))
    .catch(err => console.error("❌ Error DB:", err));

// --- MODELOS ---
const Producto = mongoose.model('Producto', new mongoose.Schema({
    nombre: String,
    categoria: String,
    precioBase: Number,
    imagenes: [String], 
    stock: { type: Boolean, default: true }
}));

const Venta = mongoose.model('Venta', new mongoose.Schema({
    cliente: String,
    joya: String,
    fecha: { type: Date, default: Date.now }
}));

// --- MIDDLEWARES ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // Sirve index.html, admin.html, etc.

const upload = multer({ dest: 'uploads/' });

// Variables de Entorno
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
let buzónEdiciones = {};

// 1. Permitir que Express lea archivos en la carpeta raíz
app.use(express.static(__dirname));

// 2. Ruta para la página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 3. Ruta específica para el admin (Añade esto para asegurar el acceso)
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// --- RUTAS PÚBLICAS CATÁLOGO ---
app.get('/api/productos', async (req, res) => {
    try {
        const productos = await Producto.find({ stock: true });
        res.json(productos);
    } catch (err) { 
        res.status(500).json([]); 
    }
});

// --- ENVÍO A TELEGRAM (MediaGroup Agrupado) ---
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    const { catalogPath, clientName, joyaNombre } = req.body;
    const clientId = Date.now();
    
    // Respuesta rápida al cliente
    res.json({ success: true, clientId });

    try {
        // Registrar intento de venta
        await Venta.create({ cliente: clientName, joya: joyaNombre });

        // Descargar imagen del catálogo para el álbum
        const responseImg = await axios.get(catalogPath, { responseType: 'arraybuffer' });
        
        const mediaGroup = [
            { 
                type: 'photo', 
                media: 'attach://uPhoto', 
                caption: `👤 **PEDIDO LUXURY**\nCliente: ${clientName}\n💍 Joya: ${joyaNombre}\n🆔 ID: ${clientId}\n\nResponde a este mensaje con la edición para enviársela al cliente.` 
            },
            { 
                type: 'photo', 
                media: 'attach://cPhoto' 
            }
        ];

        const fd = new FormData();
        fd.append('chat_id', CHAT_ID);
        fd.append('media', JSON.stringify(mediaGroup));
        fd.append('uPhoto', fs.createReadStream(req.file.path));
        fd.append('cPhoto', Buffer.from(responseImg.data), { filename: 'joya_catalogo.jpg' });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMediaGroup`, fd, { 
            headers: fd.getHeaders() 
        });

        // Borrar archivo temporal
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    } catch (e) { 
        console.error("Error envío Telegram:", e.message); 
    }
});

// --- RUTAS ADMINISTRADOR (Protegidas) ---
const auth = (req, res, next) => {
    if (req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).send("No autorizado");
    }
};

app.post('/api/admin/productos', auth, async (req, res) => {
    try {
        const p = await Producto.create(req.body);
        res.json(p);
    } catch (err) {
        res.status(500).send(err);
    }
});

app.patch('/api/admin/productos/:id', auth, async (req, res) => {
    try {
        const p = await Producto.findByIdAndUpdate(req.params.id, { stock: req.body.stock }, { new: true });
        res.json(p);
    } catch (err) {
        res.status(500).send(err);
    }
});

app.get('/api/admin/ventas', auth, async (req, res) => {
    try {
        const v = await Venta.find().sort({ fecha: -1 });
        res.json(v);
    } catch (err) {
        res.status(500).send(err);
    }
});

// --- WEBHOOK PARA RECIBIR EDICIÓN DESDE TELEGRAM ---
app.post('/telegram-webhook', async (req, res) => {
    const msg = req.body.message;
    if (msg?.reply_to_message && msg?.photo) {
        // Extraer ID del pie de foto (caption) del mensaje original
        const match = (msg.reply_to_message.caption || "").match(/ID: (\d+)/);
        if (match) {
            const clientId = match[1];
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            
            // Obtener link de la foto editada
            const fRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            const filePath = fRes.data.result.file_path;
            
            buzónEdiciones[clientId] = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
        }
    }
    res.sendStatus(200);
});

// El cliente consulta si su edición ya está lista
app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    if (buzónEdiciones[id]) {
        res.json({ ready: true, url: buzónEdiciones[id] });
    } else {
        res.json({ ready: false });
    }
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Luxury corriendo en puerto ${PORT}`);
});


