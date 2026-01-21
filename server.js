const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

let buzónEdiciones = {}; // Memoria temporal para las respuestas

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath;
        const clientName = req.body.clientName;
        const clientId = Date.now();

        const fullCatalogPath = path.join(__dirname, 'public', catalogPath);

        // --- PASO 1: ENVIAR FOTO DEL CLIENTE ---
        const form1 = new FormData();
        form1.append('chat_id', CHAT_ID);
        form1.append('photo', fs.createReadStream(userFile.path));
        form1.append('caption', `👤 **NUEVO PEDIDO**\nCliente: ${clientName}\n🆔 ID Cliente: ${clientId}`);

        const res1 = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form1, {
            headers: form1.getHeaders()
        });

        const messageId = res1.data.result.message_id;

        // --- PASO 2: ENVIAR FOTO DEL CATÁLOGO (Como respuesta a la primera) ---
        if (fs.existsSync(fullCatalogPath)) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Pausa de seguridad
            const form2 = new FormData();
            form2.append('chat_id', CHAT_ID);
            form2.append('photo', fs.createReadStream(fullCatalogPath));
            form2.append('caption', `💍 **REFERENCIA SELECCIONADA**\nJoya: ${path.basename(catalogPath)}`);
            form2.append('reply_to_message_id', messageId);

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form2, {
                headers: form2.getHeaders()
            });
        }

        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);
        res.json({ success: true, clientId: clientId });

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        res.status(500).json({ success: false });
    }
});

// WEBHOOK para recibir tu edición desde Telegram
app.post('/telegram-webhook', async (req, res) => {
    const msg = req.body.message;
    if (msg && msg.reply_to_message && msg.photo) {
        const text = msg.reply_to_message.caption || "";
        const match = text.match(/ID Cliente: (\d+)/);
        
        if (match) {
            const clientId = match[1];
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
            const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
            buzónEdiciones[clientId] = finalUrl;
        }
    }
    res.sendStatus(200);
});

app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    if (buzónEdiciones[id]) {
        res.json({ ready: true, url: buzónEdiciones[id] });
    } else {
        res.json({ ready: false });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor en puerto ${PORT}`));
