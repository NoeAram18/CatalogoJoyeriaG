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

let buzónEdiciones = {}; 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; // URL de ImgBB
        const clientName = req.body.clientName;
        const clientId = Date.now();

        // --- PASO 1: ENVIAR FOTO DEL CLIENTE (Archivo local) ---
        const form1 = new FormData();
        form1.append('chat_id', CHAT_ID);
        form1.append('photo', fs.createReadStream(userFile.path));
        form1.append('caption', `👤 **NUEVO PEDIDO**\nCliente: ${clientName}\n🆔 ID Cliente: ${clientId}`);

        const res1 = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form1, {
            headers: form1.getHeaders()
        });

        const messageId = res1.data.result.message_id;

        // --- PASO 2: ENVIAR FOTO DEL CATÁLOGO (Descargando el buffer) ---
        // Esto asegura que Telegram reciba la imagen sí o sí, sin depender del link externo
        try {
            const responseImg = await axios.get(catalogPath, { responseType: 'stream' });
            
            const form2 = new FormData();
            form2.append('chat_id', CHAT_ID);
            form2.append('photo', responseImg.data); // Enviamos el stream de la imagen
            form2.append('caption', `💍 **JOYA SELECCIONADA**\nReferencia: ${catalogPath}`);
            form2.append('reply_to_message_id', messageId);

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form2, {
                headers: form2.getHeaders()
            });
        } catch (errorImg) {
            console.error('Error al procesar la imagen de ImgBB:', errorImg.message);
            // Fallback: Si falla el envío como foto, enviamos el link para no perder el pedido
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: `⚠️ No se pudo previsualizar la joya. Ver aquí:\n${catalogPath}`,
                reply_to_message_id: messageId
            });
        }

        // Limpiar archivo temporal
        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);
        
        res.json({ success: true, clientId: clientId });

    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({ success: false });
    }
});

// WEBHOOK: RECIBIR RESPUESTA DEL DISEÑADOR
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

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Profesional Corriendo`));
