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

// Memoria temporal para respuestas del diseñador
let buzónEdiciones = {}; 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; // URL de ImgBB
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

        // --- PASO 2: ENVIAR FOTO DEL CATÁLOGO (Desde URL) ---
        // Descargamos la imagen de ImgBB como un stream para Telegram
        const response = await axios.get(catalogPath, { responseType: 'stream' });
        
        const form2 = new FormData();
        form2.append('chat_id', CHAT_ID);
        form2.append('photo', response.data);
        form2.append('caption', `💍 **JOYA SELECCIONADA**\nEnlace: ${catalogPath}`);
        form2.append('reply_to_message_id', res1.data.result.message_id);

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form2, {
            headers: form2.getHeaders()
        });

        // Limpieza de la foto del cliente
        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);
        
        res.json({ success: true, clientId: clientId });

    } catch (error) {
        console.error('❌ Error en el proceso:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook para recibir la edición desde Telegram
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Joyería corriendo en puerto ${PORT}`));

