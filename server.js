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

// Memoria temporal para guardar las ediciones enviadas desde Telegram
let buzónEdiciones = {}; 

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// --- 1. RECIBIR PEDIDO DE LA WEB Y ENVIAR A TELEGRAM ---
app.post('/send-to-telegram', upload.single('userImage'), async (req, res) => {
    try {
        const userFile = req.file;
        const catalogPath = req.body.catalogPath; // URL de ImgBB
        const clientName = req.body.clientName;
        const clientId = Date.now();

        // PASO A: Enviar foto del cliente (Subida desde el formulario)
        const form1 = new FormData();
        form1.append('chat_id', CHAT_ID);
        form1.append('photo', fs.createReadStream(userFile.path));
        form1.append('caption', `👤 **NUEVO PEDIDO**\nCliente: ${clientName}\n🆔 ID Cliente: ${clientId}`);

        const res1 = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, form1, {
            headers: form1.getHeaders()
        });

        const messageId = res1.data.result.message_id;

        // PASO B: Enviar foto de la joya (Usando URL directa de ImgBB)
        // Usamos JSON en lugar de FormData para que Telegram descargue la URL directamente
        try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
                chat_id: CHAT_ID,
                photo: catalogPath,
                caption: `💍 **JOYA SELECCIONADA**\nRef: ${catalogPath}`,
                reply_to_message_id: messageId
            });
        } catch (imgError) {
            console.error('Error con la imagen de ImgBB:', imgError.message);
            // Si la imagen falla, enviamos al menos el link por texto para no perder la venta
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: `⚠️ No se pudo cargar la imagen del catálogo automáticamente.\n🔗 Link de la pieza: ${catalogPath}`,
                reply_to_message_id: messageId
            });
        }

        // Limpiar archivo temporal del cliente
        if (fs.existsSync(userFile.path)) fs.unlinkSync(userFile.path);
        
        res.json({ success: true, clientId: clientId });

    } catch (error) {
        console.error('❌ Error general:', error.message);
        res.status(500).json({ success: false });
    }
});

// --- 2. WEBHOOK: RECIBIR TU EDICIÓN DESDE TELEGRAM ---
app.post('/telegram-webhook', async (req, res) => {
    try {
        const msg = req.body.message;
        
        // Verificamos que sea una respuesta con foto
        if (msg && msg.reply_to_message && msg.photo) {
            const captionOriginal = msg.reply_to_message.caption || "";
            const match = captionOriginal.match(/ID Cliente: (\d+)/);
            
            if (match) {
                const clientId = match[1];
                // Tomamos la versión de mejor calidad de la foto enviada
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                
                // Obtener URL de descarga desde Telegram
                const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
                const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;
                
                // Guardamos en el buzón para el cliente
                buzónEdiciones[clientId] = finalUrl;
            }
        }
    } catch (e) {
        console.error("Error procesando Webhook:", e.message);
    }
    res.sendStatus(200);
});

// --- 3. CONSULTA DEL CLIENTE (POLLING) ---
app.get('/check-edition/:clientId', (req, res) => {
    const id = req.params.clientId;
    if (buzónEdiciones[id]) {
        res.json({ ready: true, url: buzónEdiciones[id] });
        // Opcional: delete buzónEdiciones[id]; (si quieres borrarlo tras la entrega)
    } else {
        res.json({ ready: false });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Profesional de Joyería listo en puerto ${PORT}`);
});
