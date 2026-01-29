const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// 1. Servir archivos estáticos desde la carpeta 'public' (si existe)
app.use(express.static(path.join(__dirname, 'public')));

// 2. Servir archivos estáticos desde la raíz (por si acaso)
app.use(express.static(__dirname));

// 3. RUTA MAESTRA: Si alguien entra a la raíz "/", envíale el index.html explícitamente
app.get('/', (req, res) => {
    // Intentamos buscarlo en public, si no, en la raíz
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');

    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send('❌ Error: No encontré el archivo index.html en ninguna carpeta.');
    }
});
app.use(express.json());

let buzónEdiciones = {}; 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; 
        const clientName = req.body.clientName;
        const clientId = Date.now();

        // --- PASO 1: ENVIAR FOTO DEL CLIENTE ---
        const form1 = new FormData();
        form1.append('chat_id', CHAT_ID);
        form1.append('photo', fs.createReadStream(userFile.path));
        form1.append('caption', `👤 **NUEVO PEDIDO**\nCliente: ${clientName}\n🆔 ID Cliente: ${clientId}`);

        const res1 = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form1, {
            headers: form1.getHeaders()
        });

        const messageId = res1.data.result.message_id;

        // --- PASO 2: ENVIAR FOTO DEL CATÁLOGO (Buffer Robusto) ---
        try {
            // Descargamos la imagen como buffer para máxima compatibilidad
            const responseImg = await axios.get(catalogPath, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(responseImg.data, 'binary');
            
            const form2 = new FormData();
            form2.append('chat_id', CHAT_ID);
            // Especificamos un nombre de archivo .jpg para "engañar" a Telegram si es .avif
            form2.append('photo', imageBuffer, { filename: 'joya.jpg' }); 
            form2.append('caption', `💍 **JOYA SELECCIONADA**\nReferencia: ${catalogPath}`);
            form2.append('reply_to_message_id', messageId);

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form2, {
                headers: form2.getHeaders()
            });
        } catch (errorImg) {
            console.error('Error imagen:', errorImg.message);
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: `⚠️ No se pudo previsualizar la joya. Ver aquí:\n${catalogPath}`,
                reply_to_message_id: messageId
            });
        }

        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);
        res.json({ success: true, clientId: clientId });

    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({ success: false });
    }
});

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

app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    res.json({ ready: !!buzónEdiciones[id], url: buzónEdiciones[id] || null });
});

const PORT = process.env.PORT || 10000; // Render usa el 10000 por defecto
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});



