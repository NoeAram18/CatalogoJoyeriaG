const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
// PORT único para Render o local
const PORT = process.env.PORT || 10000; 

// Configuración de rutas estáticas (Maneja si está en /public o en la raíz)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.use(express.json());
const upload = multer({ dest: 'uploads/' });

let buzónEdiciones = {}; 

// Variables de entorno de Render
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// --- RUTA PRINCIPAL ---
app.get('/', (req, res) => {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(publicPath)) return res.sendFile(publicPath);
    if (fs.existsSync(rootPath)) return res.sendFile(rootPath);
    res.status(404).send('❌ Error: No encontré el archivo index.html');
});

// --- ENVÍO DE PEDIDO ---
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; 
        const clientName = req.body.clientName;
        const clientId = Date.now();

        if (!userFile) return res.status(400).json({ success: false, error: 'Falta imagen' });

        // PASO 1: ENVIAR FOTO DEL CLIENTE (Lo más importante)
        const form1 = new FormData();
        form1.append('chat_id', CHAT_ID);
        form1.append('photo', fs.createReadStream(userFile.path));
        form1.append('caption', `👤 **NUEVO PEDIDO**\nCliente: ${clientName}\n🆔 ID Cliente: ${clientId}`);

        const res1 = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form1, {
            headers: form1.getHeaders()
        });

        const messageId = res1.data.result.message_id;

        // PASO 2: RESPONDER A LA WEB (Para que no se quede "Procesando")
        res.json({ success: true, clientId: clientId });

        // PASO 3: ENVIAR FOTO DEL CATÁLOGO (En segundo plano)
        try {
            // Descarga con timeout para no bloquear el proceso
            const responseImg = await axios.get(catalogPath, { responseType: 'arraybuffer', timeout: 8000 });
            const imageBuffer = Buffer.from(responseImg.data, 'binary');
            
            const form2 = new FormData();
            form2.append('chat_id', CHAT_ID);
            // Forzamos extensión jpg para mejorar compatibilidad con .avif
            form2.append('photo', imageBuffer, { filename: 'pieza.jpg', contentType: 'image/jpeg' }); 
            form2.append('caption', `💍 **PIEZA SELECCIONADA**\nReferencia: ${catalogPath}`);
            form2.append('reply_to_message_id', messageId);

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form2, {
                headers: form2.getHeaders()
            });
        } catch (errorImg) {
            console.error('Error enviando joya:', errorImg.message);
            // Fallback si la imagen falla
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: `⚠️ No se pudo previsualizar la joya.\n🔗 Link: ${catalogPath}`,
                reply_to_message_id: messageId
            });
        }

        // Limpiar archivo temporal
        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);

    } catch (error) {
        console.error('❌ Error general:', error.message);
        if (!res.headersSent) res.status(500).json({ success: false });
    }
});

// --- WEBHOOK: RECIBIR EDICIÓN ---
app.post('/telegram-webhook', async (req, res) => {
    const msg = req.body.message;
    if (msg && msg.reply_to_message && msg.photo) {
        const text = msg.reply_to_message.caption || "";
        const match = text.match(/ID Cliente: (\d+)/);
        if (match) {
            const clientId = match[1];
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            buzónEdiciones[clientId] = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
        }
    }
    res.sendStatus(200);
});

// --- CONSULTA DEL CLIENTE ---
app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    res.json({ ready: !!buzónEdiciones[id], url: buzónEdiciones[id] || null });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Boutique listo en puerto ${PORT}`);
});
